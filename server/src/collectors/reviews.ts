import { db, stateGet, stateSet } from '../db.ts'
import { webFetch } from '../net.ts'
import { brandKey, brandName, matchCasinoMeta } from '../casinometa.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Third-party trust signal — casino.guru "Safety Index" (0–10) per casino.
//
// Trustpilot and AskGamblers sit behind Cloudflare and 403 keyless clients, but
// casino.guru serves a public review page per casino with a JSON-LD Review
// block carrying the expert Safety Index. We scrape that one authoritative
// number per watched casino brand and store it — an independent reputation
// signal to blend alongside our on-chain trust + community votes (this is the
// external-review credibility layer; circus carries an equivalent wagerx_score).
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REFRESH_DAYS = 3

const upsert = db.prepare(`
  INSERT INTO reviews(brand_key, source, score, score_max, url, updated_at)
  VALUES(@brand_key, @source, @score, @score_max, @url, @updated_at)
  ON CONFLICT(brand_key, source) DO UPDATE SET score=excluded.score, score_max=excluded.score_max, url=excluded.url, updated_at=excluded.updated_at
`)

// ── Trustpilot rating via the Wayback Machine (the live site is Cloudflare-walled) ──
async function fetchTrustpilot(domain: string): Promise<number | null> {
  try {
    const cdx = await webFetch(
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent('trustpilot.com/review/' + domain)}&output=json&limit=-2&filter=statuscode:200`,
      { signal: AbortSignal.timeout(20_000) },
    )
    if (!cdx.ok) return null
    const rows = (await cdx.json()) as string[][]
    if (!Array.isArray(rows) || rows.length < 2) return null
    const ts = rows[rows.length - 1][1]
    const page = await webFetch(`https://web.archive.org/web/${ts}/https://www.trustpilot.com/review/${domain}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25_000),
    })
    if (!page.ok) return null
    const html = await page.text()
    const m = html.match(/"ratingValue"\s*:\s*"?([\d.]+)/)
    const v = m ? Number(m[1]) : null
    return v && v > 0 && v <= 5 ? v : null
  } catch {
    return null
  }
}

function domainOf(brand: string): string | null {
  const meta = matchCasinoMeta(brand)
  if (!meta?.website) return null
  try {
    return new URL(meta.website).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// brand name → candidate casino.guru slugs ("BC.Game" → bc-game / bcgame)
function slugCandidates(name: string): string[] {
  const base = name.toLowerCase().trim()
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const plain = base.replace(/[^a-z0-9]+/g, '')
  return [...new Set([hyphen, plain])].filter(Boolean)
}

function parseSafetyIndex(t: string): { score: number; reviewed: string } | null {
  for (const m of t.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1])
      if (j['@type'] === 'Review' && j.reviewRating?.ratingValue) {
        // capture which casino the page actually reviews, to guard against
        // a guessed slug resolving to a DIFFERENT casino's page
        const reviewed = String(j.itemReviewed?.name ?? j.name ?? '')
        return { score: Number(j.reviewRating.ratingValue), reviewed }
      }
    } catch {
      /* skip */
    }
  }
  const fb = t.match(/"@type"\s*:\s*"Review"[\s\S]{0,400}?"ratingValue"\s*:\s*"?([\d.]+)/)
  if (fb) {
    const reviewed = t.match(/<title>([^<]*)<\/title>/i)?.[1] ?? ''
    return { score: Number(fb[1]), reviewed }
  }
  return null
}

async function fetchSafetyIndex(slug: string): Promise<{ score: number; reviewed: string } | null> {
  // casino.guru 403s datacenter IPs (Cloudflare), but the rotating proxy pool in
  // net.ts bypasses that (verified HTTP 200 through the pool). Two things make the
  // production fetch flaky where a local curl is instant: (1) the page is ~600KB,
  // and reading that many socket chunks competes with the heavy synchronous DB
  // backfill on the single Node loop — so we ask for GZIP (undici auto-decodes the
  // body, but ~600KB → ~80KB on the wire = far fewer reads through the busy loop);
  // (2) a given random proxy may be slow/dead — so on a timeout/transient HTTP
  // error we RETRY, and since webFetch picks a fresh random agent each call the
  // retry rolls onto a different proxy. A 404 (wrong slug) is a real miss → null.
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await webFetch(`https://casino.guru/${slug}-casino-review`, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 404) return null
      if (res.status !== 200) throw new Error(`casino.guru HTTP ${res.status}`)
      return parseSafetyIndex(await res.text()) // 200 with no rating block → genuine null
    } catch (e) {
      lastErr = e as Error
      await new Promise((r) => setTimeout(r, 500)) // brief pause, then a fresh proxy
    }
  }
  throw lastErr ?? new Error('casino.guru fetch failed')
}

