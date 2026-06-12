import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.ts'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chain      TEXT NOT NULL,             -- 'ETH' | 'TRON'
  address    TEXT NOT NULL,             -- ETH lowercased, TRON base58
  label      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'casino', -- casino | exchange | whale | other
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(chain, address)
);

CREATE TABLE IF NOT EXISTS transfers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chain      TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  log_index  INTEGER NOT NULL DEFAULT 0,
  token      TEXT NOT NULL,
  from_addr  TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  counterparty TEXT NOT NULL,           -- the non-watched side
  amount     REAL NOT NULL,
  usd        REAL NOT NULL,
  watch_id   INTEGER NOT NULL,
  label      TEXT NOT NULL,
  category   TEXT NOT NULL,
  direction  TEXT NOT NULL,             -- 'in' (deposit) | 'out' (withdrawal)
  block      INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL,          -- ms epoch
  UNIQUE(chain, tx_hash, log_index, watch_id)
);
CREATE INDEX IF NOT EXISTS idx_transfers_ts ON transfers(ts DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_watch ON transfers(watch_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_chain_ts ON transfers(chain, ts DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_usd ON transfers(usd DESC, ts DESC);

CREATE TABLE IF NOT EXISTS balances (
  watch_id   INTEGER PRIMARY KEY,
  usd        REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS streamers (
  id          TEXT PRIMARY KEY,
  handle      TEXT NOT NULL,
  platform    TEXT NOT NULL,
  viewers     INTEGER NOT NULL DEFAULT 0,
  live        INTEGER NOT NULL DEFAULT 0,
  title       TEXT,
  game        TEXT,
  thumbnail   TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS streamer_roster (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT NOT NULL,              -- 'Kick' | 'Twitch'
  slug       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(platform, slug)
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'casino',  -- casino | streamer | admin
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  user_id    INTEGER NOT NULL,
  watch_id   INTEGER NOT NULL,
  vote       INTEGER NOT NULL,            -- +1 trust / -1 distrust
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, watch_id)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,                 -- 'whale' | 'netflow' | 'reserve_drop'
  scope       TEXT NOT NULL DEFAULT 'all',   -- 'all' | watch_id (number, as text)
  scope_label TEXT,                          -- display name of the target
  threshold   REAL NOT NULL,                 -- USD (whale/netflow) or percent (reserve_drop)
  window_h    INTEGER NOT NULL DEFAULT 24,
  webhook     TEXT,                          -- optional POST endpoint
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id   INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  title     TEXT NOT NULL,
  detail    TEXT,
  usd       REAL,
  entity    TEXT,
  chain     TEXT,
  tx_hash   TEXT,
  dedupe    TEXT,                            -- collapses repeat firings
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_events_user ON alert_events(user_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_dedupe ON alert_events(rule_id, dedupe);

CREATE TABLE IF NOT EXISTS mentions (
  id         TEXT PRIMARY KEY,            -- source post id
  watch_label TEXT NOT NULL,              -- entity label the mention matched
  source     TEXT NOT NULL,               -- 'reddit'
  title      TEXT,
  url        TEXT,
  score      INTEGER NOT NULL DEFAULT 0,  -- source upvotes
  sentiment  REAL NOT NULL DEFAULT 0,     -- lexicon score -1..1
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mentions_label ON mentions(watch_label, ts DESC);
`)

// additive migrations for DBs created before these columns existed
for (const ddl of [
  'ALTER TABLE streamers ADD COLUMN followers INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE streamers ADD COLUMN affiliation TEXT',
]) {
  try {
    db.exec(ddl)
  } catch {
    /* column already exists */
  }
}

// ── sync_state helpers ────────────────────────────────────────────────────────
const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?')
const setState = db.prepare(
  'INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
)
export function stateGet(key: string): string | null {
  const row = getState.get(key) as { value: string } | undefined
  return row?.value ?? null
}
export function stateSet(key: string, value: string | number) {
  setState.run(key, String(value))
}

// ── prepared statements reused by collectors/api ──────────────────────────────
export const stmt = {
  insertTransfer: db.prepare(`
    INSERT OR IGNORE INTO transfers
      (chain, tx_hash, log_index, token, from_addr, to_addr, counterparty,
       amount, usd, watch_id, label, category, direction, block, ts)
    VALUES
      (@chain, @tx_hash, @log_index, @token, @from_addr, @to_addr, @counterparty,
       @amount, @usd, @watch_id, @label, @category, @direction, @block, @ts)
  `),
  activeWatch: db.prepare('SELECT * FROM watchlist WHERE active = 1'),
  watchByChain: db.prepare('SELECT * FROM watchlist WHERE active = 1 AND chain = ?'),
  upsertBalance: db.prepare(`
    INSERT INTO balances(watch_id, usd, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(watch_id) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at
  `),
  addWatch: db.prepare(`
    INSERT OR IGNORE INTO watchlist(chain, address, label, category, active, created_at)
    VALUES(?, ?, ?, ?, 1, ?)
  `),
}

export interface WatchRow {
  id: number
  chain: 'ETH' | 'TRON'
  address: string
  label: string
  category: string
  active: number
  created_at: number
}
