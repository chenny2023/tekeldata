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

// Recursive size of a path (file or directory). Directories only report their own
// inode size from stat(), so a shallow readdir+stat MISSES everything inside a
// subdirectory — e.g. litestream's `.wcoin.db-litestream/` shadow WAL. That blind
// spot let the volume fill to ~100GB while the monitor reported ~10GB (the top-level
// .db + .db-wal + .db-shm only). Walk into directories so the number is the truth.
async function pathSizeBytes(p: string): Promise<number> {
  let st
  try {
    st = await stat(p)
  } catch {
    return 0 // vanished mid-checkpoint
  }
  if (!st.isDirectory()) return st.size
  let total = 0
  let entries: string[] = []
  try {
    entries = await readdir(p)
  } catch {
    return total
  }
  for (const e of entries) total += await pathSizeBytes(join(p, e))
  return total
}

// True recursive volume usage plus a per-top-level-entry breakdown (descending),
// so the monitor log shows exactly what is eating the disk.
export async function volumeUsage(): Promise<{ total: number; breakdown: { name: string; bytes: number }[] }> {
  const breakdown: { name: string; bytes: number }[] = []
  let total = 0
  try {
    for (const f of await readdir(volumeDir)) {
      const bytes = await pathSizeBytes(join(volumeDir, f))
      total += bytes
      breakdown.push({ name: f, bytes })
    }
  } catch {
    /* dir not ready */
  }
  breakdown.sort((a, b) => b.bytes - a.bytes)
  return { total, breakdown }
}

async function volumeUsedBytes(): Promise<number> {
  return (await volumeUsage()).total
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
    const text = `🔴 Tekel Data ${level.toUpperCase()}: ${msg}`
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

// format bytes compactly for the breakdown line
const gb = (b: number) => (b / 1e9).toFixed(2) + 'GB'

async function check() {
  try {
    const { total: usedB, breakdown } = await volumeUsage()
    const usedGB = +(usedB / 1e9).toFixed(2)
    const usedPct = VOLUME_LIMIT_GB > 0 ? (usedGB / VOLUME_LIMIT_GB) * 100 : 0
    const tx = (db.prepare('SELECT MAX(id) n FROM transfers').get() as any).n ?? 0
    // top entries by size — reveals whether it's the .db, the WAL, or a subdir
    // (e.g. litestream's shadow dir) that is actually consuming the volume.
    const top = breakdown.slice(0, 6).map((e) => `${e.name}=${gb(e.bytes)}`).join(' ')
    const s = { volPct: +usedPct.toFixed(1), usedGB, limitGB: VOLUME_LIMIT_GB, tx, top: breakdown.slice(0, 6) }
    if (usedPct >= DISK_CRIT) await notify('crit', 'disk', `volume ${s.volPct}% (${usedGB}/${VOLUME_LIMIT_GB}GB) — write failures imminent, prune or resize NOW · ${top}`, s)
    else if (usedPct >= DISK_WARN) await notify('warn', 'disk', `volume ${s.volPct}% (${usedGB}/${VOLUME_LIMIT_GB}GB) · ${top}`, s)
    else console.log(`[monitor:info] ok volume=${s.volPct}% (${usedGB}/${VOLUME_LIMIT_GB}GB) tx=${tx} · ${top}`)
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
