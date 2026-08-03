import { db, externalFlowClause } from './db.ts'
import { aggregateBrands } from './aggregate.ts'
import { priorReserves } from './reservehistory.ts'
import { chainReserveSplit, reserveTotals } from './chainreserves.ts'
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

// Reserve COVERAGE level — qualitative band, never a raw %. The old UI rendered the
// weeks-of-withdrawal-coverage ratio ×100 ("4092% mapped"), which is meaningless to a
// reader and hurts credibility. We express coverage as an honest level instead, and
// log implausible inputs as data-quality issues.
function coverageLevel(b: any): 'high' | 'medium' | 'partial' | 'under_review' | 'unknown' {
  if (!(b.reserves > 0)) return 'unknown'
  if (b.volumeSuspect) return 'under_review'
  if (b.reserveCoverage != null && b.reserveCoverage > 200) return 'under_review' // implausible ratio
  if (b.confidence === 'high') return 'high'
  if (b.confidence === 'medium') return 'medium'
  return 'partial'
}

const dqInsert = db.prepare(`
  INSERT INTO data_quality_issue (date, issue_type, severity, related_brand_id, details_json, status, created_at, updated_at)
  VALUES (@date, @type, @sev, @brand, @details, 'open', @now, @now)
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
  // Count only EXTERNAL-facing flow: drop transfers whose counterparty is itself a
  // watched casino address. Those are internal consolidations / hot-wallet churn AND
  // they double-count (a casino-A→casino-B transfer is recorded once under each side),
  // which is exactly what inflated ETH volume to a nonsensical ~$22B/7d and crushed
  // every other chain's share. What's left ≈ real deposits + withdrawals (users/CEXs).
  // One shared definition with aggregate.ts (default = precomputed cp_internal flag).
  const EXTERNAL_ONLY = externalFlowClause()

  // Volume-suspect + treasury-churn operators must be excluded from EVERY headline
  // volume figure — total, net flow AND chain split — not just the chain share, or the
  // total annualises PAST the entire industry (~$1.5T/yr from Rollbit-style churn alone).
  // volumeSuspect catches wash; the per-tx ceiling catches treasury/market-making churn
  // (Rollbit ~$404k/tx vs ~$2k for real player flow).
  const suspectLabels = new Set<string>()
  for (const b of brands) if (b.volumeSuspect) { suspectLabels.add(b.brand); for (const m of b.members ?? []) suspectLabels.add(m.label) }
  const AVG_TX_CEILING = Number(process.env.DEPOSIT_AVG_TX_CEILING ?? 50_000)
  // ONE de-distorted scan per window → credible {total, deposits, withdrawals, per-chain}.
  // total = external deposits + withdrawals (gross); `deposits` (inflow) is the cleaner
  // "money in" figure (~half the gross). Chain split uses the 7d window (24h lags per chain).
  const flowBy = async (since: number) => {
    const rows = (await workerAll(
      `SELECT chain, label, SUM(usd) v,
              SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) inflow,
              SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) outflow,
              COUNT(*) n
       FROM transfers WHERE category='casino' AND ts>=? ${NOT_UNATTR} ${EXTERNAL_ONLY} GROUP BY chain, label`,
      [since],
    )) as { chain: string; label: string; v: number; inflow: number; outflow: number; n: number }[]
    const byChain = new Map<string, number>()
    let total = 0
    let inflow = 0
    let outflow = 0
    for (const r of rows) {
      if (suspectLabels.has(r.label)) continue
      if (r.n > 0 && r.v / r.n > AVG_TX_CEILING) continue // treasury-churn signature
      byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + (r.v ?? 0))
      total += r.v ?? 0
      inflow += r.inflow ?? 0
      outflow += r.outflow ?? 0
    }
    return { total, inflow, outflow, chainRows: [...byChain.entries()].map(([chain, v]) => ({ chain, v })).sort((a, b) => b.v - a.v) }
  }
  const f1 = await flowBy(d1)
  const f7 = await flowBy(d7)
  const trackedVol24 = f1.total
  const deposits24 = f1.inflow
  const netFlow24 = f1.inflow - f1.outflow
  const chainRows = f7.chainRows
  const chainRows24 = f1.chainRows
  const vol24ByChain = new Map(chainRows24.map((c) => [c.chain, c.v ?? 0]))

  // AUTHORITATIVE cross-chain split: per-chain RESERVES from our own balance sweep
  // (the indexed per-chain VOLUME above is ETH-skewed by our labeling coverage;
  // reserves are read directly from each watched address on its own chain incl.
  // BTC/Tron/SOL, and can't be wash-traded). Was Arkham's portfolio until it was
  // retired 2026-08-01 — see chainreserves.ts.
  const chainReserveRows = chainReserveSplit()
  const totChainReserves = chainReserveRows.reduce((s, c) => s + (c.v ?? 0), 0) || 1
  // Persist today's split into chain_reserve_history. arkham_chain_reserves itself is
  // overwritten on every refresh, so without this the cross-chain mix has no time
  // dimension and "which chains are casinos migrating to" can't be answered honestly.
  // ~10 rows/day, upserted through the day — far too small to need chunking.
  if (chainReserveRows.length) {
    const day = Math.floor(now / DAY)
    const insChain = db.prepare(
      `INSERT INTO chain_reserve_history(day, chain, usd, casinos, ts) VALUES(?,?,?,?,?)
       ON CONFLICT(day, chain) DO UPDATE SET usd=excluded.usd, casinos=excluded.casinos, ts=excluded.ts`,
    )
    db.transaction(() => {
      for (const c of chainReserveRows) insChain.run(day, c.chain, c.v ?? 0, c.casinos ?? 0, now)
    })()
  }

  // Whale activity MUST use the same credible basis as the headline total, or it
  // dwarfs it nonsensically: unfiltered, a single suspect operator's treasury/market-
  // making churn (e.g. Rollbit ~$4M/tx, in≈out) and internal/double-count made 24h
  // "whale activity" ≈ $3B against a ~$193M tracked total. So: external-facing flow
  // only (drops internal/double-count) AND drop volume-suspect operators (the same
  // wash/treasury-churn brands excluded from every headline figure).
  const suspectArr = [...suspectLabels]
  const suspectNotIn = suspectArr.length ? `AND label NOT IN (${suspectArr.map(() => '?').join(',')})` : ''
  // recent verified whale transfers (worker; indexed by usd)
  const whales = (await workerAll(
    `SELECT label, chain, usd, direction, ts FROM transfers WHERE category='casino' AND ts>=? AND usd>=50000 ${NOT_UNATTR} ${EXTERNAL_ONLY} ${suspectNotIn} ORDER BY ts DESC LIMIT 40`,
    [d1, ...suspectArr],
  )) as { label: string; chain: string; usd: number; direction: string; ts: number }[]

  // AGGREGATED whale activity — grouped by (brand, chain, direction) so the report
  // shows "Rain.gg · 6 inflows · $557.8K · ETH" instead of a raw transfer ticker
  // spamming the same brand+amount. Raw events stay in `whales` for the expand view.
  const whaleGroups = (await workerAll(
    `SELECT label, chain, direction, COUNT(*) cnt, SUM(usd) total, MAX(usd) largest
     FROM transfers WHERE category='casino' AND ts>=? AND usd>=50000 ${NOT_UNATTR} ${EXTERNAL_ONLY} ${suspectNotIn}
     GROUP BY label, chain, direction ORDER BY total DESC LIMIT 12`,
    [d1, ...suspectArr],
  )) as { label: string; chain: string; direction: string; cnt: number; total: number; largest: number }[]

  // reserves — sum the SAME live aggregate the reserves report uses (attributed brands'
  // mapped on-chain wallet balances), NOT the arkham_casino table, which is unpopulated
  // and left reserves_total at $0 across every daily snapshot (also broke /reports/daily
  // and the digest). Prior total comes from the per-brand reserve_history snapshots.
  const brandsWithReserves = verified.filter((b) => b.reserves > 0)
  const reservesTotal = brandsWithReserves.reduce((s, b) => s + b.reserves, 0)
  const prevReserves = brandsWithReserves.reduce((s, b) => s + (priorReserves(b.brand, 7)?.reserves ?? 0), 0)
  const reserveChange7d = prevReserves > 0 ? (reservesTotal - prevReserves) / prevReserves : null

  const liveStreamers = (db.prepare('SELECT COUNT(*) n FROM streamers WHERE live=1').get() as any).n ?? 0
  const activeCasinos = verified.filter((b) => (b.volume24h ?? 0) > 0).length

  const reserveRows = verified.filter((b) => b.reserves > 0).sort((a, b) => b.reserves - a.reserves)

  // market concentration — is the day driven by a few brands / one chain?
  const volSorted = verified.filter((b) => !b.volumeSuspect).map((b) => b.volume24h ?? 0).sort((a, b) => b - a)
  const totVol = volSorted.reduce((s, x) => s + x, 0) || 1
  const totChainVol = chainRows.reduce((s, c) => s + (c.v ?? 0), 0) || 1
  const concentration = {
    top3Share: volSorted.slice(0, 3).reduce((s, x) => s + x, 0) / totVol,
    top5Share: volSorted.slice(0, 5).reduce((s, x) => s + x, 0) / totVol,
    topChain: chainRows[0]?.chain ?? null,
    topChainShare: chainRows[0] ? (chainRows[0].v ?? 0) / totChainVol : 0,
  }

  // source health — user-readable data-coverage status per source (not eng monitoring)
  let sourceHealth: { source: string; status: string; lagMin: number | null }[] = []
  try {
    const recency = (source: string, ts: number | null | undefined) => {
      const lag = ts ? Math.round((now - ts) / 60_000) : null
      const status = lag == null ? 'Unknown' : lag < 60 ? 'Healthy' : lag < 360 ? 'Delayed' : 'Stale'
      return { source, status, lagMin: lag }
    }
    const one = (sql: string): number | null => ((db.prepare(sql).get() as any)?.t ?? null)
    sourceHealth = [
      recency('On-chain indexers', one('SELECT MAX(ts) t FROM transfers')),
      // Reserve freshness must come from the LIVE self-hosted sweep. This read
      // `arkham_casino`, which froze when Arkham was retired — so the public daily
      // report claimed "Reserve snapshots: Stale" while the sweep was current, and
      // would have kept claiming it forever.
      recency('Reserve snapshots', reserveTotals().freshest),
      recency('Streamer monitor', one('SELECT MAX(updated_at) t FROM streamers')),
    ]
  } catch (e) {
    console.warn('[snapshot] source health skipped:', (e as Error).message)
  }

  const payload = {
    concentration,
    sourceHealth,
    topMovers: verified
      .filter((b) => !b.volumeSuspect) // keep anomalous wash/internal volume out of movers
      .slice()
      .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
      .slice(0, 15)
      // `repSignal` replaces the bare `trust` field (which read like an official safety
      // score); `trust` kept for backward-compat with older consumers/snapshots.
      .map((b) => ({ label: b.brand, vol24h: b.volume24h ?? 0, vol7d: b.volume7d ?? 0, net7d: b.net7d ?? 0, change24h: b.change24h ?? null, repSignal: b.trust ?? null, trust: b.trust ?? null, confidence: b.confidence ?? 'medium' })),
    topReserves: reserveRows.slice(0, 8).map((b) => ({ label: b.brand, reserves: b.reserves, level: coverageLevel(b), confidence: b.confidence ?? 'medium', coverage: b.reserveCoverage ?? null })),
    chainVolume: chainRows.map((c) => ({ chain: c.chain, vol7d: c.v ?? 0, vol24h: vol24ByChain.get(c.chain) ?? 0 })),
    // authoritative cross-chain reserve split (Arkham-attributed) — the headline
    // chain distribution; BTC/Tron/SOL fairly represented, not coverage-skewed.
    chainReserves: chainReserveRows.map((c) => ({ chain: c.chain, usd: c.v ?? 0, share: (c.v ?? 0) / totChainReserves, casinos: c.casinos })),
    // aggregated whale groups (default display) + raw events (expand) — see queries above
    whaleGroups: whaleGroups.map((g) => ({ label: g.label, chain: g.chain, direction: g.direction, count: g.cnt, total: g.total, largest: g.largest })),
    whales: whales.map((w) => ({ label: w.label, chain: w.chain, usd: w.usd, direction: w.direction, ts: w.ts })),
    // pattern-detected flow not attributed to a verified brand — shown separately, and
    // de-distorted so this "observed" figure can't mislead (it was ~$6B/7d vs ~$1.3B
    // verified). Two plausibility gates drop near-certain false positives — mislabeled
    // exchange/bridge/MM wallets the casino-pattern heuristic over-caught:
    //   (a) average transfer is treasury/market-making sized (not player flow), and
    //   (b) the cluster out-volumes the #1 VERIFIED casino — no unnamed operator
    //       realistically settles more than the largest named brand in the market.
    unattributed: (() => {
      const maxVerVol7d = Math.max(0, ...verified.filter((b) => !b.volumeSuspect).map((b) => b.volume7d ?? 0))
      const real = unattr.filter((b) => {
        const churn = (b.txCount7d ?? 0) > 0 && (b.volume7d ?? 0) / (b.txCount7d as number) > AVG_TX_CEILING
        const implausible = maxVerVol7d > 0 && (b.volume7d ?? 0) > maxVerVol7d
        return !churn && !implausible
      })
      return {
        count: real.length,
        vol24h: real.reduce((s, b) => s + (b.volume24h ?? 0), 0),
        vol7d: real.reduce((s, b) => s + (b.volume7d ?? 0), 0),
        top: real
          .slice()
          .sort((a, b) => (b.volume7d ?? 0) - (a.volume7d ?? 0))
          .slice(0, 5)
          .map((b) => ({ label: b.brand, vol7d: b.volume7d ?? 0 })),
      }
    })(),
  }

  // confidence: lower when we have thin coverage today
  const conf = activeCasinos >= 20 && reservesTotal > 0 ? 'high' : activeCasinos >= 5 ? 'medium' : 'low'

  // data-quality log: record reserve-coverage anomalies (the "% mapped > 100" class)
  // so they're auditable instead of silently shown. Best-effort; never blocks the snapshot.
  try {
    const today = utcDay(now)
    db.prepare('DELETE FROM data_quality_issue WHERE date=? AND issue_type=?').run(today, 'reserve_coverage_under_review')
    const flagged = reserveRows.filter((b) => coverageLevel(b) === 'under_review')
    for (const b of flagged.slice(0, 50))
      dqInsert.run({ date: today, type: 'reserve_coverage_under_review', sev: 'warn', brand: b.brand, details: JSON.stringify({ reserves: b.reserves, reserveCoverage: b.reserveCoverage ?? null, volumeSuspect: !!b.volumeSuspect }), now })
    if (flagged.length) console.log(`[snapshot] flagged ${flagged.length} reserve-coverage anomalies → data_quality_issue`)
  } catch (e) {
    console.warn('[snapshot] dq log skipped:', (e as Error).message)
  }

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
  console.log(`[snapshot] market ${utcDay(now)} — vol24h(gross) $${Math.round(trackedVol24).toLocaleString()} (deposits $${Math.round(deposits24).toLocaleString()}), ${activeCasinos} casinos, ${chainRows.length} chains, conf=${conf}`)
}

export function latestMarketSnapshot(): any | null {
  const row = db.prepare('SELECT * FROM daily_market_snapshot ORDER BY snapshot_date DESC LIMIT 1').get() as any
  if (!row) return null
  const parse = (s: any, fb: any) => {
    try {
      return s ? JSON.parse(s) : fb
    } catch {
      return fb
    }
  }
  return {
    ...row,
    payload: parse(row.payload_json, {}),
    aiMarketRead: parse(row.ai_market_read, null),
    aiNotableSignals: parse(row.ai_notable_signals, []),
  }
}

export function startSnapshots() {
  const run = () => generateMarketSnapshot().catch((e) => console.warn('[snapshot] failed:', (e as Error).message))
  // first pass after the worker + aggregates warm up; then every 15 min
  setTimeout(run, 150_000)
  setInterval(run, 15 * 60_000).unref?.()
  console.log('[snapshot] daily market snapshot generator active (15-min refresh)')
}
