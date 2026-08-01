import { db, stateGet, stateSet } from './db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// The cross-chain casino reserve split, computed from OUR OWN balance sweep.
//
// This replaces `arkham_chain_reserves`, which stopped updating for good when
// Arkham was retired on 2026-08-01 (portfolio endpoint 402, not renewing). That
// table still holds its last good values, so anything reading it keeps serving
// 2026-07-30 numbers indefinitely without any error surfacing — the worst failure
// mode for a site whose claim is live on-chain data.
//
// One definition, used by both the daily snapshot and the public SEO reserve page,
// so the two can never drift apart.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainReserveRow {
  chain: string
  v: number
  casinos: number
}

// `casinos` counts DISTINCT BRANDS on the chain. Arkham's column counted distinct
// entity keys, which is the same idea, so downstream copy ("N casinos on X") stays
// accurate after the switch.
const splitStmt = db.prepare(
  `SELECT b.chain, SUM(b.usd) v, COUNT(DISTINCT b.label) casinos
     FROM wallet_chain_balances b
     JOIN watchlist w ON w.chain=b.chain AND w.address=b.address
    WHERE w.active=1 AND w.category='casino'
    GROUP BY b.chain
   HAVING SUM(b.usd) > 0
    ORDER BY v DESC`,
)

export function chainReserveSplit(): ChainReserveRow[] {
  return splitStmt.all() as ChainReserveRow[]
}

// One-time purge of the Arkham-era rows in chain_reserve_history.
//
// That table was fed from `arkham_chain_reserves` while the source was already
// frozen, so every recorded day holds a byte-identical copy of one 2026-07-30
// snapshot. Left in place they would prefix the new sweep-based series with a
// stretch of perfectly flat "history" — which is exactly the false finding the
// chain-migration data story is gated on avoiding. The rows carry no marker
// distinguishing them from sweep rows, and they are worth nothing (a repeated
// snapshot is not history), so the whole table is cleared once at the switch-over.
// Latched in sync_state, so this can never delete real accumulated series later.
const SOURCE_LATCH = 'chainreshist:source'
const CURRENT_SOURCE = 'sweep-v1'
try {
  if (stateGet(SOURCE_LATCH) !== CURRENT_SOURCE) {
    const n = db.prepare('DELETE FROM chain_reserve_history').run().changes
    stateSet(SOURCE_LATCH, CURRENT_SOURCE)
    console.log(`[chainreserves] source → self-hosted sweep; cleared ${n} frozen Arkham-era row(s)`)
  }
} catch (e) {
  console.warn('[chainreserves] source switch skipped:', (e as Error).message)
}
