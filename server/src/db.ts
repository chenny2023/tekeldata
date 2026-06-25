import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.ts'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
// Wait (retry) up to 5s for a held write lock instead of failing immediately with
// SQLITE_BUSY. Under boot-window contention (collectors + SEO regen + a litestream
// checkpoint) a small write — e.g. a public /api/submit INSERT — was 500ing with
// "database is locked"; with a busy timeout it transparently waits for the lock.
db.pragma('busy_timeout = 5000')
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

-- Arkham-attributed 7d volume PER CHAIN per casino entity. Our own indexer under-
-- captures Tron-USDT + BTC casino flows (the chain distribution showed ETH ~96%);
-- Arkham attributes those chains directly, so this is the BTC/Tron attribution source.
CREATE TABLE IF NOT EXISTS arkham_chain_volume (
  key   TEXT NOT NULL,                  -- arkham_casino.key
  chain TEXT NOT NULL,                  -- ETH | TRON | BTC | SOL | BASE | ...
  vol7d REAL NOT NULL,                  -- Σ transfer USD on this chain over 7d
  ts    INTEGER NOT NULL,
  PRIMARY KEY(key, chain)
);
CREATE INDEX IF NOT EXISTS idx_arkham_chainvol ON arkham_chain_volume(chain);

-- Per-chain RESERVES from Arkham's (working, non-429) portfolio endpoint — the
-- authoritative cross-chain split (BTC/Tron/SOL included) that the daily chain
-- distribution uses. Reserves can't be wash-traded, unlike indexed volume.
CREATE TABLE IF NOT EXISTS arkham_chain_reserves (
  key   TEXT NOT NULL,                  -- arkham_casino.key
  chain TEXT NOT NULL,                  -- ETH | TRON | BTC | SOL | BASE | ...
  usd   REAL NOT NULL,                  -- Σ mainstream reserve USD on this chain
  ts    INTEGER NOT NULL,
  PRIMARY KEY(key, chain)
);
CREATE INDEX IF NOT EXISTS idx_arkham_chainres ON arkham_chain_reserves(chain);

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

