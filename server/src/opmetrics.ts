// In-memory rolling 24h operational-event counter. Collectors call recordOp() at
// their existing catch sites (casino.guru miss, RPC forward error, …); the daily
// system report reads opCounts24h() for its "collector errors" section. Purely
// in-memory — it resets on deploy, so the report labels the window "since restart".
// A DB table would be more durable but adds write load on the hot collector path for
// data that only feeds one daily email; a rolling array is the right weight here.

const DAY_MS = 86_400_000
const startedAt = Date.now()
const events: { key: string; ts: number }[] = []

export function recordOp(key: string): void {
  const now = Date.now()
  events.push({ key, ts: now })
  // opportunistic prune so the array can't grow unbounded on a noisy day
  if (events.length > 20_000) {
    const cut = now - DAY_MS
    let i = 0
    while (i < events.length && events[i].ts < cut) i++
    if (i) events.splice(0, i)
  }
}

// counts per key over the trailing 24h, plus how long we've been counting (a deploy
// resets the window, so the report can say "since restart Nh ago" honestly).
export function opCounts24h(): { counts: Record<string, number>; total: number; sinceMs: number } {
  const cut = Date.now() - DAY_MS
  const counts: Record<string, number> = {}
  let total = 0
  for (const e of events) {
    if (e.ts < cut) continue
    counts[e.key] = (counts[e.key] ?? 0) + 1
    total++
  }
  return { counts, total, sinceMs: Date.now() - startedAt }
}
