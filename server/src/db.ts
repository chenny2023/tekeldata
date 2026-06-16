import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.ts'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
// Cap the WAL so checkpoints truncate it back to ≤64MB instead of letting it
// balloon and devour free disk (a bloated WAL was compounding disk-I/O errors
// on the size-limited volume). Checkpoint aggressively too.
db.pragma('journal_size_limit = 67108864')
// When litestream is backing up, it owns checkpointing (autocheckpoint=0) so it
// never loses un-shipped WAL frames; otherwise the app self-checkpoints to cap WAL.
db.pragma(`wal_autocheckpoint = ${config.backupActive ? 0 : 1000}`)

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
CREATE INDEX IF NOT EXISTS idx_transfers_counterparty ON transfers(counterparty);

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

CREATE TABLE IF NOT EXISTS verification_codes (
  email      TEXT NOT NULL,                 -- lowercased recipient
  code       TEXT NOT NULL,                 -- 6-digit one-time code
  expires_at INTEGER NOT NULL,              -- ms epoch
  attempts   INTEGER NOT NULL DEFAULT 0,    -- failed verify attempts (lockout)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vcodes_email ON verification_codes(email, created_at DESC);

CREATE TABLE IF NOT EXISTS votes (
  user_id    INTEGER NOT NULL,
  watch_id   INTEGER NOT NULL,
  vote       INTEGER NOT NULL,            -- +1 trust / -1 distrust
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, watch_id)
);

CREATE TABLE IF NOT EXISTS prices (
  asset TEXT NOT NULL,                        -- 'SOL'
  day   INTEGER NOT NULL,                     -- UTC day index (floor(ts/86400000))
  usd   REAL NOT NULL,                        -- daily close
  PRIMARY KEY(asset, day)
);

