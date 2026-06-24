import { db } from '../db.ts'
import { webFetch } from '../net.ts'
import { unlockedFetch } from './unlocker.ts'
import { score as lexScore } from '../sentiment.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Reddit social mentions via the PUBLIC search endpoint (no OAuth).
//
// Reddit's OAuth token endpoint (api/v1/access_token) 403s datacenter AND proxy
// IPs hard — even clean residential ones — so the credentialed flow is a dead end
// from a server. The public search.json endpoint, fetched with a real browser
// User-Agent through the residential proxy (net.ts routes reddit.com via
// REDDIT_PROXY), is the path the common scrapers use and is far more permissive.
// No credentials needed. Results feed the same `mentions` table the Sentiment
// page reads (source='reddit'); nothing is fabricated.
// ─────────────────────────────────────────────────────────────────────────────

export const redditEnabled = () => true

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const insertMention = db.prepare(`
  INSERT OR IGNORE INTO mentions(id, watch_label, source, title, url, score, sentiment, ts)
  VALUES(@id, @watch_label, 'reddit', @title, @url, @score, @sentiment, @ts)
`)

// circuit breaker: back off when Reddit persistently blocks us, recover on success
export let redditConsecutiveFails = 0
let rr = 0

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/g, '&')
}

// Reddit's search.rss is Atom XML — pull the post out of each <entry>.
function parseAtom(xml: string): { id: string; title: string; link: string; content: string; ts: number }[] {
  const out: { id: string; title: string; link: string; content: string; ts: number }[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]
    const id = (e.match(/<id>([^<]+)<\/id>/)?.[1] ?? '').replace(/^t3_/, '').trim()
    if (!id) continue
    const title = decodeEntities((e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim())
    const link = (e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&')
    const contentRaw = e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ''
    const content = decodeEntities(contentRaw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
    const pub = e.match(/<(?:published|updated)>([^<]+)</)?.[1] ?? ''
    const ts = pub ? Date.parse(pub) : 0
    out.push({ id, title, link, content, ts: Number.isFinite(ts) ? ts : 0 })
  }
  return out
}

export async function runRedditOnce() {
  const casinos = db
    .prepare("SELECT DISTINCT label FROM watchlist WHERE category='casino' AND active=1")
    .all() as { label: string }[]
  if (casinos.length === 0) return
  const target = casinos[rr % casinos.length].label
  rr++

  const q = encodeURIComponent(`"${target.replace(/\.(com|io|gg)$/i, '')}"`)
  // Reddit's JSON endpoints are blocked even through the unlocker, but the RSS
  // search feed comes through (ScraperAPI premium). Fetch + parse the Atom XML.
  const url = `https://www.reddit.com/search.rss?q=${q}&sort=new&limit=25`
  let xml = ''
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 2 && !xml; attempt++) {
    try {
      const init = { headers: { 'User-Agent': UA, Accept: 'application/atom+xml,application/xml,text/xml' }, signal: AbortSignal.timeout(70_000) }
      // Try the FREE residential proxy first — the RSS search feed comes through it,
      // and reddit is by far the highest-frequency unlocker caller, so unlocker-first
      // here was the bulk of the monthly ScraperAPI spend on data the proxy already
      // returns. Only spend an unlocker credit if the proxy is actually blocked.
      let res = await webFetch(url, { ...init, signal: AbortSignal.timeout(20_000) }).catch(() => null)
      if (!res || !res.ok) {
        const u = unlockedFetch('reddit', url, init)
        if (u) res = await u
      }
      if (res && res.ok) {
        xml = await res.text()
        break
      }
      lastErr = new Error(`HTTP ${res?.status ?? 'fetch-failed'}`)
    } catch (e) {
      lastErr = e as Error
    }
    await new Promise((r) => setTimeout(r, 600))
  }

  if (!xml) {
    redditConsecutiveFails++
    if (redditConsecutiveFails <= 3) console.warn(`[reddit] ${target} failed:`, lastErr?.message)
    else if (redditConsecutiveFails === 4) console.warn('[reddit] persistent failures — backing off to 30m until a request succeeds')
    return
  }
  if (redditConsecutiveFails > 0) console.log('[reddit] recovered — resuming normal cadence')
  redditConsecutiveFails = 0

  let added = 0
  const entries = parseAtom(xml)
  const tx = db.transaction(() => {
    for (const e of entries) {
      const text = `${e.title} ${e.content}`.slice(0, 4000)
      const r = insertMention.run({
        id: `rd_${e.id}_${target}`,
        watch_label: target,
        title: e.title.slice(0, 300),
        url: e.link,
        score: 0, // RSS carries no upvote count
        sentiment: lexScore(text),
        ts: e.ts,
      })
      added += r.changes
    }
  })
  tx()
  if (added) console.log(`[reddit] ${target}: +${added} mentions`)
}

export function startReddit() {
  console.log('[reddit] RSS search feed active (via unlocker)')
  const loop = async () => {
    await runRedditOnce()
    // Each RSS fetch costs unlocker credits, and social mentions trickle in slowly,
    // so refresh gently: one casino per 3min (≈ every casino ~1.5h). Blocked → 30m.
    // Override the healthy cadence with REDDIT_INTERVAL_MS.
    const healthy = Number(process.env.REDDIT_INTERVAL_MS) || 180_000
    const delay = redditConsecutiveFails >= 4 ? 30 * 60_000 : healthy
    setTimeout(loop, delay)
  }
  setTimeout(loop, 40_000)
}
