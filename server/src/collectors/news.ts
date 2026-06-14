import { db } from '../db.ts'
import { score as lexScore } from '../sentiment.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// REAL keyless brand-mention collection via Google News RSS search.
//
// Reddit now requires OAuth credentials (see reddit.ts), so this collector
// covers the mention feed out of the box: for each watched entity we search
// Google News for its brand name, store real headlines with the shared
// gambling-tuned lexicon sentiment score, and feed the same `mentions` table
// the Sentiment page reads. Nothing is fabricated — entities nobody writes
// about simply stay at zero mentions.
//
// Brands are deduplicated per sweep ("Binance 14"…"Binance 18" → one "Binance"
// query attributed to the highest-volume label) and queried one per 30s, well
// below any rate limit.
// ─────────────────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const newsEnabled = () => true

const insertMention = db.prepare(`
  INSERT OR IGNORE INTO mentions(id, watch_label, source, title, url, score, sentiment, ts)
  VALUES(@id, @watch_label, 'news', @title, @url, @score, @sentiment, @ts)
`)

// "Binance 14" → "Binance" ; "Binance-Hot 7" → "Binance-Hot" ; "OKX 2" → "OKX"
// "Binance (TRON)" → "Binance". Domain suffixes stay ("Stake.com" is the brand).
function brandOf(label: string): string {
  return label
    .replace(/\s*\((ETH|TRON)\)\s*$/i, '')
    .replace(/\s+\d+$/, '')
    .trim()
}

// One label per brand, ordered casinos-first then by indexed activity, so the
// 25-min sweep spends its queries on entities that matter.
function sweepTargets(): { label: string; brand: string }[] {
  const rows = db
    .prepare(
      `SELECT w.label, w.category, COUNT(t.id) AS tx
       FROM watchlist w LEFT JOIN transfers t ON t.watch_id = w.id
       WHERE w.active = 1
       GROUP BY w.label
       ORDER BY CASE WHEN w.category = 'casino' THEN 0 ELSE 1 END, tx DESC`,
    )
    .all() as { label: string; category: string; tx: number }[]
  const seen = new Set<string>()
  const out: { label: string; brand: string }[] = []
  for (const r of rows) {
    const brand = brandOf(r.label)
    if (brand.length < 3) continue
    const key = brand.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: r.label, brand })
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? decodeEntities(m[1]).trim() : ''
}

// djb2 — stable id for a url without pulling in a hash dep
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

let targets: { label: string; brand: string }[] = []
let cursor = 0

export async function runNewsOnce() {
  if (cursor >= targets.length) {
    targets = sweepTargets()
    cursor = 0
    if (targets.length === 0) return
  }
  const { label, brand } = targets[cursor++]

  // two queries per brand: the plain name (corporate/regulatory news) AND a
  // sentiment-rich query (player reviews, scam/withdrawal/payout chatter) — the
  // second surfaces the opinionated coverage the Sentiment page actually wants.
  // Same-article hits across the two dedupe on the INSERT OR IGNORE id.
  const needle = brand.toLowerCase().replace(/\.(com|io|gg|game)$/, '')
  const reNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const brandRe = new RegExp(`\\b${reNeedle}\\b`, 'i')
  const queries = [
    `"${brand}"`,
    `"${brand}" (review OR scam OR rigged OR withdrawal OR payout OR complaint OR bonus)`,
  ]

  let added = 0
  for (const query of queries) {
    try {
      const q = encodeURIComponent(query)
      const res = await webFetch(
        `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const xml = await res.text()
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []
      const tx = db.transaction(() => {
        for (const item of items.slice(0, 30)) {
          const title = tag(item, 'title')
          const link = tag(item, 'link')
          const pub = Date.parse(tag(item, 'pubDate'))
          if (!title || !link || Number.isNaN(pub)) continue
          // only keep headlines that actually name the brand on a WORD BOUNDARY
          // (so "Stake" doesn't false-match "mistake"/"staked")
          if (!brandRe.test(title)) continue
          const r = insertMention.run({
            id: `gn_${hash(link)}_${label}`,
            watch_label: label,
            title: title.slice(0, 300),
            url: link,
            score: 0,
            sentiment: lexScore(title + ' ' + tag(item, 'description')),
            ts: pub,
          })
          added += r.changes
        }
      })
      tx()
    } catch (e) {
      console.warn(`[news] ${brand} (${query.includes('OR') ? 'sentiment' : 'name'}) failed:`, (e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 800)) // small gap between the two queries
  }
  if (added) console.log(`[news] ${brand}: +${added} mentions`)
}

export function startNews() {
  console.log('[news] keyless Google News mention feed active')
  const loop = async () => {
    await runNewsOnce()
    setTimeout(loop, 30_000) // one brand per 30s — polite
  }
  loop()
}
