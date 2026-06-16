import { Worker } from 'node:worker_threads'
import { db } from './db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Pool of read-only analytics workers. `workerGet`/`workerAll` run a query in the
// least-busy worker (off the main event loop). A POOL (not a single worker) so one
// slow scan (e.g. the cold 24M-row COUNT/SUM) can't head-of-line-block every other
// query behind it. Enabled flag-gated (READ_WORKER) so it can be rolled out /
// reverted without a code change.
//
// IMPORTANT: when a worker exists but a query times out, we REJECT — we do NOT run
// the heavy query on the main thread (that fallback is what reintroduced the
// 100s event-loop freezes). The main thread only ever runs a query when the pool
// is empty (flag off, or every worker crashed) — in which case behaviour matches
// the pre-worker design.
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = Number(process.env.READ_WORKER_TIMEOUT_MS ?? 180_000)

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
interface PoolWorker {
  worker: Worker
  ready: boolean
  pending: Map<number, Pending>
  queue: unknown[]
}

let pool: PoolWorker[] = []
let nextId = 1
let enabled = false // worker mode is on (flag set) — even if the pool is momentarily empty
let target = 0

export function readWorkerEnabled(): boolean {
  return pool.length > 0
}

export function startReadWorker() {
  if (process.env.READ_WORKER !== '1') {
    console.log('[readworker] disabled (set READ_WORKER=1 to offload heavy reads)')
    return
  }
  enabled = true
  target = Math.max(1, Math.min(Number(process.env.READ_WORKER_POOL ?? 3), 4))
  for (let i = 0; i < target; i++) spawn(i === 0)
  console.log(`[readworker] starting pool of ${pool.length}/${target} read worker(s)`)
}

function spawn(announce: boolean) {
  const entry: PoolWorker = { worker: null as unknown as Worker, ready: false, pending: new Map(), queue: [] }
  try {
    const w = new Worker(new URL('./readworker-boot.mjs', import.meta.url))
    entry.worker = w
    w.on('message', (m: any) => {
      if (m?.ready) {
        entry.ready = true
        for (const q of entry.queue) w.postMessage(q)
        entry.queue.length = 0
        if (announce) console.log('[readworker] ready — heavy reads offloaded to worker pool')
        return
      }
      const p = entry.pending.get(m.id)
      if (!p) return
      entry.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.result)
      else p.reject(new Error(m.error))
    })
    w.on('error', (e) => {
      console.error('[readworker] error:', e.message)
      drop(entry)
    })
    w.on('exit', (code) => {
      if (code !== 0) console.warn(`[readworker] worker exited (${code})`)
      drop(entry)
    })
    pool.push(entry)
  } catch (e) {
    console.error('[readworker] spawn failed:', (e as Error).message)
  }
}

function drop(entry: PoolWorker) {
  pool = pool.filter((x) => x !== entry)
  for (const [, p] of entry.pending) {
    clearTimeout(p.timer)
    p.reject(new Error('worker gone'))
  }
  entry.pending.clear()
  // keep the pool populated — respawn a replacement (a crashed worker must never
  // leave the pool empty, or queries would fall back to the main thread)
  if (enabled && pool.length < target) {
    setTimeout(() => {
      if (enabled && pool.length < target) {
        console.warn(`[readworker] respawning (pool ${pool.length}/${target})`)
        spawn(false)
      }
    }, 3_000).unref?.()
  }
}

function leastBusy(): PoolWorker | null {
  if (!pool.length) return null
  let best = pool[0]
  for (const w of pool) if (w.pending.size < best.pending.size) best = w
  return best
}

function send<T>(sql: string, params: unknown[], method: 'get' | 'all'): Promise<T> {
  const entry = leastBusy()
  if (!entry) {
    // Worker mode ON but the pool is momentarily empty (all crashed, respawning):
    // REJECT rather than run a heavy scan on the main thread (that is the 90s+
    // freeze). Callers degrade gracefully — SWR serves stale, collectors skip.
    if (enabled) return Promise.reject(new Error('read worker pool unavailable'))
    // Worker mode OFF: the main connection is the intended path (pre-worker behaviour).
    const stmt = db.prepare(sql)
    return Promise.resolve((method === 'all' ? stmt.all(...params) : stmt.get(...params)) as T)
  }
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (entry.pending.has(id)) {
        entry.pending.delete(id)
        // do NOT fall back to the main thread — that reintroduces the freeze.
        reject(new Error('read worker query timeout'))
      }
    }, QUERY_TIMEOUT_MS)
    entry.pending.set(id, { resolve, reject, timer })
    const msg = { id, sql, params, method }
    if (entry.ready) entry.worker.postMessage(msg)
    else entry.queue.push(msg)
  })
}

export function workerGet<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return send<T>(sql, params, 'get')
}
export function workerAll<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return send<T[]>(sql, params, 'all')
}