CREATE TABLE IF NOT EXISTS risk_addresses (
  address  TEXT PRIMARY KEY,                 -- ETH lowercased, TRON/SOL base58
  chain    TEXT NOT NULL,
  category TEXT NOT NULL,                     -- 'sanctioned' | 'mixer'
  source   TEXT NOT NULL,                     -- 'OFAC'
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_flags (
  watch_id  INTEGER PRIMARY KEY,
  hits      INTEGER NOT NULL,                 -- transfers touching a risk address
  usd       REAL NOT NULL,                    -- total value of those transfers
  last_ts   INTEGER NOT NULL,
  addresses TEXT,                             -- JSON sample of risk addresses touched
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  brand_key  TEXT NOT NULL,                 -- normalized brand key
  source     TEXT NOT NULL,                 -- 'casino.guru'
  score      REAL NOT NULL,                 -- safety index / rating
  score_max  REAL NOT NULL DEFAULT 10,
  url        TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(brand_key, source)
);

-- Casino directory: a broad catalogue of casinos vetted for outreach. Tiered
-- inclusion — every reachable site is recorded, with flags for whether it has an
-- accessible X account and a real (MX-valid) email. The contact data feeds future
-- partnership email outreach.
CREATE TABLE IF NOT EXISTS casino_directory (
  domain      TEXT PRIMARY KEY,         -- normalized registrable domain (dedupe key)
  name        TEXT NOT NULL,
  website     TEXT NOT NULL,
  twitter     TEXT,                      -- X handle (without @) if found
  email       TEXT,                      -- contact email if found
  site_ok     INTEGER NOT NULL DEFAULT 0,-- website loads (HTTP 200, not parked)
  x_ok        INTEGER NOT NULL DEFAULT 0,-- has an X account
  email_ok    INTEGER NOT NULL DEFAULT 0,-- has a real email (domain MX-valid)
  source      TEXT,                      -- 'roster' | 'casino.guru' | 'trustpilot'
  status      TEXT,                      -- last check note (ok / http code / error)
  tp_rating   REAL,                      -- Trustpilot TrustScore (★/5) from the casino category sweep
  tp_reviews  INTEGER,                   -- Trustpilot review count
  last_checked INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_directory_checked ON casino_directory(last_checked);

-- casino.guru spider queue: discovered review-page slugs to crawl. Seeded from the
-- roster, then each fetched review page yields more "*-casino-review" slugs, so the
-- directory grows to thousands organically without needing casino.guru's master list.
CREATE TABLE IF NOT EXISTS crawl_queue (
  slug     TEXT PRIMARY KEY,
  done     INTEGER NOT NULL DEFAULT 0,    -- 0 pending, 1 fetched, 2 dead (404/no-data)
  found_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawl_done ON crawl_queue(done);

-- Arkham on-chain attribution per casino: maps a casino → its Arkham "gambling"
-- entity, then pulls all-chain reserves (portfolio) + volume. Expands transaction
-- coverage far beyond what we index ourselves (Arkham attributes Tron/BTC/EVM…).
CREATE TABLE IF NOT EXISTS arkham_casino (
  key          TEXT PRIMARY KEY,        -- roster slug (stable local id)
  name         TEXT NOT NULL,
  domain       TEXT,                    -- casino website domain, for match validation
  entity_id    TEXT,                    -- Arkham entity id; '' = searched, no gambling match
  entity_type  TEXT,
  reserves_usd REAL,                    -- Σ portfolio USD (mainstream tokens only)
  volume7d_usd REAL,                    -- Σ transfer USD over 7d (mainstream tokens) — phase 2
  resolved_at  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  addr_harvested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_arkham_updated ON arkham_casino(updated_at);

-- reserve snapshots over time → solvency trend + drop detection (proof-of-reserves
-- is only as good as its trend: a casino draining its wallets is the real signal).
CREATE TABLE IF NOT EXISTS arkham_reserve_history (
  key      TEXT NOT NULL,
  reserves_usd REAL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arkres_key_ts ON arkham_reserve_history(key, ts);

-- On-chain iGaming protocols (prediction markets, yield lotteries, on-chain books)
-- from DefiLlama. Expands the layer beyond comprehensive casinos to the whole
-- on-chain betting landscape — all transparent, verifiable TVL/flows.
CREATE TABLE IF NOT EXISTS onchain_protocol (
  slug       TEXT PRIMARY KEY,          -- DefiLlama slug
  name       TEXT NOT NULL,
  category   TEXT,                       -- Prediction Market | Yield Lottery | …
  chains     TEXT,                       -- comma-separated
  tvl        REAL,
  change_1d  REAL,
  change_7d  REAL,
  mcap       REAL,
  url        TEXT,
  twitter    TEXT,
  logo       TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_protocol_tvl ON onchain_protocol(tvl);

-- Top prediction markets (Polymarket) — the live "what the world is betting on"
-- feed: question, traded volume, current odds. Rich, unique iGaming-layer content.
CREATE TABLE IF NOT EXISTS prediction_market (
  id         TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  volume     REAL,
  liquidity  REAL,
  outcomes   TEXT,                       -- JSON array
  prices     TEXT,                       -- JSON array (current odds, aligned to outcomes)
  end_date   TEXT,
  category   TEXT,
  url        TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prediction_vol ON prediction_market(volume);

-- daily solvency snapshots per casino brand, for the reserve-adequacy trend.
-- coverage = reserves / weekly-outflow (≈ weeks of withdrawals the reserves cover)
CREATE TABLE IF NOT EXISTS reserve_history (
  brand_key  TEXT NOT NULL,
  day        INTEGER NOT NULL,            -- floor(ts/86400000)
  reserves   REAL NOT NULL,
  outflow7d  REAL NOT NULL,
  coverage   REAL NOT NULL,               -- reserves / outflow7d (weeks)
  ts         INTEGER NOT NULL,
  PRIMARY KEY(brand_key, day)
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
  // Trustpilot consumer signal merged onto each directory casino (per-domain /review/ enricher)
  'ALTER TABLE casino_directory ADD COLUMN tp_rating REAL',
  'ALTER TABLE casino_directory ADD COLUMN tp_reviews INTEGER',
  'ALTER TABLE casino_directory ADD COLUMN tp_checked INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE arkham_casino ADD COLUMN domain TEXT',
  'ALTER TABLE arkham_casino ADD COLUMN addr_harvested INTEGER NOT NULL DEFAULT 0',
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
