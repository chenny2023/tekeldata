import { db, stateGet, stateSet } from '../db.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Trustpilot "casino" category sweep. The category listing pages each carry ~20
// businesses with their TrustScore + review count, embedded in the Next.js
// __NEXT_DATA__ JSON. We page through them SLOWLY (one page per minute, through
// the residential proxy net.ts routes trustpilot.com to) to avoid tripping the
// block, merging two things onto the directory: (1) new casinos we didn't know,
// (2) a Trustpilot consumer rating + review count on every casino we already have.
// At the end of the category it re-sweeps from page 1 so ratings stay fresh.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CAT = 'https://www.trustpilot.com/categories/casino'
const PAGE_KEY = 'trustpilot:cat:page'
const MAX_PAGE = 120 // hard stop — the casino category is large but finite

function domainOf(d: string): string | null {
  const h = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null
}

interface TpBiz {
  domain: string
  name: string
  rating: number | null
  reviews: number | null
}

// Trustpilot's JSON shape shifts between releases, so instead of hard-coding a
// path we walk the parsed __NEXT_DATA__ and collect every object that looks like
// a business unit: an identifyingName (the domain) plus a display name. Score and
// review count are read defensively (number, or nested {total}).
function num(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object' && typeof v.total === 'number') return v.total
  return null
}
function collectBusinesses(root: any): TpBiz[] {
  const out = new Map<string, TpBiz>()
  const stack = [root]
  let guard = 0
  while (stack.length && guard++ < 200_000) {
    const n = stack.pop()
    if (!n || typeof n !== 'object') continue
    if (Array.isArray(n)) {
      for (const x of n) stack.push(x)
      continue
    }
    const idName = n.identifyingName ?? n.domain
    const disp = n.displayName ?? n.name
    if (typeof idName === 'string' && typeof disp === 'string') {
      const domain = domainOf(idName)
      if (domain && !out.has(domain)) {
        const rating = num(n.trustScore) ?? num(n.stars) ?? num(n.score)
        const reviews = num(n.numberOfReviews) ?? num(n.reviewsCount) ?? num(n.numberOfReviewsTotal)
        out.set(domain, { domain, name: disp.trim() || domain, rating, reviews })
      }
    }
    for (const k in n) stack.push(n[k])
  }
  return [...out.values()]
}

function parsePage(html: string): TpBiz[] {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return []
  try {
    return collectBusinesses(JSON.parse(m[1]))
  } catch {
    return []
  }
}

const upsert = db.prepare(`
  INSERT INTO casino_directory(domain, name, website, source, tp_rating, tp_reviews, created_at)
  VALUES(@domain, @name, @website, 'trustpilot', @rating, @reviews, @now)
  ON CONFLICT(domain) DO UPDATE SET
    tp_rating = COALESCE(excluded.tp_rating, casino_directory.tp_rating),
    tp_reviews = COALESCE(excluded.tp_reviews, casino_directory.tp_reviews)
`)

async function sweepOne(): Promise<void> {
  const page = Number(stateGet(PAGE_KEY) ?? '1') || 1
  const url = page === 1 ? CAT : `${CAT}?page=${page}`
  let html = ''
  try {
    const res = await webFetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(30_000) })
    if (res.status !== 200) {
      console.warn(`[trustpilot-cat] page ${page}: HTTP ${res.status} (retry later)`)
      return // leave the cursor; a later tick retries on a fresh residential session
    }
    html = await res.text()
  } catch (e) {
    console.warn(`[trustpilot-cat] page ${page}: ${(e as Error).message.slice(0, 40)} (retry later)`)
    return
  }

  const biz = parsePage(html)
  if (biz.length === 0 || page >= MAX_PAGE) {
    // end of category (or cap) — re-sweep from the top later so ratings stay fresh
    console.log(`[trustpilot-cat] sweep complete at page ${page} — restarting from page 1`)
    stateSet(PAGE_KEY, 1)
    return
  }

  const now = Date.now()
  let rated = 0
  const tx = db.transaction(() => {
    for (const b of biz) {
      upsert.run({ domain: b.domain, name: b.name, website: 'https://' + b.domain, rating: b.rating, reviews: b.reviews, now })
      if (b.rating != null) rated++
    }
  })
  tx()
  stateSet(PAGE_KEY, page + 1)
  console.log(`[trustpilot-cat] page ${page}: ${biz.length} casinos (${rated} rated) merged`)
}

export function startTrustpilotCategory() {
  if ((process.env.TRUSTPILOT_CAT ?? '1') === '0') return
  console.log('[trustpilot-cat] casino-category sweep active')
  const loop = async () => {
    await sweepOne().catch((e) => console.warn('[trustpilot-cat]', (e as Error).message))
    setTimeout(loop, 60_000) // one page per minute — deliberately slow to stay under the block
  }
  setTimeout(loop, 150_000) // start well after boot, behind the other collectors
}
