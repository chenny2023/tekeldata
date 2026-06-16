import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { config } from './config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Read-only analytics worker. Opens its OWN connection to the same WAL database
// (concurrent readers are safe) and runs heavy queries OFF the main event loop —
// so the API, the Railway healthcheck, and SIGTERM are never blocked by a
// multi-second scan (the root cause of dashboard stalls + deploy "Crashed").
// It is a thin generic SQL runner; the main thread sends the exact (own-code) SQL
// + params, so there is no injection surface. Does NOT import db.ts (which would
// run write-DDL migrations) — it opens strictly read-only.
// ─────────────────────────────────────────────────────────────────────────────

if (!parentPort) throw new Error('readworker must run as a worker thread')
const port = parentPort

// surface worker-side failures instead of dying silently
process.on('uncaughtException', (e) => console.error('[readworker:thread] uncaught:', (e as Error)?.stack || e))
process.on('unhandledRejection', (e) => console.error('[readworker:thread] rejection:', e))

let db: import('better-sqlite3').Database
try {
  db = new Database(config.dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = true')
  db.pragma('busy_timeout = 5000')
} catch (e) {
  console.error('[readworker:thread] failed to open DB:', (e as Error).message)
  throw e // exit → main respawns
}

// cache prepared statements — the maintenance loop sends the same SQL per watch_id
const cache = new Map<string, import('better-sqlite3').Statement>()
const prep = (sql: string) => {
  let s = cache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    cache.set(sql, s)
  }
  return s
}

type Job = { id: number; sql: string; params?: unknown[]; method?: 'get' | 'all' }
port.on('message', (m: Job) => {
  try {
    const stmt = prep(m.sql)
    const result = m.method === 'all' ? stmt.all(...(m.params ?? [])) : stmt.get(...(m.params ?? []))
    port.postMessage({ id: m.id, ok: true, result })
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: (e as Error).message })
  }
})

port.postMessage({ ready: true })
