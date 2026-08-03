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
// EXISTS on address alone, deliberately NOT a join on (chain, address). Casinos reuse
// one 0x wallet across EVM chains, so the sweep records a mainnet-listed address's
// Base/Arbitrum/Optimism balances too, and those chains have no watchlist row of their
// own — a (chain, address) join dropped them and Base read as $0. EXISTS also avoids
// the trap in the obvious fix: joining on address alone would match an address listed
// on two chains twice and double its balance in the SUM. Address formats don't collide
// across chain families (0x / base58 / bech32), so this stays unambiguous.
const splitStmt = db.prepare(
  `SELECT b.chain, SUM(b.usd) v, COUNT(DISTINCT b.label) casinos
     FROM wallet_chain_balances b
    WHERE EXISTS (
            SELECT 1 FROM watchlist w
             WHERE w.address=b.address AND w.active=1 AND w.category='casino'
          )
    GROUP BY b.chain
   HAVING SUM(b.usd) > 0
    ORDER BY v DESC`,
)

export function chainReserveSplit(): ChainReserveRow[] {
  return splitStmt.all() as ChainReserveRow[]
}

// Headline reserve totals from the SAME sweep, for the public coverage figures and
// the daily report's source-health row. Both used to read `arkham_casino`, which has
// been frozen since Arkham was retired — so the site was publishing a stale vendor
// number as its live coverage stat, and reporting "Reserve snapshots: Stale" while
// the sweep was in fact fresh. Same EXISTS predicate as splitStmt (see the note
// above on why it is EXISTS on address alone), minus the per-chain grouping.
const totalsStmt = db.prepare(
  `SELECT COUNT(DISTINCT b.label) casinos, COALESCE(SUM(b.usd),0) usd, MAX(b.updated_at) freshest
     FROM wallet_chain_balances b
    WHERE EXISTS (
            SELECT 1 FROM watchlist w
             WHERE w.address=b.address AND w.active=1 AND w.category='casino'
          )
      AND b.usd > 0`,
)

export function reserveTotals(): { casinos: number; usd: number; freshest: number | null } {
  return totalsStmt.get() as { casinos: number; usd: number; freshest: number | null }
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
