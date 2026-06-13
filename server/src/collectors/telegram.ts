import { db } from '../db.ts'
import { webFetch } from '../net.ts'
import { brandName, brandKey } from '../casinometa.ts'
import { score } from '../sentiment.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Telegram public-channel signal. Crypto casinos run large public Telegram
// channels (Stake ~381K, Shuffle ~30K). The t.me/s/<channel> preview page is
// keyless and renders recent messages + the subscriber count. For each watched
// casino brand we probe its likely channel slug; where one exists we record the
// subscriber count (a community-size signal circus doesn't surface) and ingest
// recent messages as sentiment mentions (source='telegram'). Channels that
// don't exist are remembered and skipped.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SKIP_DAYS = 7

const insertMention = db.prepare(`
  INSERT OR IGNORE INTO mentions(id, watch_label, source, title, url, score, sentiment, ts)
  VALUES(@id, @watch_label, 'telegram', @title, @url, @subs, @sentiment, @ts)
`)
const setState = db.prepare("INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
const getState = (k: string) => (db.prepare('SELECT value FROM sync_state WHERE key=?').get(k) as any)?.value

function parseSubs(html: string): number {
  // structure: <span class="counter_value">381K</span> <span class="counter_type">subscribers</span>
  const m = html.match(/counter_value"[^>]*>\s*([\d.,]+)\s*([KM]?)\s*<\/span>\s*<span[^>]*counter_type"[^>]*>\s*subscribers/i)
  if (!m) return 0
  let n = parseFloat(m[1].replace(/,/g, ''))
  if (/k/i.test(m[2])) n *= 1e3
  else if (/m/i.test(m[2])) n *= 1e6
  return Math.round(n)
}
function messages(html: string): string[] {
  return [...html.matchAll(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 8)
}
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function slugCandidates(brand: string): string[] {
  const base = brand.toLowerCase().replace(/[^a-z0-9]/g, '')
  return [...new Set([base + 'casino', base, base + 'official', base + 'com'])]
}

let queue: { key: string; brand: string }[] = []
let cursor = 0
function refill() {
  // volume-prioritised: real brands (Stake, Shuffle…) before legacy dead labels
  const labels = db
    .prepare(
      `SELECT w.label, COALESCE(SUM(t.usd),0) vol FROM watchlist w LEFT JOIN transfers t ON t.watch_id=w.id
       WHERE w.category='casino' AND w.active=1 GROUP BY w.label ORDER BY vol DESC`,
    )
    .all() as { label: string }[]
  const seen = new Set<string>()
  queue = []
  for (const { label } of labels) {
    const k = brandKey(label)
    if (seen.has(k)) continue
    seen.add(k)
    queue.push({ key: k, brand: brandName(label) })
  }
  cursor = 0
}

export async function runTelegramOnce() {
  if (cursor >= queue.length) refill()
  if (queue.length === 0) return
  const { key, brand } = queue[cursor++]
  const skipKey = `tg:done:${key}`
  if (Number(getState(skipKey) ?? 0) > Date.now() - SKIP_DAYS * 86_400_000) return

  for (const slug of slugCandidates(brand)) {
    let html: string
    try {
      const res = await webFetch(`https://t.me/s/${slug}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) continue
      html = await res.text()
    } catch {
      continue
    }
    const msgs = messages(html)
    if (msgs.length === 0) continue // empty/private/non-existent → try next slug
    // verify this is actually the casino's channel, not a typosquat/unrelated one:
    // the channel title must reference the brand (skip if it clearly doesn't).
    const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1] ?? ''
    const titleKey = ogTitle.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (ogTitle && titleKey && !titleKey.includes(key) && !key.includes(titleKey)) {
      continue // channel title doesn't match the brand → don't trust its subs/messages
    }
    const subs = parseSubs(html)
    let added = 0
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const text of msgs.slice(-20)) {
        // only keep messages that actually name the brand (skip generic chatter)
        if (!new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) && msgs.length > 5) continue
        added += insertMention.run({
          id: `tg_${slug}_${hash(text)}`,
          watch_label: brand,
          title: text.slice(0, 280),
          url: `https://t.me/${slug}`,
          subs,
          sentiment: score(text),
          ts: now,
        }).changes
      }
    })
    tx()
    setState.run(skipKey, String(now))
    setState.run(`tg:subs:${key}`, String(subs))
    if (added || subs) console.log(`[telegram] ${brand} (@${slug}): ${subs.toLocaleString()} subscribers, +${added} mentions`)
    return
  }
  setState.run(skipKey, String(Date.now())) // no channel found — remember the miss
}

// brand_key → telegram subscriber count, for the Sentiment UI
export function telegramSubs(): Map<string, number> {
  const rows = db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'tg:subs:%'").all() as { key: string; value: string }[]
  return new Map(rows.map((r) => [r.key.replace('tg:subs:', ''), Number(r.value)]))
}

export function startTelegram() {
  console.log('[telegram] public-channel signal active')
  const loop = async () => {
    await runTelegramOnce().catch((e) => console.warn('[telegram]', (e as Error).message))
    setTimeout(loop, 15_000) // one brand per 15s
  }
  setTimeout(loop, 55_000)
}
