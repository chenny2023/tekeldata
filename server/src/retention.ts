import { db } from './db.ts'
import { config } from './config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Transfer retention. The indexed `transfers` table is the only unbounded
// table — on a size-capped volume it eventually fills the disk and SQLite
// starts throwing `disk I/O error`. When RETAIN_DAYS > 0 we delete transfers
// older than the window in small, checkpointed batches: each batch's WAL stays
// tiny and is truncated immediately, so the prune itself survives a near-full
// disk, and the freed pages are reused by ongoing indexing — capping the file
// size in place without an (impossible-on-a-full-disk) VACUUM.
// ─────────────────────────────────────────────────────────────────────────────

// Small batch: each DELETE is one synchronous transaction and every deleted row
// updates 5 indexes on the 37M-row / 10GB table — on a cold cache a 5000-row batch
// froze the loop for tens of seconds. 300 keeps each batch sub-second once warm
// (and only a couple seconds cold), with a yield between batches.
const BATCH = 300

export async function pruneOldTransfers(): Promise<number> {
  if (!(config.retainDays > 0)) return 0
  const cutoff = Date.now() - config.retainDays * 86_400_000
  // NO upfront COUNT(*) here: on the multi-GB, tens-of-millions-row transfers table
  // that single synchronous count scanned a huge index range on a cold cache and
  // froze the event loop for ~2min at boot (→ healthcheck 000, deploy fragility, took
  // the site down 2026-06-19). The chunked DELETE below is self-limiting (it stops
  // once a batch deletes < BATCH), so the count was only ever feeding a log line.
  const del = db.prepare(
    'DELETE FROM transfers WHERE rowid IN (SELECT rowid FROM transfers WHERE ts < ? LIMIT ?)',
  )
  let deleted = 0
  for (;;) {
    let changes = 0
    try {
      changes = del.run(cutoff, BATCH).changes
    } catch (e) {
      console.warn('[retention] batch failed (will retry next cycle):', (e as Error).message)
      break
    }
    deleted += changes
    if (changes < BATCH) break
    // breathe between batches so the API/event loop stays fully responsive — the
    // WAL is size-capped (journal_size_limit) + auto-checkpointed, so it can't
    // bloat even without an explicit checkpoint here.
    await new Promise((r) => setTimeout(r, 60))
  }
  // skip the TRUNCATE checkpoint when litestream owns the WAL (it would drop
  // un-shipped frames); litestream checkpoints itself after replicating
  if (!config.backupActive) {
    try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
  }
  if (deleted) console.log(`[retention] pruned ${deleted} transfers older than ${config.retainDays}d; freed pages are reused so the DB file stops growing`)
  return deleted
}

export function startRetention() {
  if (!(config.retainDays > 0)) {
    console.log('[retention] disabled (set RETAIN_DAYS to enable)')
    return
  }
  // First pass at boot+5min — NOT +30s. After lowering RETAIN_DAYS the first prune is
  // a large one-time catch-up (deleting the now-out-of-window backlog); running it
  // during the cold-cache boot rush would pile onto the boot-window freezes. Waiting
  // 5min lets the boot settle and the page cache warm, so the prune's batches are
  // fast. Steady-state prunes (every 6h) are small.
  setTimeout(() => {
    pruneOldTransfers().catch((e) => console.warn('[retention] initial prune failed:', (e as Error).message))
  }, 300_000)
  setInterval(() => {
    pruneOldTransfers().catch((e) => console.warn('[retention] prune failed:', (e as Error).message))
  }, 6 * 3600_000)
}
