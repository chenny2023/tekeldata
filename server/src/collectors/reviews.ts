import { db, stateGet, stateSet } from '../db.ts'
import { webFetch } from '../net.ts'
import { unlockedFetch } from './unlocker.ts'
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
// Review scores move on a scale of weeks, not days. The paid-unlocker sources
// (Trustpilot, AskGamblers) each cost ~30 ScraperAPI credits per fetch, so a tight
// re-fetch interval is what exhausts the monthly quota — refresh them rarely. The
// free sources (casino.guru / casino.org, fetched through the residential proxy
// pool, no credit cost) can refresh more often. Env-overridable.
const REFRESH_DAYS_PAID = Number(process.env.REVIEWS_REFRESH_DAYS_PAID ?? 30) // trustpilot, askgamblers (ScraperAPI credits)
const REFRESH_DAYS_FREE = Number(process.env.REVIEWS_REFRESH_DAYS_FREE ?? 7) // casino.guru, casino.org (free proxy)
const PAID_SOURCES = new Set(['trustpilot', 'askgamblers'])

const upsert = db.prepare(`
  INSERT INTO reviews(brand_key, source, score, score_max, url, updated_at)
  VALUES(@brand_key, @source, @score, @score_max, @url, @updated_at)
  ON CONFLICT(brand_key, source) DO UPDATE SET score=excluded.score, score_max=excluded.score_max, url=excluded.url, updated_at=excluded.updated_at
`)

function parseTrustpilotRating(html: string): number | null {
  // Trustpilot embeds an AggregateRating in JSON-LD; fall back to a raw ratingValue
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1])
      const nodes = Array.isArray(j) ? j : (j['@graph'] ?? [j])
      for (const n of nodes) {
        const rv = n?.aggregateRating?.ratingValue ?? (n?.['@type'] === 'AggregateRating' ? n.ratingValue : null)
        if (rv != null) {
          const v = Number(rv)
          if (v > 0 && v <= 5) return v
        }
      }
    } catch {
      /* skip */
    }
  }
  const m = html.match(/"ratingValue"\s*:\s*"?([\d.]+)/)
  const v = m ? Number(m[1]) : null
  return v && v > 0 && v <= 5 ? v : null
}

// ── Trustpilot rating ─────────────────────────────────────────────────────────
// The live site is Cloudflare-walled, but the proxy pool (net.ts routes
// trustpilot.com through it) gets past that — so read the CURRENT rating from the
// live page first. Only if the live fetch is blocked/empty do we fall back to the
// Wayback archive (reachable but a possibly-months-old snapshot).
async function fetchTrustpilotLive(domain: string): Promise<number | null> {
  try {
    const res = await webFetch(`https://www.trustpilot.com/review/${domain}`, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status !== 200) return null
    return parseTrustpilotRating(await res.text())
  } catch {
    return null
  }
}

async function fetchTrustpilotWayback(domain: string): Promise<number | null> {
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
    return parseTrustpilotRating(await page.text())
  } catch {
    return null
  }
}

