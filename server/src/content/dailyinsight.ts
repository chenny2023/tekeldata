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

// Safety net: the model occasionally echoes a raw input field name (e.g.
// "net_flow_24h swung to …"). Rewrite any snake_case identifier to spaced words so the
// published read always reads naturally, regardless of prompt compliance.
function naturalize(s: string): string {
  return s.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (m) => m.replace(/_/g, ' '))
}

export interface InsightResult {
  status: 'ok' | 'disabled' | 'no-snapshot' | 'exists' | 'no-prompt' | 'no-output' | 'qa-rejected' | 'invalid-shape'
  model?: string
  failures?: string[]
  retried?: boolean
  data?: { market_read: any; notable_signals: string[] }
}

// Core generator (used by the scheduler and the diag). write=false makes it a dry
// preview that returns the model output + QA outcome without persisting.
export async function runInsight(opts: { force?: boolean; write?: boolean } = {}): Promise<InsightResult> {
  if (!openrouterEnabled()) return { status: 'disabled' }
  const today = utcDay()
  const row = db.prepare('SELECT ai_market_read FROM daily_market_snapshot WHERE snapshot_date=?').get(today) as { ai_market_read: string | null } | undefined
  if (!row) return { status: 'no-snapshot' }
  if (row.ai_market_read && !opts.force) return { status: 'exists' }

  const built = buildPrompt('daily_insight')
  if (!built) return { status: 'no-prompt' }
  let gen = await generateContent(built.system, built.user)
  if (!gen?.data) return { status: 'no-output' }
  let qa = qaCheck(gen.data, built.qa)
  let retried = false
  if (!qa.pass) {
    // The deeper analytical prompt occasionally cites a figure (usually a $ change it
    // estimated) not in the data whitelist → qaCheck rejects the whole insight. Retry
    // ONCE with explicit feedback so the analytical read publishes instead of a stale one.
    const bad = qa.failures.filter((f) => f.startsWith('unverified number')).join('; ')
    if (bad) {
      retried = true
      const fix =
        built.user +
        `\n\nCORRECTION: your previous draft used figures NOT present in the data (${bad}). Rewrite using ONLY figures exactly as they appear in the input above — never compute, round or estimate a number. Same JSON schema.`
      const retry = await generateContent(built.system, fix)
      if (retry?.data) {
        gen = retry
        qa = qaCheck(retry.data, built.qa)
      }
    }
    if (!qa.pass) return { status: 'qa-rejected', failures: qa.failures, retried, data: gen.data }
  }
  const mr = gen.data.market_read
  if (!mr || typeof mr !== 'object' || !(mr.what_changed || mr.why_it_matters || mr.what_to_watch)) return { status: 'invalid-shape', data: gen.data }
  const signals = (Array.isArray(gen.data.notable_signals) ? gen.data.notable_signals : [])
    .filter((x: any) => typeof x === 'string' && x.trim())
    .map((x: string) => naturalize(x))
    .slice(0, 5)
  const market_read = {
    what_changed: naturalize(String(mr.what_changed || '')),
    why_it_matters: naturalize(String(mr.why_it_matters || '')),
    what_to_watch: naturalize(String(mr.what_to_watch || '')),
  }
  if (opts.write !== false) {
    db.prepare('UPDATE daily_market_snapshot SET ai_market_read=?, ai_notable_signals=?, updated_at=? WHERE snapshot_date=?').run(
      JSON.stringify(market_read),
      JSON.stringify(signals),
      Date.now(),
      today,
    )
    console.log(`[insight] market read generated (${gen.model})${retried ? ' [retry]' : ''} — ${signals.length} signals`)
  }
  return { status: 'ok', model: gen.model, retried, data: { market_read, notable_signals: signals } }
}

export async function generateDailyInsight(force = false): Promise<boolean> {
  const r = await runInsight({ force, write: true })
  if (r.status === 'qa-rejected') console.warn('[insight] QA rejected (after retry):', (r.failures || []).join('; '))
  return r.status === 'ok'
}

export function startDailyInsight() {
  if (!openrouterEnabled()) {
    console.log('[insight] off (no OPENROUTER_API_KEY)')
    return
  }
  const run = (force = false) => generateDailyInsight(force).catch((e) => console.warn('[insight] failed:', (e as Error).message))
  // First run after a (re)deploy FORCES a refresh so today's insight always reflects the
  // current data basis (e.g. a credibility fix to the payload) instead of a stale read
  // generated earlier in the day under the old code. Later re-checks only fill if missing.
  setTimeout(() => run(true), 260_000) // after the first snapshot warms (snapshot fires ~150s)
  setInterval(() => run(false), 6 * 3600_000).unref?.() // re-check across the day (only writes when missing)
  console.log('[insight] daily market-read generator active')
}
