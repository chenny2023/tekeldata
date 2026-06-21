import { db } from '../db.ts'
import { webFetchProxied, webFetchUnlocked, webFetchDirect } from '../net.ts'
import { brandName } from '../casinometa.ts'
import { score } from '../sentiment.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Genuine user-generated social chatter via Bluesky's PUBLIC AppView search
// (app.bsky.feed.searchPosts) — keyless, and unlike Reddit it serves public read
// traffic without IP-blocking datacenter ranges. For each watched casino brand we
// pull recent posts that name it, score them with the shared gambling lexicon,
// and feed the same `mentions` table the Sentiment page reads (source='bluesky').
// If Bluesky ever rejects our requests it just fails that cycle (graceful) and
// the source stays at zero — nothing is fabricated.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const insertMention = db.prepare(`
  INSERT OR IGNORE INTO mentions(id, watch_label, source, title, url, score, sentiment, ts)
  VALUES(@id, @watch_label, 'bluesky', @title, @url, @score, @sentiment, @ts)
`)

// distinct casino brands (canonical name), casinos that actually have flow first
function targets(): { label: string; brand: string }[] {
  const rows = db
    .prepare(
      `SELECT w.label, COUNT(t.id) AS tx
       FROM watchlist w LEFT JOIN transfers t ON t.watch_id = w.id
       WHERE w.active = 1 AND w.category = 'casino'
       GROUP BY w.label ORDER BY tx DESC`,
    )
    .all() as { label: string; tx: number }[]
  const seen = new Set<string>()
  const out: { label: string; brand: string }[] = []
  for (const r of rows) {
    const brand = brandName(r.label)
    const key = brand.toLowerCase()
    if (brand.length < 3 || seen.has(key)) continue
    seen.add(key)
    out.push({ label: r.label, brand })
  }
  return out
}

let list: { label: string; brand: string }[] = []
let cursor = 0
// Bluesky's edge 403s datacenter IPs (Railway + the datacenter proxies), like
// Reddit. Back off when it persistently rejects us so we don't spam, and recover
// the instant a request succeeds (e.g. a clean residential proxy is configured).
export let blueskyConsecutiveFails = 0
let lastVia = '' // last successful fetch path — log only when it changes (diagnosis)

export async function runBlueskyOnce() {
  if (cursor >= list.length) {
    list = targets()
    cursor = 0
    if (list.length === 0) return
  }
  const { label, brand } = list[cursor++]
  try {
    const q = encodeURIComponent(brand.replace(/\.(com|io|gg|game)$/i, '')) // "Stake.com" → search "Stake"
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${q}&limit=25&sort=latest`
    // Browser-like headers — bsky's searchPosts sits behind Cloudflare, which fingerprints
    // headers, not just the IP (verified: getProfiles 200 but searchPosts 403 from the same
    // datacenter IP → endpoint-specific bot protection).
    const init = {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://bsky.app',
        Referer: 'https://bsky.app/',
      },
      signal: AbortSignal.timeout(20_000),
    }
    // Try in order and log the WINNING path so prod tells us what actually works:
    //   1) residential proxy (the user's home IPs — Reddit works through these)
    //   2) paid web-unlocker (real Cloudflare bypass; null when SCRAPER_API_KEY unset)
    //   3) direct (datacenter) — getProfiles proves bsky's edge is reachable
    let res: Response | null = null
    let via = ''
    res = await webFetchProxied(url, init).catch(() => null)
    if (res?.ok) via = 'residential'
    if (!res?.ok) {
      const u = webFetchUnlocked(url, init)
      if (u) { res = await u.catch(() => null); if (res?.ok) via = 'unlocker' }
    }
    if (!res?.ok) { res = await webFetchDirect(url, init).catch(() => null); if (res?.ok) via = 'direct' }
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? 'blocked'} (all paths)`)
    if (via !== lastVia) { console.log(`[bluesky] reachable via ${via}`); lastVia = via }
    const j = (await res.json()) as { posts?: any[] }
    const posts = j.posts ?? []
    // word-boundary brand match so "Stake" doesn't catch "mistake"
    const needle = brand.toLowerCase().replace(/\.(com|io|gg|game)$/i, '')
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    let added = 0
    const tx = db.transaction(() => {
      for (const p of posts) {
        const text: string = p?.record?.text ?? ''
        if (!text || !re.test(text)) continue
        const handle: string = p?.author?.handle ?? ''
        const rkey = String(p?.uri ?? '').split('/').pop() ?? ''
        if (!rkey) continue
        const ts = Date.parse(p?.record?.createdAt ?? p?.indexedAt ?? '') || Date.now()
        const r = insertMention.run({
          id: `bs_${rkey}_${label}`,
          watch_label: label,
          title: text.replace(/\s+/g, ' ').slice(0, 300),
          url: handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : '',
          score: Number(p?.likeCount ?? 0),
          sentiment: score(text),
          ts,
        })
        added += r.changes
      }
    })
    tx()
    if (blueskyConsecutiveFails > 0) console.log('[bluesky] recovered — resuming normal cadence')
    blueskyConsecutiveFails = 0
    if (added) console.log(`[bluesky] ${brand}: +${added} mentions`)
  } catch (e) {
    blueskyConsecutiveFails++
    if (blueskyConsecutiveFails <= 3) console.warn(`[bluesky] ${brand} failed:`, (e as Error).message)
    else if (blueskyConsecutiveFails === 4) console.warn('[bluesky] persistent failures (datacenter IP-block) — backing off to 30m until a request succeeds')
  }
}

export function startBluesky() {
  console.log('[bluesky] public post search active')
  const loop = async () => {
    await runBlueskyOnce()
    const delay = blueskyConsecutiveFails >= 4 ? 30 * 60_000 : 25_000
    setTimeout(loop, delay)
  }
  setTimeout(loop, 30_000)
}