// returns the rating + which path produced it (live residential vs stale archive)
async function fetchTrustpilot(domain: string): Promise<{ rating: number; src: 'live' | 'wayback' } | null> {
  const live = await fetchTrustpilotLive(domain)
  if (live != null) return { rating: live, src: 'live' }
  const wb = await fetchTrustpilotWayback(domain)
  return wb != null ? { rating: wb, src: 'wayback' } : null
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

// casino.guru renders the number and its label in separate elements, so to read
// "6 complaints about this casino" / "76 user reviews" robustly we strip tags in
// the ~150 chars before the phrase and take the last number there.
function numberBefore(html: string, phrase: string): number | null {
  const i = html.indexOf(phrase)
  if (i < 0) return null
  const nums = html.slice(Math.max(0, i - 150), i).replace(/<[^>]+>/g, ' ').match(/[\d][\d,]*/g)
  if (!nums) return null
  const n = Number(nums[nums.length - 1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
// some stats render the number AFTER the label (a table cell), so check both sides
function numberAfter(html: string, phrase: string): number | null {
  const i = html.indexOf(phrase)
  if (i < 0) return null
  const nums = html.slice(i + phrase.length, i + phrase.length + 120).replace(/<[^>]+>/g, ' ').match(/[\d][\d,]*/g)
  if (!nums) return null
  const n = Number(nums[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
const numberNear = (html: string, phrase: string): number | null => numberBefore(html, phrase) ?? numberAfter(html, phrase)

export interface GuruTrust {
  score: number
  reviewed: string
  complaints: number | null // current complaints about this casino
  unresolved: number | null // unresolved complaints — the actionable red flag
  userReviews: number | null // community-review count (credibility weight)
}

async function fetchSafetyIndex(slug: string): Promise<GuruTrust | null> {
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
  // 5 (not 3) attempts: webFetch rolls a fresh random proxy each call, so a 403 from a
  // datacenter-flagged IP is retried onto a different one. Extra passes cut the "all
  // proxies bad" miss rate roughly an order of magnitude; the retry path is rare and
  // the page is gzipped (~80KB on the wire), so the added cost is negligible.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await webFetch(`https://casino.guru/${slug}-casino-review`, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 404) return null
      if (res.status !== 200) throw new Error(`casino.guru HTTP ${res.status}`)
      const t = await res.text()
      const si = parseSafetyIndex(t) // 200 with no rating block → genuine null
      if (!si) return null
      return {
        ...si,
        complaints: numberBefore(t, 'complaints about this casino'),
        unresolved: numberNear(t, 'unresolved'),
        userReviews: numberBefore(t, 'user reviews'),
      }
    } catch (e) {
      lastErr = e as Error
      await new Promise((r) => setTimeout(r, 500)) // brief pause, then a fresh proxy
    }
  }
  throw lastErr ?? new Error('casino.guru fetch failed')
}

// casino.org editorial rating (/5) — a recognised editorial review score, an
// independent third signal alongside the casino.guru expert index and the
// Trustpilot consumer rating. Lives behind the same Cloudflare wall, reached via
// the proxy pool. Parsed from the page's JSON-LD Review block (which carries
// worstRating/bestRating/ratingValue, so we can normalise the scale). Retry on
// transient errors with a fresh proxy; 404 = no such review (genuine miss).
async function fetchCasinoOrg(slug: string): Promise<{ score: number; reviewed: string } | null> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await webFetch(`https://www.casino.org/reviews/${slug}/`, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 404) return null
      if (res.status !== 200) throw new Error(`casino.org HTTP ${res.status}`)
      const t = await res.text()
      for (const m of t.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
          const j = JSON.parse(m[1])
          const nodes = Array.isArray(j) ? j : (j['@graph'] ?? [j])
          for (const n of Array.isArray(nodes) ? nodes : [nodes]) {
            if (n?.['@type'] === 'Review' && n.reviewRating?.ratingValue != null) {
              const rv = Number(n.reviewRating.ratingValue)
              const best = Number(n.reviewRating.bestRating ?? 5) || 5
              const score = best === 5 ? rv : (rv / best) * 5 // normalise to /5
              const reviewed = String(n.itemReviewed?.name ?? n.name ?? '')
              if (score > 0 && score <= 5) return { score: Number(score.toFixed(2)), reviewed }
            }
          }
        } catch {
          /* skip */
        }
      }
      return null
    } catch (e) {
      lastErr = e as Error
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr ?? new Error('casino.org fetch failed')
}

// AskGamblers expert rating (/10) — a recognised industry review score, reached
// through the paid unlocker (AskGamblers Cloudflare-blocks keyless/datacenter).
// Parsed from the page's JSON-LD aggregateRating / Review ratingValue.
async function fetchAskGamblers(slug: string): Promise<{ score: number; reviewed: string } | null> {
  const url = `https://www.askgamblers.com/casino-reviews/${slug}-casino-review`
  const init = { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(150_000) }
  // AskGamblers Cloudflare-blocks keyless/datacenter, so the residential path always
  // 403s — it's only reachable via the unlocker. When that's unavailable (no key, or
  // the breaker is open because ScraperAPI's quota is exhausted) skip quietly instead
  // of hammering a guaranteed-403 residential fetch.
  const p = unlockedFetch('askgamblers', url, init)
  if (!p) return null
  const res = await p
  if (res.status === 404) return null
  if (res.status !== 200) throw new Error(`askgamblers HTTP ${res.status}`)
  const t = await res.text()
  for (const m of t.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1])
      const nodes = Array.isArray(j) ? j : (j['@graph'] ?? [j])
      for (const n of Array.isArray(nodes) ? nodes : [nodes]) {
        const ar = n?.aggregateRating ?? (n?.['@type'] === 'AggregateRating' ? n : null) ?? n?.reviewRating
        if (ar?.ratingValue != null) {
          const rv = Number(ar.ratingValue)
          const best = Number(ar.bestRating ?? 10) || 10
          const score = best === 10 ? rv : (rv / best) * 10 // normalise to /10
          const reviewed = String(n.itemReviewed?.name ?? n.name ?? '')
          if (score > 0 && score <= 10) return { score: Number(score.toFixed(2)), reviewed }
        }
      }
    } catch {
      /* skip */
    }
  }
  return null
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
    const days = PAID_SOURCES.has(src) ? REFRESH_DAYS_PAID : REFRESH_DAYS_FREE
    return row && Date.now() - row.updated_at < days * 86_400_000
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
        const now2 = Date.now()
        const cgUrl = `https://casino.guru/${slug}-casino-review`
        upsert.run({ brand_key: key, source: 'casino.guru', score: r.score, score_max: 10, url: cgUrl, updated_at: now2 })
        // actionable trust extras — store even when 0 (0 unresolved disputes is GOOD)
        if (r.complaints != null) upsert.run({ brand_key: key, source: 'cg.complaints', score: r.complaints, score_max: 0, url: cgUrl, updated_at: now2 })
        if (r.unresolved != null) upsert.run({ brand_key: key, source: 'cg.unresolved', score: r.unresolved, score_max: 0, url: cgUrl, updated_at: now2 })
        if (r.userReviews != null) upsert.run({ brand_key: key, source: 'cg.userreviews', score: r.userReviews, score_max: 0, url: cgUrl, updated_at: now2 })
        console.log(`[reviews] ${name}: casino.guru ${r.score}/10 · ${r.complaints ?? '?'} complaints (${r.unresolved ?? '?'} unresolved) · ${r.userReviews ?? '?'} user reviews`)
        break
      }
      await new Promise((r) => setTimeout(r, 600))
    }
    } catch (e) {
      fetchOk = false // transient network/HTTP error — leave it unmarked so it retries
      const cause = (e as { cause?: { message?: string } }).cause?.message
      const why = cause ? `${(e as Error).message}: ${cause}` : (e as Error).message
      console.warn(`[reviews] ${name}: casino.guru fetch error (${why}), will retry`)
    }
    // only cache a genuine "no rating found" miss; a transient error retries next cycle
    if (fetchOk && !guru) upsert.run({ brand_key: key, source: 'casino.guru', score: 0, score_max: 10, url: null, updated_at: Date.now() })
  }

  // 2) Trustpilot rating — live via the residential proxy, Wayback as fallback
  if (!fresh('trustpilot')) {
    const domain = domainOf(name)
    if (domain) {
      const tp = await fetchTrustpilot(domain)
      if (tp != null) {
        upsert.run({ brand_key: key, source: 'trustpilot', score: tp.rating, score_max: 5, url: `https://www.trustpilot.com/review/${domain}`, updated_at: Date.now() })
        console.log(`[reviews] ${name}: Trustpilot ★${tp.rating}/5 (${tp.src})`)
      } else {
        upsert.run({ brand_key: key, source: 'trustpilot', score: 0, score_max: 5, url: null, updated_at: Date.now() })
      }
    }
  }

  // 3) casino.org editorial rating (/5) — third independent reputation signal
  if (!fresh('casino.org')) {
    let ed = 0
    let okC = true
    const bk = brandKey(name)
    try {
      for (const slug of slugCandidates(name)) {
        const r = await fetchCasinoOrg(slug)
        if (r != null && r.score > 0) {
          const reviewedKey = r.reviewed.toLowerCase().replace(/[^a-z0-9]/g, '')
          if (r.reviewed && bk && !reviewedKey.includes(bk) && !bk.includes(reviewedKey)) {
            await new Promise((res) => setTimeout(res, 500))
            continue // page reviews a different brand — skip this slug
          }
          ed = r.score
          upsert.run({ brand_key: key, source: 'casino.org', score: r.score, score_max: 5, url: `https://www.casino.org/reviews/${slug}/`, updated_at: Date.now() })
          console.log(`[reviews] ${name}: casino.org editorial ${r.score}/5`)
          break
        }
        await new Promise((res) => setTimeout(res, 500))
      }
    } catch (e) {
      okC = false
      const cause = (e as { cause?: { message?: string } }).cause?.message
      const why = cause ? `${(e as Error).message}: ${cause}` : (e as Error).message
      console.warn(`[reviews] ${name}: casino.org fetch error (${why}), will retry`)
    }
    if (okC && !ed) upsert.run({ brand_key: key, source: 'casino.org', score: 0, score_max: 5, url: null, updated_at: Date.now() })
  }

  // 4) AskGamblers expert rating (/10) — recognised industry score, via unlocker
  if (!fresh('askgamblers')) {
    let ag = 0
    let okA = true
    const bk = brandKey(name)
    try {
      for (const slug of slugCandidates(name)) {
        const r = await fetchAskGamblers(slug)
        if (r != null && r.score > 0) {
          const reviewedKey = r.reviewed.toLowerCase().replace(/[^a-z0-9]/g, '')
          if (r.reviewed && bk && !reviewedKey.includes(bk) && !bk.includes(reviewedKey)) {
            await new Promise((res) => setTimeout(res, 400))
            continue // page reviews a different brand — skip
          }
          ag = r.score
          upsert.run({ brand_key: key, source: 'askgamblers', score: r.score, score_max: 10, url: `https://www.askgamblers.com/casino-reviews/${slug}-casino-review`, updated_at: Date.now() })
          console.log(`[reviews] ${name}: AskGamblers ${r.score}/10`)
          break
        }
        await new Promise((res) => setTimeout(res, 400))
      }
    } catch (e) {
      okA = false
      console.warn(`[reviews] ${name}: AskGamblers fetch error (${(e as Error).message}), will retry`)
    }
    if (okA && !ag) upsert.run({ brand_key: key, source: 'askgamblers', score: 0, score_max: 10, url: null, updated_at: Date.now() })
  }
}

