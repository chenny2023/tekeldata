import { db } from '../db.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Historical daily price series for assets we value at non-1:1 (currently SOL —
// every other chain we index settles in stablecoins valued 1:1). A transfer's
// USD value must use the price ON THE DAY it happened, not today's spot, or
// months-old native-SOL deposits get mis-valued. Source: Binance daily klines
// (keyless), CoinGecko fallback. The series is held in memory for synchronous
// per-transfer lookups during indexing.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const upsert = db.prepare('INSERT INTO prices(asset, day, usd) VALUES(?, ?, ?) ON CONFLICT(asset, day) DO UPDATE SET usd=excluded.usd')

const cache = new Map<string, Map<number, number>>() // asset → (day → usd)
const spot = new Map<string, number>() // asset → latest price

function loadCache(asset: string) {
  const m = new Map<number, number>()
  for (const r of db.prepare('SELECT day, usd FROM prices WHERE asset=?').all(asset) as { day: number; usd: number }[]) m.set(r.day, r.usd)
  cache.set(asset, m)
  if (m.size) spot.set(asset, [...m.entries()].sort((a, b) => b[0] - a[0])[0][1])
}

// historical USD price for `asset` at time `ts` (ms). Falls back to the nearest
// earlier day, then to spot — never throws, so indexing is never blocked.
export function priceForDay(asset: string, ts: number): number {
  const m = cache.get(asset)
  if (!m || m.size === 0) return spot.get(asset) ?? 0
  const day = Math.floor(ts / DAY_MS)
  if (m.has(day)) return m.get(day)!
  // nearest earlier day within a week, else spot
  for (let d = day; d > day - 7; d--) if (m.has(d)) return m.get(d)!
  return spot.get(asset) ?? 0
}

async function withRetry<T>(fn: () => Promise<T | null>, tries = 3): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fn()
    if (r) return r
    await new Promise((res) => setTimeout(res, 2500))
  }
  return null
}

async function fetchBinance(symbol: string): Promise<[number, number][] | null> {
  return withRetry(async () => {
    try {
      const r = await webFetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=200`, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return null
      const rows = (await r.json()) as any[]
      return rows.map((k) => [Math.floor(k[0] / DAY_MS), Number(k[4])] as [number, number])
    } catch {
      return null
    }
  })
}

async function fetchCoingecko(id: string): Promise<[number, number][] | null> {
  return withRetry(async () => {
    try {
      const r = await webFetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=180&interval=daily`, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return null
      const j = (await r.json()) as any
      return (j.prices ?? []).map((p: number[]) => [Math.floor(p[0] / DAY_MS), p[1]] as [number, number])
    } catch {
      return null
    }
  })
}

async function refresh(asset: string, binanceSym: string, geckoId: string) {
  const data = (await fetchBinance(binanceSym)) ?? (await fetchCoingecko(geckoId))
  if (!data || data.length === 0) {
    console.warn(`[prices] ${asset} history unavailable`)
    return
  }
  const tx = db.transaction(() => {
    for (const [day, usd] of data) if (usd > 0) upsert.run(asset, day, usd)
  })
  tx()
  loadCache(asset)
  console.log(`[prices] ${asset} daily history loaded — ${data.length} days, spot ~$${(spot.get(asset) ?? 0).toFixed(2)}`)
}

// assets we value at non-1:1 — native coins of chains we index
const ASSETS: { asset: string; binance: string; gecko: string }[] = [
  { asset: 'SOL', binance: 'SOLUSDT', gecko: 'solana' },
  { asset: 'BTC', binance: 'BTCUSDT', gecko: 'bitcoin' },
  { asset: 'LTC', binance: 'LTCUSDT', gecko: 'litecoin' },
  { asset: 'XRP', binance: 'XRPUSDT', gecko: 'ripple' },
  { asset: 'ETH', binance: 'ETHUSDT', gecko: 'ethereum' }, // native ETH deposits
  { asset: 'BNB', binance: 'BNBUSDT', gecko: 'binancecoin' }, // native BNB deposits
  // Needed to value native reserve balances on the non-ETH EVM chains. Polygon's
  // native coin is POL (the MATIC rebrand) — the gecko id follows the new ticker.
  { asset: 'POL', binance: 'POLUSDT', gecko: 'polygon-ecosystem-token' },
  { asset: 'AVAX', binance: 'AVAXUSDT', gecko: 'avalanche-2' },
]

// Latest known USD price for a native asset, or 0 when we have no series yet.
// Callers MUST treat 0 as "unpriced" and skip the balance rather than booking it
// at zero — a missing price must never look like a drained wallet.
export function spotUsd(asset: string): number {
  return priceForDay(asset, Date.now())
}

export function startPrices() {
  for (const a of ASSETS) loadCache(a.asset) // serve cached immediately
  const run = async () => {
    for (const a of ASSETS) await refresh(a.asset, a.binance, a.gecko).catch((e) => console.warn(`[prices] ${a.asset}`, (e as Error).message))
  }
  run()
  setInterval(run, 6 * 3600_000) // refresh 4×/day
  // retry until every asset has history (covers transient outages)
  const retry = setInterval(() => {
    if (ASSETS.every((a) => (cache.get(a.asset)?.size ?? 0) > 0)) { clearInterval(retry); return }
    run()
  }, 120_000)
}
