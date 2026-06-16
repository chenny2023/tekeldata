import { db } from './db.ts'
import { aggregateBrands } from './aggregate.ts'
import { workerGet, workerAll } from './readpool.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Daily market snapshot generator (1.0 content layer). Precomputes the homepage +
// daily-email data source so the front end NEVER queries raw transfers. All heavy
// reads go through the read-worker pool (aggregateEntities + the SUM queries), so
// generation never blocks the main loop. One row per UTC day, upserted through the
// day (so "today" stays fresh) and finalised at day end by the next day's row.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)

const upsert = db.prepare(`
  INSERT INTO daily_market_snapshot
    (snapshot_date, tracked_volume_24h, net_flow_24h, active_casinos, active_chains,
     live_streamers, reserves_total, reserve_change_7d, payload_json, confidence_level, created_at, updated_at)
  VALUES
    (@d, @vol, @net, @ac, @ach, @ls, @rt, @rc, @pj, @conf, @now, @now)
  ON CONFLICT(snapshot_date) DO UPDATE SET
    tracked_volume_24h=@vol, net_flow_24h=@net, active_casinos=@ac, active_chains=@ach,
    live_streamers=@ls, reserves_total=@rt, reserve_change_7d=@rc, payload_json=@pj,
    confidence_level=@conf, updated_at=@now
`)

export async function generateMarketSnapshot(): Promise<void> {
  const now = Date.now()
  const d1 = now - DAY
  const d7 = now - 7 * DAY

  // brand-MERGED, VERIFIED casinos only. Auto-detected 'Casino-pattern 0x…' wallets
  // are kept OUT of verified totals and surfaced as a separate unattributed block.
  const brands = (await aggregateBrands('casino')).filter((b) => b.volume7d > 0 || b.reserves > 0)
  const verified = brands.filter((b) => b.attributed)
  const unattr = brands.filter((b) => !b.attributed)

  // exclude unattributed wallet labels from the raw 24h roll-ups (vol / flow / chain / whales)
  const NOT_UNATTR =
    "AND label NOT LIKE 'Casino-pattern%' AND label NOT LIKE '0x%' AND label NOT LIKE 'Unknown%' AND label NOT LIKE 'Unnamed%'"

  // 24h verified casino totals (worker)
  const tot = (await workerGet(
    `SELECT SUM(usd) vol,
            SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) inflow,
            SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) outflow
     FROM transfers WHERE category='casino' AND ts>=? ${NOT_UNATTR}`,
    [d1],
  )) as { vol: number; inflow: number; outflow: number }
  const trackedVol24 = tot?.vol ?? 0
  const netFlow24 = (tot?.inflow ?? 0) - (tot?.outflow ?? 0)

  // 24h verified casino volume per chain (worker)
  const chainRows = (await workerAll(
    `SELECT chain, SUM(usd) v FROM transfers WHERE category='casino' AND ts>=? ${NOT_UNATTR} GROUP BY chain ORDER BY v DESC`,
    [d1],
  )) as { chain: string; v: number }[]

  // recent verified whale transfers (worker; indexed by usd)
  const whales = (await workerAll(
    `SELECT label, chain, usd, direction, ts FROM transfers WHERE category='casino' AND ts>=? AND usd>=50000 ${NOT_UNATTR} ORDER BY ts DESC LIMIT 12`,
    [d1],
  )) as { label: string; chain: string; usd: number; direction: string; ts: number }[]

  // reserves (small tables — main thread is fine)
  const reservesTotal =
    (db.prepare("SELECT COALESCE(SUM(reserves_usd),0) t FROM arkham_casino WHERE entity_id!='' AND reserves_usd IS NOT NULL").get() as any).t ?? 0
  const prevReserves =
    (db
      .prepare(
        `SELECT COALESCE(SUM(r),0) t FROM (
           SELECT (SELECT reserves_usd FROM arkham_reserve_history h WHERE h.key=a.key AND h.ts<=? ORDER BY h.ts DESC LIMIT 1) r
           FROM arkham_casino a WHERE a.entity_id!='' AND a.reserves_usd IS NOT NULL)`,
      )
      .get(d7) as any).t ?? 0
  const reserveChange7d = prevReserves > 0 ? (reservesTotal - prevReserves) / prevReserves : null

  const liveStreamers = (db.prepare('SELECT COUNT(*) n FROM streamers WHERE live=1').get() as any).n ?? 0
  const activeCasinos = verified.filter((b) => (b.volume24h ?? 0) > 0).length

  const payload = {
    topMovers: verified
      .filter((b) => !b.volumeSuspect) // keep anomalous wash/internal volume out of movers
      .slice()
      .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
      .slice(0, 8)
      .map((b) => ({ label: b.brand, vol24h: b.volume24h ?? 0, vol7d: b.volume7d ?? 0, net7d: b.net7d ?? 0, trust: b.trust ?? null })),
    topReserves: verified
      .filter((b) => b.reserves > 0)
      .sort((a, b) => b.reserves - a.reserves)
      .slice(0, 8)
      .map((b) => ({ label: b.brand, reserves: b.reserves, coverage: b.reserveCoverage ?? null })),
    chainVolume: chainRows.map((c) => ({ chain: c.chain, vol24h: c.v ?? 0 })),
    whales: whales.map((w) => ({ label: w.label, chain: w.chain, usd: w.usd, direction: w.direction, ts: w.ts })),
    // pattern-detected flow not attributed to a verified brand — shown separately
    unattributed: {
      count: unattr.length,
      vol24h: unattr.reduce((s, b) => s + (b.volume24h ?? 0), 0),
      vol7d: unattr.reduce((s, b) => s + (b.volume7d ?? 0), 0),
      top: unattr
        .slice()
        .sort((a, b) => (b.volume7d ?? 0) - (a.volume7d ?? 0))
        .slice(0, 5)
        .map((b) => ({ label: b.brand, vol7d: b.volume7d ?? 0 })),
    },
  }

  // confidence: lower when we have thin coverage today
  const conf = activeCasinos >= 20 && reservesTotal > 0 ? 'high' : activeCasinos >= 5 ? 'medium' : 'low'

  upsert.run({
    d: utcDay(now),
    vol: trackedVol24,
    net: netFlow24,
    ac: activeCasinos,
    ach: chainRows.length,
    ls: liveStreamers,
    rt: reservesTotal,
    rc: reserveChange7d,
    pj: JSON.stringify(payload),
    conf,
    now,
  })
  console.log(`[snapshot] market ${utcDay(now)} — vol24h $${Math.round(trackedVol24).toLocaleString()}, ${activeCasinos} casinos, ${chainRows.length} chains, conf=${conf}`)
}

export function latestMarketSnapshot(): any | null {
  const row = db.prepare('SELECT * FROM daily_market_snapshot ORDER BY snapshot_date DESC LIMIT 1').get() as any
  if (!row) return null
  return { ...row, payload: JSON.parse(row.payload_json || '{}') }
}

export function startSnapshots() {
  const run = () => generateMarketSnapshot().catch((e) => console.warn('[snapshot] failed:', (e as Error).message))
  // first pass after the worker + aggregates warm up; then every 15 min
  setTimeout(run, 150_000)
  setInterval(run, 15 * 60_000).unref?.()
  console.log('[snapshot] daily market snapshot generator active (15-min refresh)')
}