// brand_key → all third-party review scores (casino.guru Safety Index 0–10 +
// Trustpilot ★/5), for aggregation. Tiny table, built fresh each call.
export interface ReviewScore {
  safety: number | null // casino.guru 0–10
  trustpilot: number | null // ★/5
  editorial: number | null // casino.org /5
  askgamblers: number | null // AskGamblers /10
  complaints: number | null // casino.guru current complaint count
  unresolved: number | null // casino.guru unresolved complaints (actionable red flag)
  userReviews: number | null // casino.guru community-review count
}
export function reviewScores(): Map<string, ReviewScore> {
  const out = new Map<string, ReviewScore>()
  // read ALL rows: rating sources are only meaningful when >0 (0 = cached miss),
  // but the count sources (complaints/unresolved/reviews) are meaningful AT 0 too
  const rows = db.prepare('SELECT brand_key, source, score FROM reviews').all() as { brand_key: string; source: string; score: number }[]
  const blank = (): ReviewScore => ({ safety: null, trustpilot: null, editorial: null, askgamblers: null, complaints: null, unresolved: null, userReviews: null })
  for (const r of rows) {
    const e = out.get(r.brand_key) ?? blank()
    if (r.source === 'casino.guru' && r.score > 0) e.safety = r.score
    else if (r.source === 'trustpilot' && r.score > 0) e.trustpilot = r.score
    else if (r.source === 'casino.org' && r.score > 0) e.editorial = r.score
    else if (r.source === 'askgamblers' && r.score > 0) e.askgamblers = r.score
    else if (r.source === 'cg.complaints') e.complaints = r.score
    else if (r.source === 'cg.unresolved') e.unresolved = r.score
    else if (r.source === 'cg.userreviews') e.userReviews = r.score
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
    // one-time: existing casino.guru rows are "fresh" so the new complaint/
    // user-review extraction wouldn't run for up to REFRESH_DAYS. Mark them stale
    // (updated_at=0) so the next sweep re-fetches the page and populates the
    // complaint signals. The Safety Index value persists across the re-fetch.
    if (!stateGet('reviews:complaints:v2')) {
      const n = db.prepare("UPDATE reviews SET updated_at = 0 WHERE source = 'casino.guru'").run().changes
      stateSet('reviews:complaints:v2', 1)
      if (n) console.log(`[reviews] marked ${n} casino.guru rows stale to backfill complaint data`)
    }
    // one-time: re-fetch Trustpilot now that trustpilot.com routes through the
    // RESIDENTIAL proxy (the live site 403'd datacenter proxies, so we'd fallen
    // back to stale Wayback snapshots — a clean residential IP can hit it live).
    if (!stateGet('reviews:trustpilot:residential:v1')) {
      const n = db.prepare("UPDATE reviews SET updated_at = 0 WHERE source = 'trustpilot'").run().changes
      stateSet('reviews:trustpilot:residential:v1', 1)
      if (n) console.log(`[reviews] marked ${n} trustpilot rows stale to re-fetch live via residential proxy`)
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
