import { db, INFRA_DENYLIST, stateGet, stateSet } from '../db.ts'
import { workerAll } from '../readpool.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Transaction-graph address-discovery CANDIDATES (post-Arkham — see
// docs/HANDOFF-2026-08-01-arkham-retirement.md). The old Arkham entity→hot-wallet
// harvester is gone, so EVM address coverage stopped growing (only dune + manual).
//
// This fills the discovery gap SAFELY. Unlike BTC common-input-ownership, EVM
// counterparty co-occurrence does NOT prove ownership — a casino hot wallet's
// counterparty could be a player, exchange, bridge or another operator. So this
// NEVER writes to `watchlist` and never touches a public number. It surfaces scored
// CANDIDATES (into graph_candidates + logs + an admin diag) for review; promotion is
// a separate, deliberate step. Auto-attribution on a weak signal is exactly what
// caused the $1.52B→$860M reserve error the handoff documents.
//
// Heuristic (all from indexed `transfers`, zero new RPC):
//   • counterparty of a STRONG-source (curated/dune) casino wallet — never expand from
//     heuristic sources (btc-cluster) to avoid cascading errors
//   • bidirectional flow (deposits AND payouts > 0) → internal-treasury pattern; a
//     player is one-way deposit-heavy, so two-way cycling is the own-wallet signature
//   • captive to exactly ONE casino brand — a counterparty seen across multiple brands
//     is shared infra (exchange/bridge/DEX), not one operator's treasury → excluded
//   • not infra-denylisted, not already watched
//   • contracts flagged (contracts WERE the attribution error) → 'low', never promotable
// ─────────────────────────────────────────────────────────────────────────────

export type GraphCandidate = {
  addr: string
  chain: string
  brand: string
  inUsd: number
  outUsd: number
  txn: number
  days: number
  isContract: boolean
  confidence: 'medium' | 'low'
  score: number
}

export type GraphCandidateOpts = { days?: number; minUsd?: number; minTx?: number; minDays?: number; limit?: number }

export async function computeGraphCandidates(opts: GraphCandidateOpts = {}): Promise<{
  window: string
  thresholds: { minUsd: number; minTx: number; minDays: number }
  strongBrands: number
  candidates: GraphCandidate[]
}> {
  const days = Math.min(Math.max(Number(opts.days ?? 14), 1), 30)
  const since = Date.now() - days * 86_400_000
  const minUsd = Math.max(Number(opts.minUsd ?? 50_000), 0)
  const minTx = Math.max(Number(opts.minTx ?? 8), 1)
  const minDays = Math.max(Number(opts.minDays ?? 3), 1)
  const limit = Math.min(Math.max(Number(opts.limit ?? 300), 1), 1000)

  const strong = new Set(
    (await workerAll<{ label: string }>(
      "SELECT DISTINCT label FROM watchlist WHERE active=1 AND category='casino' AND (source IS NULL OR source IN ('curated','dune'))",
    )).map((r) => r.label),
  )
  // counterparty aggregates over ALL casino EVM transfers (brands counted across every
  // casino label so the captivity guard is real), pre-filtered by the flow thresholds.
  const rows = await workerAll<{ addr: string; chain: string; inUsd: number; outUsd: number; txn: number; brands: number; brand: string; days: number }>(
    `SELECT counterparty addr, chain,
            SUM(CASE WHEN direction='in' THEN usd ELSE 0 END) inUsd,
            SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) outUsd,
            COUNT(*) txn, COUNT(DISTINCT label) brands, MIN(label) brand,
            COUNT(DISTINCT ts/86400000) days
       FROM transfers
      WHERE category='casino' AND ts>=? AND chain NOT IN ('BTC','TRON','SOL')
      GROUP BY counterparty, chain
     HAVING brands=1 AND inUsd>0 AND outUsd>0 AND txn>=? AND days>=? AND (inUsd+outUsd)>=?
      ORDER BY (inUsd+outUsd) DESC LIMIT ?`,
    [since, minTx, minDays, minUsd, limit],
  )
  const watched = new Set((await workerAll<{ a: string }>('SELECT lower(address) a FROM watchlist WHERE active=1')).map((r) => r.a))
  const contracts = new Set((await workerAll<{ a: string }>('SELECT lower(address) a FROM wallet_code_kind WHERE is_contract=1')).map((r) => r.a))

  const candidates = rows
    .map((r) => ({ r, low: String(r.addr || '').toLowerCase() }))
    .filter(({ r, low }) => strong.has(r.brand) && !watched.has(low) && !INFRA_DENYLIST.has(low))
    .map(({ r, low }): GraphCandidate => {
      const total = r.inUsd + r.outUsd
      const bal = Math.min(r.inUsd, r.outUsd) / Math.max(r.inUsd, r.outUsd) // 0..1 two-way balance
      const isContract = contracts.has(low)
      const score = Math.round((Math.log10(Math.max(total, 1)) * 10 + bal * 20 + Math.min(r.days, 14)) * (isContract ? 0.3 : 1))
      // EVM ownership is unprovable from flow alone → never 'high'. Contract → 'low' (likely
      // a pool/router). Everything here is review-only regardless of tier.
      const confidence: 'medium' | 'low' = isContract ? 'low' : bal >= 0.4 && r.days >= 7 && total >= 250_000 ? 'medium' : 'low'
      return { addr: r.addr, chain: r.chain, brand: r.brand, inUsd: Math.round(r.inUsd), outUsd: Math.round(r.outUsd), txn: r.txn, days: r.days, isContract, confidence, score }
    })
    .sort((a, b) => b.score - a.score)

  return { window: `${days}d`, thresholds: { minUsd, minTx, minDays }, strongBrands: strong.size, candidates }
}