-- 1.0 content layer: precomputed daily market snapshot (homepage + daily email +
-- SEO data source). Generated in the background off the read worker; the front end
-- reads THIS, never raw transfers. One row per UTC day, upserted through the day.
CREATE TABLE IF NOT EXISTS daily_market_snapshot (
  snapshot_date      TEXT PRIMARY KEY,        -- YYYY-MM-DD (UTC)
  tracked_volume_24h REAL,
  net_flow_24h       REAL,                    -- casino inflow - outflow, 24h
  active_casinos     INTEGER,
  active_chains      INTEGER,
  live_streamers     INTEGER,
  reserves_total     REAL,
  reserve_change_7d  REAL,                    -- fraction
  payload_json       TEXT NOT NULL,           -- movers / whales / reserves / chains
  confidence_level   TEXT NOT NULL DEFAULT 'medium',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 1.0 email digest subscribers (frequency preference inline for simplicity).
-- The double-opt-in confirm reuses the existing verification_codes table.
CREATE TABLE IF NOT EXISTS email_subscriber (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|active|unsubscribed|bounced
  frequency         TEXT NOT NULL DEFAULT 'daily',    -- daily|weekly
  unsubscribe_token TEXT NOT NULL UNIQUE,
  verified_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 1.0 daily digest: one row per send date (the rendered email), + a per-recipient
-- send log whose UNIQUE(digest_id, subscriber_id) guarantees no double-send.
CREATE TABLE IF NOT EXISTS email_digest (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date TEXT NOT NULL UNIQUE,   -- YYYY-MM-DD (UTC)
  subject     TEXT,
  html        TEXT,
  text        TEXT,
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft|sent
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_digest_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_id     INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  send_status   TEXT NOT NULL,         -- sent|failed
  last_error    TEXT,
  sent_at       INTEGER,
  UNIQUE(digest_id, subscriber_id)
);

-- Phase 2 SEO: pre-rendered, stored HTML for data-led landing pages
-- (/casino/{slug}, /rankings/{slug}, /chains/{slug}, /methodology/{topic}).
-- Served by Fastify ahead of the SPA so crawlers + AI answer engines get real,
-- indexable content. Regenerated from the warm aggregate cache on a timer — the
-- request path is a single primary-key read, never a heavy query.
CREATE TABLE IF NOT EXISTS seo_page (
  path        TEXT PRIMARY KEY,        -- e.g. /casino/stake
  kind        TEXT NOT NULL,           -- casino|rankings|chains|methodology
  title       TEXT,
  description TEXT,
  html        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Per-user personal watchlist (favourites). Distinct from the global watchlist
-- (the operator-curated set of tracked addresses): this is each signed-in user's
-- own list of casinos they follow, keyed by brandKey so it survives wallet churn.
CREATE TABLE IF NOT EXISTS user_watch (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  brand_key  TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, brand_key)
);
CREATE INDEX IF NOT EXISTS idx_user_watch_user ON user_watch(user_id);

-- 1.0 brand layer (persistent / audit / history). Canonical public brand record,
-- the entity->brand map (traceability), and per-day brand metrics. Populated from
-- the brand aggregation; the hot read path still uses the cached aggregate, these
-- give history + a queryable canonical source of truth.
CREATE TABLE IF NOT EXISTS casino_brand (
  brand_id          TEXT PRIMARY KEY,   -- brandKey (stable id)
  canonical_name    TEXT NOT NULL,
  slug              TEXT NOT NULL,
  website           TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  category          TEXT NOT NULL DEFAULT 'casino',
  primary_chain     TEXT,
  is_public         INTEGER NOT NULL DEFAULT 1,   -- false for unattributed / low-confidence
  confidence_level  TEXT NOT NULL DEFAULT 'medium',
  source_entity_count INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS casino_entity_map (
  entity_id        INTEGER NOT NULL,    -- watchlist.id
  brand_id         TEXT NOT NULL,
  source_label     TEXT,
  normalized_label TEXT,
  chain            TEXT,
  address          TEXT,
  mapping_type     TEXT NOT NULL DEFAULT 'auto',  -- auto | alias | manual
  is_primary       INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY(entity_id, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_map_brand ON casino_entity_map(brand_id);
CREATE TABLE IF NOT EXISTS brand_daily_metrics (
  brand_id                 TEXT NOT NULL,
  date                     TEXT NOT NULL,    -- YYYY-MM-DD (UTC)
  volume24h                REAL,
  volume7d                 REAL,
  inflow7d                 REAL,
  outflow7d                REAL,
  net7d                    REAL,
  tx_count_7d              INTEGER,
  active_counterparties_7d INTEGER,
  reserves                 REAL,
  reserve_coverage         REAL,
  trust_score              REAL,
  safety_index             REAL,
  trustpilot               REAL,
  reputation               REAL,
  chain_breakdown_json     TEXT,
  source_entity_count      INTEGER,
  confidence_level         TEXT,
  last_updated_at          INTEGER NOT NULL,
  PRIMARY KEY(brand_id, date)
);
CREATE TABLE IF NOT EXISTS unattributed_entity_daily_metrics (
  brand_id        TEXT NOT NULL,    -- pattern cluster key
  label           TEXT NOT NULL,
  chain           TEXT,
  date            TEXT NOT NULL,
  volume24h       REAL,
  volume7d        REAL,
  net7d           REAL,
  reserves        REAL,
  confidence_level TEXT NOT NULL DEFAULT 'low',
  reason          TEXT,
  last_updated_at INTEGER NOT NULL,
  PRIMARY KEY(brand_id, date)
);

-- Automated content pipeline log (OpenRouter Grok → QA → X). One row per
-- (date, content_type, platform): the generated copy, QA verdict, publish result.
CREATE TABLE IF NOT EXISTS content_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  content_type   TEXT NOT NULL,        -- daily_market_thread | top_ranking_image_post | rotating_signal_post | weekly_recap | monthly_report
  platform       TEXT NOT NULL DEFAULT 'x',
  status         TEXT NOT NULL,        -- generated|qa_pass|qa_fail|risk_high|generation_fail|publish_failed|published|skipped
  risk_level     TEXT,
  model          TEXT,
  generated_json TEXT,                 -- the AI output (tweets / image card copy)
  qa_json        TEXT,                 -- QA result: failed items, neutralised notes
  published_url  TEXT,
  skipped_reason TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE(date, content_type, platform)
);
CREATE INDEX IF NOT EXISTS idx_content_log_created ON content_log(created_at DESC);

-- Enrichment queue: low-confidence brands kept as limited_public_noindex pages,
-- queued for enrichment (on-chain address / reserves / trust / social / manual
-- mapping). When enough signal arrives they auto-promote to public_indexable.
CREATE TABLE IF NOT EXISTS enrichment_queue (
  brand_key   TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  slug        TEXT,
  confidence  TEXT,
  missing     TEXT,                 -- comma list: onchain,reserves,trust-sources…
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | enriched | promoted
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Daily-report data-quality issues: reserve-coverage anomalies (the ">100% mapped"
-- class), duplicate whale events, low-confidence public display, etc. Auditable
-- instead of silently rendered. Written by the snapshot generator.
CREATE TABLE IF NOT EXISTS data_quality_issue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL,
  issue_type        TEXT NOT NULL,   -- reserve_coverage_under_review | duplicate_whale_event | …
  severity          TEXT NOT NULL DEFAULT 'warn',  -- info | warn | error
  related_brand_id  TEXT,
  related_entity_id TEXT,
  details_json      TEXT,
  status            TEXT NOT NULL DEFAULT 'open',   -- open | resolved | ignored
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dq_date ON data_quality_issue(date, issue_type);

-- Risk-event registry. Two layers, both NEUTRAL + sourced:
--   • kind='onchain_signal' — auto-derived from OUR observed data (reserve drops, coverage
--     under review, anomalous volume). 100% defensible; no third-party claim.
--   • kind='incident' — admin-CURATED public events (hack / non-payment / insolvency). Each
--     MUST carry a source_url; framing is neutral; the operator's response has a slot.
-- Never an unsourced accusation; never a safety/legality verdict.
CREATE TABLE IF NOT EXISTS risk_event (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_key         TEXT NOT NULL,
  brand_label       TEXT,
  kind              TEXT NOT NULL,                 -- onchain_signal | incident
  category          TEXT NOT NULL,                 -- reserve_drop | coverage_under_review | anomalous_volume | large_outflow | hack | non_payment | insolvency | other
  severity          TEXT NOT NULL DEFAULT 'info',  -- info | watch | elevated
  title             TEXT NOT NULL,
  detail            TEXT,
  source_url        TEXT,                          -- REQUIRED for incidents
  operator_response TEXT,
  status            TEXT NOT NULL DEFAULT 'open',  -- open | resolved | disputed | dismissed
  observed_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_brand ON risk_event(brand_key, status);
CREATE INDEX IF NOT EXISTS idx_risk_recent ON risk_event(observed_at);

-- Per-casino public alert subscription (no login): a visitor on a /casino page asks to
-- be emailed when that brand's tracked reserves drop or a large net outflow is observed.
-- Double opt-in (confirm_token) + non-enumerable unsubscribe_token; one row per (email,brand).
CREATE TABLE IF NOT EXISTS brand_alert_sub (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT NOT NULL,
  brand_key         TEXT NOT NULL,
  brand_label       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | active | unsubscribed
  confirm_token     TEXT,
  unsubscribe_token TEXT NOT NULL,
  last_alert_at     INTEGER,                          -- de-dup: don't re-alert too often
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(email, brand_key)
);
CREATE INDEX IF NOT EXISTS idx_brand_alert_brand ON brand_alert_sub(brand_key, status);

-- Community submissions: attribution evidence for unattributed flow, or a correction
-- request for a tracked brand. Public POST → admin review (never auto-applied).
CREATE TABLE IF NOT EXISTS submission (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,                 -- attribution | correction
  brand        TEXT,
  email        TEXT,
  message      TEXT NOT NULL,
  evidence_url TEXT,
  status       TEXT NOT NULL DEFAULT 'new',   -- new | reviewed | actioned | dismissed
  created_at   INTEGER NOT NULL
);
`)

// additive migrations for DBs created before these columns existed
for (const ddl of [
  // one-click email-confirmation token (magic link) for digest double-opt-in
  'ALTER TABLE email_subscriber ADD COLUMN confirm_token TEXT',
  // LLM "Today's Market Read" + Notable Signals for the daily report (QA-gated)
  'ALTER TABLE daily_market_snapshot ADD COLUMN ai_market_read TEXT',
  'ALTER TABLE daily_market_snapshot ADD COLUMN ai_notable_signals TEXT',
  'ALTER TABLE streamers ADD COLUMN followers INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE streamers ADD COLUMN affiliation TEXT',
  // Trustpilot consumer signal merged onto each directory casino (per-domain /review/ enricher)
  'ALTER TABLE casino_directory ADD COLUMN tp_rating REAL',
  'ALTER TABLE casino_directory ADD COLUMN tp_reviews INTEGER',
  'ALTER TABLE casino_directory ADD COLUMN tp_checked INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE arkham_casino ADD COLUMN domain TEXT',
  'ALTER TABLE arkham_casino ADD COLUMN addr_harvested INTEGER NOT NULL DEFAULT 0',
  // alerts can email the rule owner when they fire (per-rule opt-out)
  'ALTER TABLE alert_rules ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1',
  // SEO page lifecycle state — internal_only | limited_public_noindex | public_indexable | featured_core | archived
  "ALTER TABLE seo_page ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'public_indexable'",
  // provenance of a watched address — NULL/'curated' = hand-seeded; 'btc-cluster' =
  // discovered by common-input-ownership clustering (auditable + bulk-reversible)
  'ALTER TABLE watchlist ADD COLUMN source TEXT',
]) {
  try {
    db.exec(ddl)
  } catch {
    /* column already exists */
  }
}

// address-keyed lookup on the watchlist — powers the "is the counterparty itself a
// watched casino address?" (internal-flow) exclusion used by the volume metrics.
db.exec('CREATE INDEX IF NOT EXISTS idx_watchlist_address ON watchlist(address)')

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
