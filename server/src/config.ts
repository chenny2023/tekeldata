// ─────────────────────────────────────────────────────────────────────────────
// Runtime configuration. Everything has a working keyless default so the
// platform collects REAL on-chain data out of the box; drop API keys in .env
// for higher rate limits / reliability in production.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'

const env = process.env

export const config = {
  port: Number(env.PORT ?? 8787),
  nodeEnv: env.NODE_ENV ?? 'development',
  dbPath: env.DB_PATH ?? 'server/data/wcoin.db',

  // EVM RPC endpoints, rotated on failure. EVM_RPC (e.g. Alchemy) goes FIRST
  // for reliability; public nodes stay as fallback. Note: Alchemy free tier
  // caps eth_getLogs at 10-block ranges, so wide-range scans (deep backfill)
  // use evmWideRpcs — public nodes that accept large ranges.
  evmRpcs: [
    ...(env.EVM_RPC ? [env.EVM_RPC] : []),
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ],
  evmWideRpcs: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ],

  // TronGrid works keyless (rate-limited). Set TRONGRID_KEY for higher limits.
  tronApi: env.TRON_API ?? 'https://api.trongrid.io',
  tronKey: env.TRONGRID_KEY ?? '',

  // Tron EVM-compat JSON-RPC (eth_getLogs) — the preferred Tron collector.
  // Default is TronGrid's public jsonrpc; paste a dedicated provider URL
  // (e.g. a GetBlock TRON endpoint created with protocol = JSON-RPC) for
  // unlimited rate. Set TRON_MODE=v1 to fall back to the TronGrid REST poller.
  tronJsonRpc: env.TRON_JSONRPC ?? 'https://api.trongrid.io/jsonrpc',
  tronMode: env.TRON_MODE ?? 'jsonrpc',
  tronMaxRange: Number(env.TRON_MAX_RANGE ?? 4500), // ≤ node's 5000-block getLogs cap
  // Skip indexing Tron USDT transfers below this USD value. Tron casino hot wallets
  // see a huge long tail of tiny/dust transfers that bloat the transfers table (37M
  // rows / 10GB → cold-boot freezes) for little analytic value — the volume signal is
  // dominated by large flows. 0 = index everything (off).
  tronMinUsd: Number(env.TRON_MIN_USD ?? 0),

  // Stablecoin contracts we index (valued 1:1 USD for accurate, real USD figures).
  // All entries MUST be USD-pegged 1:1 stablecoins — the indexer values every
  // evmToken transfer at face value, so a non-stable here would mis-state volume.
  evmTokens: [
    { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
    { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    { symbol: 'DAI', address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18 },
    { symbol: 'PYUSD', address: '0x6c3ea9036406852006290770bedfcaba0e23a0e8', decimals: 6 },
  ],
  tronUsdt: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },

  // ── BSC (BNB Chain) — EVM-compatible, a dominant crypto-casino rail. Public
  // nodes are GFW-blocked direct, so the BSC collector routes via webFetch
  // (proxy). NOTE: BEP20 USDT/USDC use 18 decimals (not 6 like ETH/Tron).
  // publicnode caps eth_getLogs at ~2000 blocks; the collector adapts.
  bscEnabled: (env.BSC_ENABLED ?? '1') !== '0',
  // Keyless public BSC nodes. "[bsc] forward error: limit exceeded" fires only when
  // the getLogs range is already at RANGE_FLOOR AND every endpoint here rate-limits in
  // one pass — i.e. a per-provider CU/rate cap, not a range issue (shrinking won't help).
  // The fix is a WIDER rotation pool so the (proxy-IP × provider) rate budget is spread
  // across more providers. Binance's dataseed1-4 are the canonical official nodes; the
  // rest are established keyless aggregators. A dead/slow one is just rotated past.
  bscRpcs: [
    ...(env.BSC_RPC ? [env.BSC_RPC] : []),
    'https://bsc-rpc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.binance.org',
    'https://bsc-dataseed2.binance.org',
    'https://bsc-dataseed3.binance.org',
    'https://bsc-dataseed4.binance.org',
    'https://binance.llamarpc.com',
    'https://bsc.meowrpc.com',
    'https://bsc.drpc.org',
  ],
  bscTokens: [
    { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
    { symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
    { symbol: 'FDUSD', address: '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', decimals: 18 },
  ],
  bscMaxRange: Number(env.BSC_MAX_RANGE ?? 1800), // ≤ publicnode's ~2000 cap
  bscPollMs: Number(env.BSC_POLL_MS ?? 12_000),
  bscMaxRangesPerTick: Number(env.BSC_MAX_RANGES ?? 12),
  bscBackfillBlocks: Number(env.BSC_BACKFILL_BLOCKS ?? 400),

  // Indexer pacing
  evmBackfillBlocks: Number(env.EVM_BACKFILL_BLOCKS ?? 120), // forward-indexer boot window
  evmChunk: Number(env.EVM_CHUNK ?? 5), // blocks per getLogs range (forward)
  evmChunkDelayMs: Number(env.EVM_CHUNK_DELAY_MS ?? 220), // pace getLogs to dodge public-RPC 429s
  evmMaxRangesPerTick: Number(env.EVM_MAX_RANGES ?? 24),
  evmPollMs: Number(env.EVM_POLL_MS ?? 12_000),
  // Deep historical backfill: walks BACKWARD from boot head with adaptive
  // ranges until this many days of history are indexed. Runs in background,
  // progress persists across restarts.
  deepBackfillDays: Number(env.DEEP_BACKFILL_DAYS ?? 14),
  // Transfer retention (0 = keep everything). When > 0, transfers older than
  // this many days are pruned in batches so the SQLite file stops growing —
  // essential on a size-capped volume. Must be ≥ deepBackfillDays or the prune
  // will fight the backfill. Reusing freed pages caps the file in place (no
  // VACUUM needed). Tunable live via the RETAIN_DAYS env var.
  retainDays: Number(env.RETAIN_DAYS ?? 0),
  deepBackfillStartRange: Number(env.DEEP_BACKFILL_RANGE ?? 1500), // blocks per getLogs attempt
  tronBackfillHours: Number(env.TRON_BACKFILL_HOURS ?? 72),
  tronPollMs: Number(env.TRON_POLL_MS ?? 6_000), // one address per tick (round-robin)
  tronPagesPerTick: Number(env.TRON_PAGES_PER_TICK ?? 5), // 5 × 50 tx per address visit
  aggregateMs: Number(env.AGGREGATE_MS ?? 30_000),
  whaleUsd: Number(env.WHALE_USD ?? 100_000),

  // Litestream continuous backup is active when R2 creds are set. When active,
  // litestream OWNS WAL checkpointing — the app must not auto-checkpoint or
  // TRUNCATE the WAL (that would drop frames litestream hasn't shipped yet).
  backupActive: !!(env.BACKUP_R2_BUCKET && env.BACKUP_R2_ACCESS_KEY_ID && env.BACKUP_R2_SECRET_ACCESS_KEY),

  // Optional Twitch Helix creds for the live streamer module (no fabrication —
  // if unset, the streamer feed is simply empty and the UI says "connect a source")
  twitchClientId: env.TWITCH_CLIENT_ID ?? '',
  twitchClientSecret: env.TWITCH_CLIENT_SECRET ?? '',

  // ── Email delivery for passwordless sign-in codes ────────────────────────────
  // The product is 100% free: anyone signs up with just an email + a 6-digit
  // code. Two transports are supported (first one configured wins):
  //   1. SMTP (e.g. Gmail): set EMAIL_USER + EMAIL_PASSWORD (a Gmail App
  //      Password, NOT the account password). Host/port default to Gmail.
  //   2. Resend HTTP API: set RESEND_API_KEY (+ RESEND_FROM verified sender).
  // With neither set, the code is logged to the server console (and returned to
  // the client only outside production) so the flow still works end-to-end.
  smtpHost: env.EMAIL_HOST ?? 'smtp.gmail.com',
  smtpPort: Number(env.EMAIL_PORT ?? 465),
  smtpUser: env.EMAIL_USER ?? '',
  smtpPass: env.EMAIL_PASSWORD ?? '',
  // From-address: defaults to the SMTP user; override with EMAIL_FROM
  emailFrom: env.EMAIL_FROM ?? env.EMAIL_USER ?? '',

  resendApiKey: env.RESEND_API_KEY ?? '',
  resendFrom: env.RESEND_FROM ?? 'WCOIN.CASINO <onboarding@resend.dev>',
}

export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
