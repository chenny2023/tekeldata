import { db, stateSet, stateGet } from '../db.ts'
import { webFetch } from '../net.ts'
import { unlockedFetch, tierName } from './unlocker.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Trustpilot directory enricher. The casino *category* listing is bot-blocked
// (403 even via residential), but the per-business review page /review/{domain}
// is reachable, so we enrich each directory casino individually: fetch its review
// page through the residential proxy, read the TrustScore + review count from the
// page's JSON-LD AggregateRating, and stamp tp_rating / tp_reviews onto the row.
// Paced one casino per ~25s. tp_checked stops us re-hammering the same domains;
// casinos with no Trustpilot profile (404) are marked checked so we move on.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
// Each fetch spends ~30 ScraperAPI credits (Trustpilot needs the ultra tier — it
// fingerprint-blocks even residential IPs, so we can't downgrade or use the free
// proxy here). Across the whole directory this is the dominant credit consumer, so
// recheck infrequently — Trustpilot ratings move over months, not weeks. ~45 days
// roughly halves the monthly spend vs the old 21. Env-overridable for tuning.
const RECHECK_MS = Number(process.env.TRUSTPILOT_RECHECK_DAYS ?? 45) * 24 * 3600_000

// Reachable casinos first (site_ok), then never-checked before stale ones.
const pickNext = db.prepare(
  `SELECT domain FROM casino_directory
   WHERE last_checked > 0 AND (tp_checked = 0 OR tp_checked < @stale)
   ORDER BY site_ok DESC, tp_checked ASC LIMIT 1`,
)
const update = db.prepare('UPDATE casino_directory SET tp_rating=@rating, tp_reviews=@reviews, tp_checked=@now WHERE domain=@domain')

function parseReview(html: string): { rating: number | null; reviews: number | null } {
  let rating: number | null = null
  let reviews: number | null = null
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j: any
    try {
      j = JSON.parse(m[1])
    } catch {
      continue
    }
    const stack = [j]
    let guard = 0
    while (stack.length && guard++ < 5000) {
      const n = stack.pop()
      if (!n || typeof n !== 'object') continue
      if (Array.isArray(n)) {
        for (const x of n) stack.push(x)
        continue
      }
      const ar = n.aggregateRating ?? (n['@type'] === 'AggregateRating' ? n : null)
      if (ar) {
        const rv = Number(ar.ratingValue)
        const rc = Number(String(ar.reviewCount ?? ar.ratingCount ?? '').toString().replace(/,/g, ''))
        if (Number.isFinite(rv) && rv > 0) rating = rv
        if (Number.isFinite(rc) && rc > 0) reviews = rc
      }
      for (const k in n) stack.push(n[k])
    }
    if (rating != null) break
  }
  return { rating, reviews }
}

async function enrichOne(): Promise<void> {
  const row = pickNext.get({ stale: Date.now() - RECHECK_MS }) as { domain: string } | undefined
  if (!row) return
  const now = Date.now()
  try {
    const target = `https://www.trustpilot.com/review/${row.domain}`
    // Trustpilot blocks even residential IPs at the fingerprint level, so prefer
    // the paid unlocker channel when configured; fall back to the residential path.
    const init = { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(150_000) }
    const res = (await unlockedFetch('trustpilot', target, init)) ?? (await webFetch(target, init))
    if (res.status === 404) {
      // no Trustpilot profile — mark checked so we stop retrying it
      update.run({ domain: row.domain, rating: null, reviews: null, now })
      stateSet('trustpilot:last', JSON.stringify({ domain: row.domain, status: 404 }))
      return
    }
    if (res.status !== 200) {
      // ALWAYS advance (mark checked) — otherwise pickNext re-selects this same
      // domain every tick and burns unlocker credits in an infinite loop.
      update.run({ domain: row.domain, rating: null, reviews: null, now })
      stateSet('trustpilot:last', JSON.stringify({ domain: row.domain, status: res.status, tier: tierName('trustpilot') }))
      return
    }
    const { rating, reviews } = parseReview(await res.text())
    update.run({ domain: row.domain, rating, reviews, now })
    stateSet('trustpilot:last', JSON.stringify({ domain: row.domain, status: 200, rating, reviews, tier: tierName('trustpilot') }))
    if (rating != null) console.log(`[trustpilot] ${row.domain}: ★${rating} (${reviews ?? '?'} reviews)`)
  } catch (e) {
    // network/timeout — advance too (short-circuit the loop); 3-week recheck retries
    update.run({ domain: row.domain, rating: null, reviews: null, now })
    stateSet('trustpilot:last', JSON.stringify({ domain: row.domain, err: (e as Error).message.slice(0, 50) }))
  }
}

export function startTrustpilotCategory() {
  if ((process.env.TRUSTPILOT_CAT ?? '1') === '0') return
  console.log('[trustpilot] per-domain review enricher active')
  // one-time: before the unlocker plan worked the enricher marked every casino
  // tp_checked with a null rating — reset so they all get fetched for real now.
  if (!stateGet('trustpilot:reset:unlocker')) {
    const n = db.prepare('UPDATE casino_directory SET tp_checked=0').run().changes
    stateSet('trustpilot:reset:unlocker', 1)
    if (n) console.log(`[trustpilot] reset ${n} rows to re-fetch via the unlocker`)
  }
  const loop = async () => {
    await enrichOne().catch((e) => console.warn('[trustpilot]', (e as Error).message))
    setTimeout(loop, 25_000) // one casino per 25s through the residential proxy
  }
  setTimeout(loop, 150_000) // start well after boot, behind discovery
}