let queue: { key: string; name: string }[] = []
let cursor = 0
function refillQueue() {
  // prioritise casinos that actually have indexed flow (real, current brands)
  // over the legacy dead-dApp labels, so the valuable Safety Indexes land first
  const labels = db
    .prepare(
      `SELECT w.label, COALESCE(SUM(t.usd), 0) vol
       FROM watchlist w LEFT JOIN transfers t ON t.watch_id = w.id
       WHERE w.category='casino' AND w.active=1
       GROUP BY w.label ORDER BY vol DESC`,
    )
    .all() as { label: string; vol: number }[]
  const seen = new Set<string>()
  queue = []
  for (const { label } of labels) {
    const key = brandKey(label)
    if (seen.has(key)) continue
    seen.add(key)
    queue.push({ key, name: brandName(label) })
  }
  cursor = 0
}

export async function runReviewsOnce() {
  if (cursor >= queue.length) refillQueue()
  if (queue.length === 0) return
  const { key, name } = queue[cursor++]
  const fresh = (src: string) => {
    const row = db.prepare('SELECT updated_at FROM reviews WHERE brand_key=? AND source=?').get(key, src) as any
    return row && Date.now() - row.updated_at < REFRESH_DAYS * 86_400_000
  }

  // 1) casino.guru Safety Index (skip if recently fetched)
  if (!fresh('casino.guru')) {
    let guru = 0
    let fetchOk = true // false on a transient fetch error → don't cache a miss, retry next cycle
    const bk = brandKey(name)
    try {
    for (const slug of slugCandidates(name)) {
      const r = await fetchSafetyIndex(slug)
      if (r != null && r.score > 0) {
        // guard against slug collisions: the casino the page reviews must match
        // the brand we asked for, or we'd attribute another casino's score.
        // (accept when the name can't be extracted — best-effort, slug-derived)
        const reviewedKey = r.reviewed.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (r.reviewed && bk && !reviewedKey.includes(bk) && !bk.includes(reviewedKey)) {
          console.warn(`[reviews] ${name}: casino.guru page reviews "${r.reviewed}" (slug ${slug}) — brand mismatch, skipping`)
          await new Promise((res) => setTimeout(res, 600))
          continue
        }
        guru = r.score
        upsert.run({ brand_key: key, source: 'casino.guru', score: r.score, score_max: 10, url: `https://casino.guru/${slug}-casino-review`, updated_at: Date.now() })
        console.log(`[reviews] ${name}: casino.guru Safety Index ${r.score}/10`)
        break
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    } catch (e) {
      fetchOk = false // transient network/HTTP error — leave it unmarked so it retries
      console.warn(`[reviews] ${name}: casino.guru fetch error (${(e as Error).message}), will retry`)
    }
    // only cache a genuine "no rating found" miss; a transient error retries next cycle
    if (fetchOk && !guru) upsert.run({ brand_key: key, source: 'casino.guru', score: 0, score_max: 10, url: null, updated_at: Date.now() })
  }

  // 2) Trustpilot rating via Wayback (independent freshness — needs the domain)
  if (!fresh('trustpilot')) {
    const domain = domainOf(name)
    if (domain) {
      const tp = await fetchTrustpilot(domain)
      if (tp != null) {
        upsert.run({ brand_key: key, source: 'trustpilot', score: tp, score_max: 5, url: `https://www.trustpilot.com/review/${domain}`, updated_at: Date.now() })
        console.log(`[reviews] ${name}: Trustpilot ★${tp}/5 (archived)`)
      } else {
        upsert.run({ brand_key: key, source: 'trustpilot', score: 0, score_max: 5, url: null, updated_at: Date.now() })
      }
    }
  }
}

// brand_key → all third-party review scores (casino.guru Safety Index 0–10 +
// Trustpilot ★/5), for aggregation. Tiny table, built fresh each call.
export interface ReviewScore {
  safety: number | null // casino.guru 0–10
  trustpilot: number | null // ★/5
}
export function reviewScores(): Map<string, ReviewScore> {
  const out = new Map<string, ReviewScore>()
  const rows = db.prepare("SELECT brand_key, source, score FROM reviews WHERE score>0").all() as { brand_key: string; source: string; score: number }[]
  for (const r of rows) {
    const e = out.get(r.brand_key) ?? { safety: null, trustpilot: null }
    if (r.source === 'casino.guru') e.safety = r.score
    else if (r.source === 'trustpilot') e.trustpilot = r.score
    out.set(r.brand_key, e)
  }
  return out
}

export function startReviews() {
  console.log('[reviews] casino.guru Safety Index collector active')
  // one-time: drop previously-cached "no review" misses — many were transient
  // fetch failures wrongly cached as 0 (and then skipped for days). Clearing them
  // lets the now retry-safe fetcher re-populate real Safety Indexes.
  try {
    if (!stateGet('reviews:clearmisses:v2')) {
      const n = db.prepare('DELETE FROM reviews WHERE score = 0').run().changes
      stateSet('reviews:clearmisses:v2', 1)
      if (n) console.log(`[reviews] cleared ${n} stale 0-score entries to re-fetch`)
    }
  } catch {
    /* non-fatal */
  }
  const loop = async () => {
    await runReviewsOnce().catch((e) => console.warn('[reviews]', (e as Error).message))
    setTimeout(loop, 12_000) // one casino per 12s — gentle
  }
  setTimeout(loop, 40_000)
}
