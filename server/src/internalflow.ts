import { db, stateGet, stateSet } from './db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Internal-flow marker. A transfer is "internal" when its counterparty is itself a
// watched casino address — casino↔casino consolidation/churn, plus the same transfer
// recorded once under each watched side (double-count). Volume metrics want these
// EXCLUDED, but doing it with a per-row `NOT EXISTS` over 57M rows blocked the hot path.
//
// We precompute a `cp_internal` flag instead. This job walks casino addresses and
// marks their counterparty transfers (idx_transfers_counterparty). CRITICAL: it marks
// at most CHUNK rows per cycle and yields, so a hot counterparty (a main hot wallet
// referenced by tens of thousands of internal transfers) is spread over many cycles
// rather than one huge UPDATE that bloats the WAL and stalls the loop. Idempotent;
// loops to re-evaluate as addresses are added. Once `firstpass` is set, phase 2 can
// switch volume queries to the cheap `cp_internal=0` filter.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK = Number(process.env.INTERNAL_MARK_CHUNK ?? 3000) // max rows marked per cycle (bounds WAL/block)
const CYCLE_MS = 3_000
const pickIds = db.prepare('SELECT id FROM transfers WHERE counterparty=? AND cp_internal=0 LIMIT ?')
const markId = db.prepare('UPDATE transfers SET cp_internal=1 WHERE id=?')

let cursor = 0 // OFFSET into the casino-address list

async function markOnce() {
  const row = db
    .prepare("SELECT address FROM watchlist WHERE category='casino' AND active=1 ORDER BY id LIMIT 1 OFFSET ?")
    .get(cursor) as { address: string } | undefined
  if (!row) {
    // wrapped the whole list → a full pass is done; restart for incremental re-eval
    if (cursor > 0 && stateGet('internalflow:firstpass') !== '1') {
      stateSet('internalflow:firstpass', '1')
      console.log('[internal] first full pass complete — cp_internal is now authoritative')
    }
    cursor = 0
    return
  }
  const ids = pickIds.all(row.address, CHUNK) as { id: number }[]
  if (ids.length) {
    db.transaction((batch: { id: number }[]) => {
      for (const x of batch) markId.run(x.id)
    })(ids)
    if (ids.length >= 100) console.log(`[internal] marked ${ids.length} for ${row.address.slice(0, 10)}… (cursor ${cursor})`)
  }
  // advance only when this address is fully drained (< CHUNK left); else re-process it
  // next cycle so a hot address is marked in bounded chunks, never one giant UPDATE.
  if (ids.length < CHUNK) cursor++
}

export function startInternalFlow() {
  if (process.env.INTERNAL_MARK === '0') {
    console.log('[internal] disabled')
    return
  }
  const done = stateGet('internalflow:firstpass') === '1'
  console.log(`[internal] internal-flow marker active${done ? ' (first pass done — incremental re-eval)' : ' (first pass pending)'}`)
  const loop = async () => {
    try {
      await markOnce()
    } catch (e) {
      console.warn('[internal]', (e as Error).message)
    } finally {
      setTimeout(loop, CYCLE_MS)
    }
  }
  setTimeout(loop, 120_000) // start well after boot settles
}
