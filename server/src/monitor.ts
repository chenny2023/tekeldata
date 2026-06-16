import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { db } from './db.ts'
import { config } from './config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Built-in lightweight monitor. No external service required: it watches the few
// things that actually take this single-process service down — disk filling, the
// event loop freezing, the DB growing — and emits structured WARN/CRIT logs plus
// an optional webhook POST (Slack/Discord/generic) so failures aren't silent.
// Configure MONITOR_WEBHOOK to get pushed alerts; otherwise it just logs.
// ─────────────────────────────────────────────────────────────────────────────

const WEBHOOK = process.env.MONITOR_WEBHOOK || ''
const DISK_WARN = Number(process.env.MONITOR_DISK_WARN ?? 85) // % of volume quota
const DISK_CRIT = Number(process.env.MONITOR_DISK_CRIT ?? 92)
const LAG_WARN_MS = Number(process.env.MONITOR_LAG_WARN_MS ?? 5_000) // event-loop block
// Railway enforces the volume size as a QUOTA, not at the host-FS level — statfs()
// sees the (large) host filesystem, so we instead measure the DB files against the
// configured quota. Bump VOLUME_LIMIT_GB to match after resizing the volume.
const VOLUME_LIMIT_GB = Number(process.env.VOLUME_LIMIT_GB ?? 10)
const volumeDir = dirname(config.dbPath)

async function volumeUsedBytes(): Promise<number> {
  let total = 0
  try {
    for (const f of await readdir(volumeDir)) {
      try {
        total += (await stat(join(volumeDir, f))).size
      } catch {
        /* file may vanish mid-checkpoint */
      }
    }
  } catch {
    /* dir not ready */
  }
  return total
}

type Level = 'info' | 'warn' | 'crit'
// collapse repeat alerts so a sustained condition doesn't spam the webhook
const lastSent = new Map<string, number>()

async function notify(level: Level, key: string, msg: string, extra?: Record<string, unknown>) {
  const line = `[monitor:${level}] ${msg}`
  if (level === 'info') console.log(line)
  else console.error(line, extra ? JSON.stringify(extra) : '')
  if (!WEBHOOK || level === 'info') return
  const now = Date.now()
  if (now - (lastSent.get(key) ?? 0) < 30 * 60_000) return // ≤1 push / 30min / key
  lastSent.set(key, now)
  try {
    const text = `🔴 WCOIN ${level.toUpperCase()}: ${msg}`
    // text=Slack, content=Discord — send both keys so either webhook works
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text, ...extra }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* never let monitoring crash the process */
  }
}

// Event-loop lag sampler — a 1s interval that fires late means a synchronous
// query blocked the loop. This is the single best signal for the periodic freezes
// (heavy reads / backfill batches) that stall the dashboard and risk SIGKILL.
function startLagSampler() {
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const lag = now - last - 1_000
    last = now
    if (lag >= LAG_WARN_MS) {
      void notify('warn', 'loop-lag', `event loop blocked ~${(lag / 1000).toFixed(1)}s (a synchronous query is freezing the thread)`, { lagMs: lag })
    }
  }, 1_000).unref?.()
}

async function check() {
  try {
    const usedB = await volumeUsedBytes()
    const usedGB = +(usedB / 1e9).toFixed(2)
    const usedPct = VOLUME_LIMIT_GB > 0 ? (usedGB / VOLUME_LIMIT_GB) * 100 : 0
    const tx = (db.prepare('SELECT MAX(id) n FROM transfers').get() as any).n ?? 0
    const s = { volPct: +usedPct.toFixed(1), usedGB, limitGB: VOLUME_LIMIT_GB, tx }
    if (usedPct >= DISK_CRIT) await notify('crit', 'disk', `volume ${s.volPct}% (${usedGB}/${VOLUME_LIMIT_GB}GB) — write failures imminent, prune or resize NOW`, s)
    else if (usedPct >= DISK_WARN) await notify('warn', 'disk', `volume ${s.volPct}% (${usedGB}/${VOLUME_LIMIT_GB}GB)`, s)
    else console.log(`[monitor:info] ok volume=${s.volPct}% (${usedGB}/${VOLUME_LIMIT_GB}GB) tx=${tx}`)
  } catch (e) {
    console.warn('[monitor] check failed:', (e as Error).message)
  }
}

export function startMonitor() {
  console.log(`[monitor] active (disk warn≥${DISK_WARN}% crit≥${DISK_CRIT}%, webhook=${WEBHOOK ? 'on' : 'off'})`)
  startLagSampler()
  setTimeout(() => void check(), 30_000)
  setInterval(() => void check(), 5 * 60_000).unref?.()
}
