import { db, stateGet, stateSet } from './db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Internal-flow marker. A transfer is "internal" when its counterparty is itself a
// watched casino address — i.e. casino↔casino consolidation/churn, and the same
// transfer recorded once under each watched side (double-count). Volume metrics want
// these EXCLUDED, but doing it with a per-row `NOT EXISTS` over 57M rows blocked the
// event loop for tens of seconds on the hot path.
//
// Instead we precompute a `cp_internal` flag: this job walks the casino-address list
// and, for each address, marks every transfer whose counterparty equals it (one
// indexed UPDATE via idx_transfers_counterparty). Cursor-based + chunked + yields
// every batch, so it never blocks the loop. It loops forever, re-evaluating as new
// casino addresses are added (clustering, Dune, curated) — idempotent (sets 1 once).
//
// Once the first full pass is done, volume queries can filter `cp_internal=0` (a cheap
// column check) instead of the NOT EXISTS — fast AND credible.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = Number(process.env.INTERNAL_MARK_BATCH ?? 60) // casino addresses per cycle
const CYCLE_MS = 8_000
const markStmt = db.prepare('UPDATE transfers SET cp_internal=1 WHERE counterparty=? AND cp_internal=0')

let cursor = 0
let passMarked = 0

async function markOnce() {
  // walk active casino addresses in id order; wrap around at the end for re-evaluation
  const rows = db
    .prepare("SELECT address FROM watchlist WHERE category='casino' AND active=1 ORDER BY id LIMIT ? OFFSET ?")
    .all(BATCH, cursor) as { address: string }[]
  if (rows.length === 0) {
    // completed a full pass
    if (cursor > 0) {
      stateSet('internalflow:firstpass', '1')
      stateSet('internalflow:lastpass_marked', String(passMarked))
      if (passMarked) console.log(`[internal] full pass complete — ${passMarked} transfers newly marked internal`)
    }
    cursor = 0
    passMarked = 0
    return
  }
  let marked = 0
  // each UPDATE is a single indexed lookup on counterparty; group a few per micro-tx
  const tx = db.transaction((batch: { address: string }[]) => {
    for (const r of batch) marked += markStmt.run(r.address).changes
  })
  tx(rows)
  cursor += rows.length
  passMarked += marked
  if (marked > 0) console.log(`[internal] +${marked} internal transfers marked (cursor ${cursor})`)
}

export function startInternalFlow() {
  if (process.env.INTERNAL_MARK === '0') {
    console.log('[internal] disabled')
    return
  }
  const done = stateGet('internalflow:firstpass') === '1'
  console.log(`[internal] internal-flow marker active${done ? ' (first pass already done — re-evaluating)' : ' (first pass pending)'}`)
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
