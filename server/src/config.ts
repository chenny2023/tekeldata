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

  // Stablecoin contracts we index (valued 1:1 USD for accurate, real USD figures)
  evmTokens: [
    { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
    { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  ],
  tronUsdt: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },

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
  deepBackfillStartRange: Number(env.DEEP_BACKFILL_RANGE ?? 1500), // blocks per getLogs attempt
  tronBackfillHours: Number(env.TRON_BACKFILL_HOURS ?? 72),
  tronPollMs: Number(env.TRON_POLL_MS ?? 6_000), // one address per tick (round-robin)
  tronPagesPerTick: Number(env.TRON_PAGES_PER_TICK ?? 5), // 5 × 50 tx per address visit
  aggregateMs: Number(env.AGGREGATE_MS ?? 30_000),
  whaleUsd: Number(env.WHALE_USD ?? 100_000),

  // Optional Twitch Helix creds for the live streamer module (no fabrication —
  // if unset, the streamer feed is simply empty and the UI says "connect a source")
  twitchClientId: env.TWITCH_CLIENT_ID ?? '',
  twitchClientSecret: env.TWITCH_CLIENT_SECRET ?? '',
}

export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
