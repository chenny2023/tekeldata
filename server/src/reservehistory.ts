import { db } from './db.ts'
import { brandKey } from './casinometa.ts'
import { aggregateBrands } from './aggregate.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Reserve-adequacy (solvency) trend. Once a day we snapshot every casino brand's
// real on-chain reserves, its weekly outflow, and the coverage ratio
// (reserves / weekly-outflow ≈ how many weeks of withdrawals the reserves cover).
// Over time this builds a per-casino solvency time series — a casino whose
// coverage trends down while outflow rises is a real risk signal. Pure
// computation over data we already hold; covers every casino, no external source.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const upsert = db.prepare(`
  INSERT INTO reserve_history(brand_key, day, reserves, outflow7d, coverage, ts)
  VALUES(@brand_key, @day, @reserves, @outflow7d, @coverage, @ts)
  ON CONFLICT(brand_key, day) DO UPDATE SET
    reserves=excluded.reserves, outflow7d=excluded.outflow7d, coverage=excluded.coverage, ts=excluded.ts
`)

export async function snapshotReserves() {
  const now = Date.now()
  const day = Math.floor(now / DAY)
  const brands = await aggregateBrands('casino')
  let n = 0
  const tx = db.transaction(() => {
    for (const b of brands) {
      if (b.reserves <= 0 && b.outflow7d <= 0) continue // nothing meaningful to record
      upsert.run({
        brand_key: brandKey(b.brand),
        day,
        reserves: b.reserves,
        outflow7d: b.outflow7d,
        coverage: b.reserveCoverage ?? 0,
        ts: now,
      })
      n++
    }
  })
  tx()
  if (n) console.log(`[reserves] solvency snapshot — ${n} casinos`)
}

// the coverage we snapshotted ~daysAgo days back (newest snapshot at or before that
// day), for period-over-period comparison. null until that much history exists.
const priorQ = db.prepare('SELECT coverage FROM reserve_history WHERE brand_key=? AND day<=? ORDER BY day DESC LIMIT 1')
export function priorCoverage(brand: string, daysAgo = 7): number | null {
  const day = Math.floor(Date.now() / DAY) - daysAgo
  const row = priorQ.get(brandKey(brand), day) as { coverage: number } | undefined
  return row ? row.coverage : null
}

// daily {day, reserves, outflow7d, coverage} series for one brand (most recent N days)
export function reserveSeries(brand: string, days = 60): { t: number; reserves: number; outflow7d: number; coverage: number }[] {
  const key = brandKey(brand)
  const rows = db
    .prepare('SELECT day, reserves, outflow7d, coverage FROM reserve_history WHERE brand_key=? ORDER BY day DESC LIMIT ?')
    .all(key, days) as { day: number; reserves: number; outflow7d: number; coverage: number }[]
  return rows.reverse().map((r) => ({ t: r.day * DAY, reserves: r.reserves, outflow7d: r.outflow7d, coverage: r.coverage }))
}

export function startReserveHistory() {
  console.log('[reserves] solvency-trend snapshots active (daily)')
  // first snapshot a few minutes after boot (let reserves/aggregates warm up), then daily
  const run = () => void snapshotReserves().catch((e) => console.warn('[reserves] snapshot failed:', (e as Error).message))
  setTimeout(() => {
    run()
    setInterval(run, DAY)
  }, 5 * 60_000)
}
