import { db } from './db.ts'
import { brandKey } from './casinometa.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Risk-event registry. Two layers — both neutral, both sourced:
//   • onchain_signal — auto-derived from OUR observed data (reserve drops, coverage
//     under review). 100% defensible; no third-party claim, no verdict.
//   • incident — admin-curated public events, each with a required source_url (added
//     via the admin API in api.ts). Surfaced read-only here + on casino/registry pages.
// Detector is cheap (reserve_history + data_quality_issue only — no heavy aggregate).
// ─────────────────────────────────────────────────────────────────────────────

const fmtUsd = (n: number) => {
  const a = Math.abs(n || 0)
  return a >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n || 0)
}
const labelOf = (key: string): string => {
  const row = db.prepare('SELECT canonical_name FROM casino_brand WHERE brand_id=?').get(key) as { canonical_name: string } | undefined
  return row?.canonical_name || key
}

export interface RiskEvent {
  id: number
  brand_key: string
  brand_label: string | null
  kind: string
  category: string
  severity: string
  title: string
  detail: string | null
  source_url: string | null
  operator_response: string | null
  status: string
  observed_at: number
}

// upsert an open onchain_signal for (brand_key, category) — update if one is open, else insert
function upsertSignal(brandKey: string, brandLabel: string, category: string, severity: string, title: string, detail: string, observedAt: number) {
  const now = Date.now()
  const open = db.prepare("SELECT id FROM risk_event WHERE brand_key=? AND kind='onchain_signal' AND category=? AND status='open'").get(brandKey, category) as { id: number } | undefined
  if (open) {
    db.prepare('UPDATE risk_event SET brand_label=?, severity=?, title=?, detail=?, observed_at=?, updated_at=? WHERE id=?').run(brandLabel, severity, title, detail, observedAt, now, open.id)
  } else {
    db.prepare("INSERT INTO risk_event(brand_key, brand_label, kind, category, severity, title, detail, status, observed_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,'open',?,?,?)").run(
      brandKey,
      brandLabel,
      'onchain_signal',
      category,
      severity,
      title,
      detail,
      observedAt,
      now,
      now,
    )
  }
}
function resolveSignal(brandKey: string, category: string) {
  db.prepare("UPDATE risk_event SET status='resolved', updated_at=? WHERE brand_key=? AND kind='onchain_signal' AND category=? AND status='open'").run(Date.now(), brandKey, category)
}

const DROP_WATCH = -0.25 // reserves down ≥25% over ~7d → a watch-level signal
const DROP_ELEVATED = -0.4

function detect(): void {
  const now = Date.now()
  // 1) reserve_drop — per brand, current vs ~7d-ago reserves from reserve_history
  const keys = db.prepare('SELECT DISTINCT brand_key FROM reserve_history').all() as { brand_key: string }[]
  for (const { brand_key } of keys) {
    const rows = db.prepare('SELECT reserves, day FROM reserve_history WHERE brand_key=? ORDER BY day DESC LIMIT 9').all(brand_key) as { reserves: number; day: number }[]
    if (rows.length < 2) continue
    const current = rows[0].reserves
    const prior = rows[rows.length - 1].reserves
    if (!(prior > 0)) continue
    const pct = (current - prior) / prior
    if (pct <= DROP_WATCH) {
      const label = labelOf(brand_key)
      const sev = pct <= DROP_ELEVATED ? 'elevated' : 'watch'
      upsertSignal(brand_key, label, 'reserve_drop', sev, `${label} tracked reserves down ${(pct * 100).toFixed(1)}% (~7d)`, `Observed all-chain tracked reserves moved from ~${fmtUsd(prior)} to ~${fmtUsd(current)} over the recent window. Observed wallet data with partial coverage — not a statement on solvency, safety or legality.`, now)
    } else if (pct > -0.1) {
      resolveSignal(brand_key, 'reserve_drop') // recovered → close the open signal
    }
  }
  // 2) coverage_under_review — from today's data-quality log (snapshot flags these)
  const today = new Date(now).toISOString().slice(0, 10)
  const flagged = db.prepare("SELECT DISTINCT related_brand_id FROM data_quality_issue WHERE issue_type='reserve_coverage_under_review' AND date=?").all(today) as { related_brand_id: string }[]
  const flaggedSet = new Set(flagged.map((f) => (f.related_brand_id || '').toLowerCase()))
  for (const f of flagged) {
    const lbl = f.related_brand_id
    if (!lbl) continue
    const key = brandKey(lbl) // canonical key so it links to the same casino page
    upsertSignal(key, lbl, 'coverage_under_review', 'info', `${lbl} reserve coverage under review`, `Reserve-coverage figures for ${lbl} are anomalous (e.g. an implausible coverage ratio) and held for review rather than shown as a percentage. Not a solvency or safety statement.`, now)
  }
  // resolve coverage signals no longer flagged today
  const openCov = db.prepare("SELECT id, brand_label FROM risk_event WHERE kind='onchain_signal' AND category='coverage_under_review' AND status='open'").all() as { id: number; brand_label: string }[]
  for (const o of openCov) if (!flaggedSet.has((o.brand_label || '').toLowerCase())) db.prepare("UPDATE risk_event SET status='resolved', updated_at=? WHERE id=?").run(now, o.id)

  const n = (db.prepare("SELECT COUNT(*) n FROM risk_event WHERE status='open'").get() as any).n
  console.log(`[risk] registry refreshed — ${n} open events`)
}

// open events for one brand (signals + curated incidents) — newest first
export function brandRiskEvents(brandKey: string): RiskEvent[] {
  return db.prepare("SELECT * FROM risk_event WHERE brand_key=? AND status IN ('open','disputed') ORDER BY observed_at DESC LIMIT 12").all(brandKey) as RiskEvent[]
}
// recent open events across all brands — for the /risk registry index
export function recentRiskEvents(limit = 60): RiskEvent[] {
  return db.prepare("SELECT * FROM risk_event WHERE status IN ('open','disputed') ORDER BY observed_at DESC LIMIT ?").all(limit) as RiskEvent[]
}

export function startRiskEvents() {
  const run = () => {
    try {
      detect()
    } catch (e) {
      console.warn('[risk] detect failed:', (e as Error).message)
    }
  }
  setTimeout(run, 320_000) // after reserve history + snapshot warm
  setInterval(run, 6 * 3600_000).unref?.()
  console.log('[risk] risk-event registry active')
}
