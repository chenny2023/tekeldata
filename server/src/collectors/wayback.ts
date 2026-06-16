import { db, stateGet, stateSet } from '../db.ts'
import { workerAll } from '../readpool.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Etherscan-nametag attribution via the Wayback Machine (keyless).
//
// Live explorer tag APIs are auth-gated, but the Internet Archive holds
// crawled copies of etherscan.io address pages whose <title> embeds the public
// nametag ("Stake.com | Address 0x974… | Etherscan"). For our highest-value
// unattributed ETH counterparties we look up the latest archived snapshot and
// adopt the tag — real, publicly-documented attribution, no guessing. Names
// matching gambling keywords are watched as casinos; exchanges as exchanges.
//
// Politeness: ≤ LOOKUPS_PER_RUN per weekly sweep, ~2s between requests, full
// backoff on 429/503. Addresses with no archived snapshot are remembered and
// not re-queried for SKIP_DAYS.
// ─────────────────────────────────────────────────────────────────────────────

const LOOKUPS_PER_RUN = 40
const RUN_EVERY_H = 24 * 7
const SKIP_DAYS = 30
const MIN_TX_7D = 40
const MIN_VOL_7D = 500_000

const GAMBLE = /casino|gambl|bet(?!a)|betting|stake|dice|slots?|poker|lottery|lotto|jackpot|roobet|rollbit|bitsler|wager|1xbet|bovada|fortunejack|duelbits|shuffle|gamdom|sportsbook|igaming|bc\.game|metawin|primedice|cloudbet|betfury|thunderpick/i
const EXCHANGE = /binance|okx|okex|huobi|htx|bybit|kraken|coinbase|kucoin|gate\.io|bitfinex|mexc|bitget|crypto\.com|upbit|bithumb|exchange|bitstamp|gemini|bitmart|whitebit|lbank|poloniex/i
const NOISE = /^(address|ethereum account|etherscan|contract address|token|0x)/i

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function archived(url: string): Promise<{ ts: string; orig: string } | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await webFetch(
        `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=-1&filter=statuscode:200&collapse=digest`,
        { signal: AbortSignal.timeout(30_000) },
      )
      if (r.status === 429 || r.status === 503) { await sleep(8000 * (i + 1)); continue }
      if (!r.ok) return null
      const rows = (await r.json()) as string[][]
      if (!Array.isArray(rows) || rows.length < 2) return null
      const last = rows[rows.length - 1]
      return { ts: last[1], orig: last[2] }
    } catch { await sleep(4000) }
  }
  return null
}

async function snapshotTitle(ts: string, orig: string): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await webFetch(`https://web.archive.org/web/${ts}/${orig}`, { signal: AbortSignal.timeout(45_000) })
      if (r.status === 429 || r.status === 503) { await sleep(8000 * (i + 1)); continue }
      if (!r.ok) return null
      const html = await r.text()
      return (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim().replace(/\s+/g, ' ') ?? null
    } catch { await sleep(4000) }
  }
  return null
}

export async function runWaybackAttribution() {
  const last = Number(stateGet('wayback:lastRun') ?? 0)
  if (Date.now() - last < RUN_EVERY_H * 3600_000) return
  stateSet('wayback:lastRun', Date.now())

  const since = Date.now() - 7 * 86_400_000
  const skipBefore = Date.now() - SKIP_DAYS * 86_400_000
  const candidates = (await workerAll(
    `SELECT t.counterparty a, COUNT(*) tx, SUM(t.usd) vol
     FROM transfers t
     WHERE t.chain='ETH' AND t.ts >= ?
       AND NOT EXISTS (SELECT 1 FROM watchlist w WHERE w.chain='ETH' AND w.address = t.counterparty)
     GROUP BY t.counterparty
     HAVING tx >= ? OR vol >= ?
     ORDER BY vol DESC LIMIT 200`,
    [since, MIN_TX_7D, MIN_VOL_7D],
  )) as { a: string; tx: number; vol: number }[]

  const addWatch = db.prepare(`
    INSERT OR IGNORE INTO watchlist(chain, address, label, category, active, created_at)
    VALUES('ETH', ?, ?, ?, 1, ?)`)

  let looked = 0
  let named = 0
  console.log(`[wayback] attribution sweep: ${candidates.length} candidates`)
  for (const c of candidates) {
    if (looked >= LOOKUPS_PER_RUN) break
    const skipKey = `wayback:miss:${c.a}`
    if (Number(stateGet(skipKey) ?? 0) > skipBefore) continue
    looked++
    const snap = await archived('etherscan.io/address/' + c.a)
    if (!snap) { stateSet(skipKey, Date.now()); await sleep(2000); continue }
    const title = await snapshotTitle(snap.ts, snap.orig)
    const name = title?.split('|')[0].trim() ?? ''
    if (!name || NOISE.test(name) || name.length > 48) { stateSet(skipKey, Date.now()); await sleep(2000); continue }
    const category = GAMBLE.test(name) ? 'casino' : EXCHANGE.test(name) ? 'exchange' : null
    if (category) {
      addWatch.run(c.a, name, category, Date.now())
      named++
      console.log(`[wayback] attributed ${c.a.slice(0, 10)}… -> "${name}" (${category})`)
    } else {
      stateSet(skipKey, Date.now()) // named but neither casino nor exchange — leave unwatched
    }
    await sleep(2000)
  }
  console.log(`[wayback] sweep done — ${looked} lookups, ${named} new attributions`)
}

export function startWayback() {
  setTimeout(() => runWaybackAttribution().catch((e) => console.warn('[wayback]', e.message)), 5 * 60_000)
  setInterval(() => runWaybackAttribution().catch((e) => console.warn('[wayback]', e.message)), 12 * 3600_000)
}