const upsert = db.prepare(
  `INSERT INTO graph_candidates(chain, address, brand, in_usd, out_usd, txn, days, is_contract, confidence, score, first_seen, last_seen)
   VALUES(@chain, @address, @brand, @in_usd, @out_usd, @txn, @days, @is_contract, @confidence, @score, @now, @now)
   ON CONFLICT(chain, address) DO UPDATE SET
     brand=excluded.brand, in_usd=excluded.in_usd, out_usd=excluded.out_usd, txn=excluded.txn,
     days=excluded.days, is_contract=excluded.is_contract, confidence=excluded.confidence,
     score=excluded.score, last_seen=excluded.last_seen`,
)

async function runOnce() {
  const { candidates, strongBrands } = await computeGraphCandidates({ limit: 300 })
  const now = Date.now()
  // persist the top slice (chunked write is tiny — ≤300 rows — but keep it in one tx)
  const top = candidates.slice(0, 300)
  db.transaction(() => {
    for (const c of top)
      upsert.run({ chain: c.chain, address: c.addr, brand: c.brand, in_usd: c.inUsd, out_usd: c.outUsd, txn: c.txn, days: c.days, is_contract: c.isContract ? 1 : 0, confidence: c.confidence, score: c.score, now })
  })()
  stateSet('graphexp:last', JSON.stringify({ ts: now, strongBrands, candidates: candidates.length }))
  const med = candidates.filter((c) => c.confidence === 'medium').length
  const preview = candidates.slice(0, 5).map((c) => `${c.brand}/${c.chain}:${c.addr.slice(0, 10)}…($${Math.round((c.inUsd + c.outUsd) / 1000)}k${c.isContract ? ',contract' : ''})`).join(' ')
  console.log(`[graphexp] ${candidates.length} candidates from ${strongBrands} strong brands (${med} medium) · review-only, 0 attributed · top: ${preview}`)
}

export function startGraphExpand() {
  if (process.env.GRAPH_EXPAND === '0') {
    console.log('[graphexp] disabled (GRAPH_EXPAND=0)')
    return
  }
  console.log('[graphexp] transaction-graph candidate discovery active (review-only, never auto-attributes)')
  const loop = async () => {
    try {
      await runOnce()
    } catch (e) {
      console.warn('[graphexp]', (e as Error).message)
    } finally {
      setTimeout(loop, 6 * 3600_000) // 4×/day is plenty — the transfers window moves slowly
    }
  }
  setTimeout(loop, 240_000) // 4 min after boot, behind the heavier collectors + read pool warmup
}
