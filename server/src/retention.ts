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

const BATCH = 5_000

export async function pruneOldTransfers(): Promise<number> {
  if (!(config.retainDays > 0)) return 0
  const cutoff = Date.now() - config.retainDays * 86_400_000
  const before = (db.prepare('SELECT COUNT(*) n FROM transfers WHERE ts < ?').get(cutoff) as any).n as number
  if (!before) return 0
  console.log(`[retention] pruning ${before} transfers older than ${config.retainDays}d…`)
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
  try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
  console.log(`[retention] pruned ${deleted} transfers; freed pages are reused so the DB file stops growing`)
  return deleted
}

export function startRetention() {
  if (!(config.retainDays > 0)) {
    console.log('[retention] disabled (set RETAIN_DAYS to enable)')
    return
  }
  // run the first pass shortly after boot (never blocks startup/healthcheck),
  // then every 6h
  setTimeout(() => {
    pruneOldTransfers().catch((e) => console.warn('[retention] initial prune failed:', (e as Error).message))
  }, 30_000)
  setInterval(() => {
    pruneOldTransfers().catch((e) => console.warn('[retention] prune failed:', (e as Error).message))
  }, 6 * 3600_000)
}
