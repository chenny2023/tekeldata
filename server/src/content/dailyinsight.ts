import { db } from '../db.ts'
import { buildPrompt } from './prompts.ts'
import { generateContent, openrouterEnabled } from './openrouter.ts'
import { qaCheck } from './qa.ts'

// ─────────────────────────────────────────────────────────────────────────────
// "Today's Market Read" (Executive Insight) + Notable Signals for the daily report
// PAGE (and email). The LLM writes PROSE ONLY — every number and brand must already
// exist in the snapshot; qaCheck rejects anything invented, off-whitelist or risky.
// Stored on today's daily_market_snapshot row; the page/email read it from there.
// This is independent of X auto-publish (which stays off).
// ─────────────────────────────────────────────────────────────────────────────

const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)

export async function generateDailyInsight(force = false): Promise<boolean> {
  if (!openrouterEnabled()) return false
  const today = utcDay()
  const row = db.prepare('SELECT ai_market_read FROM daily_market_snapshot WHERE snapshot_date=?').get(today) as { ai_market_read: string | null } | undefined
  if (!row) return false // no snapshot for today yet
  if (row.ai_market_read && !force) return false // already generated today

  const built = buildPrompt('daily_insight')
  if (!built) return false
  const gen = await generateContent(built.system, built.user)
  if (!gen?.data) {
    console.warn('[insight] model returned no usable output')
    return false
  }
  const qa = qaCheck(gen.data, built.qa)
  if (!qa.pass) {
    console.warn('[insight] QA rejected:', qa.failures.join('; '))
    return false
  }
  const mr = gen.data.market_read
  if (!mr || typeof mr !== 'object' || !(mr.what_changed || mr.why_it_matters || mr.what_to_watch)) return false
  const signals = Array.isArray(gen.data.notable_signals)
    ? gen.data.notable_signals.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 5)
    : []
  db.prepare('UPDATE daily_market_snapshot SET ai_market_read=?, ai_notable_signals=?, updated_at=? WHERE snapshot_date=?').run(
    JSON.stringify({ what_changed: String(mr.what_changed || ''), why_it_matters: String(mr.why_it_matters || ''), what_to_watch: String(mr.what_to_watch || '') }),
    JSON.stringify(signals),
    Date.now(),
    today,
  )
  console.log(`[insight] market read generated (${gen.model}) — ${signals.length} signals`)
  return true
}

export function startDailyInsight() {
  if (!openrouterEnabled()) {
    console.log('[insight] off (no OPENROUTER_API_KEY)')
    return
  }
  const run = () => generateDailyInsight().catch((e) => console.warn('[insight] failed:', (e as Error).message))
  setTimeout(run, 260_000) // after the first snapshot warms (snapshot fires ~150s)
  setInterval(run, 6 * 3600_000).unref?.() // re-check across the day (only writes when missing)
  console.log('[insight] daily market-read generator active')
}
