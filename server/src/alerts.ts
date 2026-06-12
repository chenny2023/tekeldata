import { db } from './db.ts'
import { bus, TransferEvent } from './bus.ts'
import { webFetch } from './net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Alert engine — turns the dashboard from "look" into "be told". Operators set
// rules; the engine evaluates them against the live transfer stream (whale
// rules) and on a timer (net-flow / reserve-drop rules), writing alert_events
// and optionally POSTing a webhook. This is the retention hook: a competitor's
// net outflow spiking (possible bank-run / exit) or a whale draining a watched
// wallet is exactly what a casino operator pays to be notified about.
// ─────────────────────────────────────────────────────────────────────────────

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO alert_events(rule_id, user_id, kind, title, detail, usd, entity, chain, tx_hash, dedupe, ts)
  VALUES(@rule_id, @user_id, @kind, @title, @detail, @usd, @entity, @chain, @tx_hash, @dedupe, @ts)
`)

interface Rule {
  id: number
  user_id: number
  kind: string
  scope: string
  scope_label: string | null
  threshold: number
  window_h: number
  webhook: string | null
}

function activeRules(kind: string): Rule[] {
  return db.prepare('SELECT * FROM alert_rules WHERE active=1 AND kind=?').all(kind) as Rule[]
}

async function fireWebhook(url: string, payload: unknown) {
  try {
    await webFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* webhook delivery is best-effort */
  }
}

function emit(rule: Rule, ev: { title: string; detail?: string; usd?: number; entity?: string; chain?: string; tx_hash?: string; dedupe: string }) {
  const row = {
    rule_id: rule.id,
    user_id: rule.user_id,
    kind: rule.kind,
    title: ev.title,
    detail: ev.detail ?? null,
    usd: ev.usd ?? null,
    entity: ev.entity ?? null,
    chain: ev.chain ?? null,
    tx_hash: ev.tx_hash ?? null,
    dedupe: ev.dedupe,
    ts: Date.now(),
  }
  const r = insertEvent.run(row)
  if (r.changes > 0) {
    bus.emit('alert', row)
    if (rule.webhook) fireWebhook(rule.webhook, row)
  }
}

// ── whale rules — driven by the live transfer stream ─────────────────────────
function onTransfer(t: TransferEvent) {
  const rules = activeRules('whale')
  if (rules.length === 0) return
  for (const rule of rules) {
    if (t.usd < rule.threshold) continue
    if (rule.scope !== 'all' && String(t.watch_id) !== rule.scope) continue
    emit(rule, {
      title: `🐋 ${t.label}: ${t.direction === 'in' ? 'deposit' : 'withdrawal'} ${fmtUsd(t.usd)}`,
      detail: `${t.token} on ${t.chain} · counterparty ${t.counterparty.slice(0, 10)}…`,
      usd: t.usd,
      entity: t.label,
      chain: t.chain,
      tx_hash: t.tx_hash,
      dedupe: `${t.tx_hash}:${t.watch_id}`,
    })
  }
}

// ── periodic rules — net-flow (and reserve-drop) over a window ───────────────
function evalNetflow() {
  const rules = activeRules('netflow')
  for (const rule of rules) {
    const since = Date.now() - rule.window_h * 3_600_000
    const where = rule.scope === 'all' ? '' : 'AND watch_id = ' + Number(rule.scope)
    const rows = db
      .prepare(
        `SELECT watch_id, label, chain,
                SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) -
                SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) AS netOut
         FROM transfers WHERE ts >= ? ${where} GROUP BY watch_id`,
      )
      .all(since) as { watch_id: number; label: string; chain: string; netOut: number }[]
    const bucket = Math.floor(Date.now() / (rule.window_h * 3_600_000)) // one alert per window
    for (const r of rows) {
      if (r.netOut < rule.threshold) continue
      emit(rule, {
        title: `⚠️ ${r.label}: net outflow ${fmtUsd(r.netOut)} in ${rule.window_h}h`,
        detail: `Sustained withdrawals exceeding the $${fmtNum(rule.threshold)} threshold — possible liquidity stress.`,
        usd: r.netOut,
        entity: r.label,
        chain: r.chain,
        dedupe: `${r.watch_id}:${bucket}`,
      })
    }
  }
}

function evalReserveDrop() {
  const rules = activeRules('reserve_drop')
  if (rules.length === 0) return
  for (const rule of rules) {
    const where = rule.scope === 'all' ? '' : 'AND w.id = ' + Number(rule.scope)
    const rows = db
      .prepare(
        `SELECT w.id, w.label, w.chain, b.usd FROM watchlist w JOIN balances b ON b.watch_id=w.id WHERE w.active=1 ${where}`,
      )
      .all() as { id: number; label: string; chain: string; usd: number }[]
    for (const r of rows) {
      const key = `alert:resv:${r.id}`
      const prev = Number(db.prepare('SELECT value FROM sync_state WHERE key=?').get(key) as any)?.value ?? 0
      if (prev > 0 && r.usd < prev) {
        const dropPct = ((prev - r.usd) / prev) * 100
        if (dropPct >= rule.threshold) {
          const bucket = Math.floor(Date.now() / 3_600_000)
          emit(rule, {
            title: `📉 ${r.label}: reserves down ${dropPct.toFixed(1)}%`,
            detail: `On-chain reserves fell from ${fmtUsd(prev)} to ${fmtUsd(r.usd)}.`,
            usd: r.usd,
            entity: r.label,
            chain: r.chain,
            dedupe: `${r.id}:${bucket}`,
          })
        }
      }
      // track a slow high-water mark so transient dips don't reset the baseline
      db.prepare('INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(Math.max(prev * 0.98, r.usd)))
    }
  }
}

// local formatters (avoid importing the frontend's)
function fmtUsd(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}
function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

export function startAlerts() {
  bus.on('transfer', onTransfer)
  const loop = () => {
    try { evalNetflow() } catch (e) { console.warn('[alerts] netflow', (e as Error).message) }
    try { evalReserveDrop() } catch (e) { console.warn('[alerts] reserve', (e as Error).message) }
    setTimeout(loop, 60_000)
  }
  setTimeout(loop, 45_000)
  console.log('[alerts] engine active (whale stream + periodic net-flow / reserve checks)')
}
