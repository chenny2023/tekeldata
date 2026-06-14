import { db } from '../db.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// REAL social-mention collection via Reddit's official OAuth API.
//
// Reddit no longer serves JSON to anonymous clients, so this module is
// OPTIONAL: it activates only when REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are
// set (free "script" app at reddit.com/prefs/apps). Without credentials the
// mentions table simply stays empty and the UI says so — nothing is fabricated.
//
// For each casino in the watchlist we search recent posts mentioning its name,
// store them with a small-lexicon sentiment score (-1..1), and aggregate
// pos/neg/neutral splits for the Sentiment page.
// ─────────────────────────────────────────────────────────────────────────────

const env = process.env
export const redditEnabled = () => !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)

// Reddit is strict about User-Agent: it wants a unique, descriptive,
// platform:appname:version form, and 403s generic ones.
const UA = 'web:wcoin-casino:1.0 (on-chain casino analytics; +https://wcoin.casino)'
let token = ''
let tokenExp = 0

async function appToken(): Promise<string> {
  if (token && Date.now() < tokenExp) return token
  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64')
  // Reddit blocks datacenter IPs (Railway 403s; the proxy pool gets tarpitted on
  // some IPs). webFetch picks a fresh random proxy each call, so retry a few
  // times — if only SOME upstream IPs are blocked, a retry rolls onto a good one.
  let res: Awaited<ReturnType<typeof webFetch>> | null = null
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await webFetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(25_000),
      })
      if (res.status === 401) break // bad creds — retrying won't help
      if (res.ok) break
      lastErr = new Error(`token HTTP ${res.status}`)
      res = null
    } catch (e) {
      lastErr = e as Error
      res = null
    }
    await new Promise((r) => setTimeout(r, 600)) // brief pause, then a fresh proxy
  }
  if (!res) throw lastErr ?? new Error('reddit token: all proxy attempts failed')
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`token HTTP ${res.status} — ${body}`)
  }
  const json = await res.json()
  token = json.access_token
  tokenExp = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000
  return token
}

// Small sentiment lexicon tuned for gambling-community language.
const POS = new Set(['win', 'won', 'winning', 'paid', 'payout', 'fast', 'legit', 'great', 'good', 'best', 'love', 'profit', 'bonus', 'instant', 'trust', 'trusted', 'recommend', 'awesome', 'fair'])
const NEG = new Set(['scam', 'scammed', 'rigged', 'lost', 'lose', 'losing', 'stole', 'stolen', 'fraud', 'banned', 'locked', 'withhold', 'refuse', 'refused', 'delay', 'delayed', 'avoid', 'worst', 'bad', 'never', 'support', 'ignored', 'phishing'])

function lexScore(text: string): number {
  const words = text.toLowerCase().split(/[^a-z.]+/)
  let pos = 0
  let neg = 0
  for (const w of words) {
    if (POS.has(w)) pos++
    if (NEG.has(w)) neg++
  }
  const total = pos + neg
  return total === 0 ? 0 : (pos - neg) / total
}

const insertMention = db.prepare(`
  INSERT OR IGNORE INTO mentions(id, watch_label, source, title, url, score, sentiment, ts)
  VALUES(@id, @watch_label, 'reddit', @title, @url, @score, @sentiment, @ts)
`)

let rr = 0
export async function runRedditOnce() {
  if (!redditEnabled()) return
  const casinos = db
    .prepare("SELECT DISTINCT label FROM watchlist WHERE category='casino' AND active=1")
    .all() as { label: string }[]
  if (casinos.length === 0) return
  const target = casinos[rr % casinos.length].label
  rr++

  try {
    const t = await appToken()
    const q = encodeURIComponent(`"${target.replace(/\.(com|io|gg)$/i, '')}"`)
    const res = await webFetch(
      `https://oauth.reddit.com/search?q=${q}&sort=new&t=week&limit=25&type=link`,
      { headers: { Authorization: `Bearer ${t}`, 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    let added = 0
    const tx = db.transaction((children: any[]) => {
      for (const c of children) {
        const d = c.data
        if (!d?.id) continue
        const text = `${d.title ?? ''} ${d.selftext ?? ''}`.slice(0, 4000)
        const r = insertMention.run({
          id: `rd_${d.id}_${target}`,
          watch_label: target,
          title: (d.title ?? '').slice(0, 300),
          url: 'https://reddit.com' + (d.permalink ?? ''),
          score: d.score ?? 0,
          sentiment: lexScore(text),
          ts: Math.round((d.created_utc ?? 0) * 1000),
        })
        added += r.changes
      }
    })
    tx(json.data?.children ?? [])
    if (added) console.log(`[reddit] ${target}: +${added} mentions`)
  } catch (e) {
    console.warn(`[reddit] ${target} failed:`, (e as Error).message)
  }
}

export function startReddit() {
  if (!redditEnabled()) {
    console.log('[reddit] disabled (no REDDIT_CLIENT_ID/SECRET) — mention feed will be empty')
    return
  }
  const loop = async () => {
    await runRedditOnce()
    setTimeout(loop, 20_000) // one casino per 20s — well inside free-tier limits
  }
  loop()
}
