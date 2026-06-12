import { db, stmt } from './db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Seed watchlist — REAL, publicly-documented, on-chain-active addresses.
//
// These are labeled HONESTLY by what public block explorers attribute them to.
// They exist so the platform shows genuine live flow the moment you start it.
// Operators curate their own competitor-casino addresses via POST /api/watchlist
// (or the Watchlist UI) — the indexer treats every entry identically.
//
// NOTE: none of these are claimed to be a specific casino's wallet. They are
// real exchange / high-volume settlement addresses whose USDT/USDC flow is
// public. Swap in real casino deposit/hot wallets to make the leaderboard yours.
// ─────────────────────────────────────────────────────────────────────────────

interface Seed {
  chain: 'ETH' | 'TRON'
  address: string
  label: string
  category: 'casino' | 'exchange' | 'whale' | 'other'
}

const SEEDS: Seed[] = [
  // ── Ethereum (USDT/USDC) — public exchange hot wallets, very high volume ──
  { chain: 'ETH', address: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'Binance 14', category: 'exchange' },
  { chain: 'ETH', address: '0x21a31ee1afc51d94c2efccaa2092ad1028285549', label: 'Binance 15', category: 'exchange' },
  { chain: 'ETH', address: '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', label: 'Binance 16', category: 'exchange' },
  { chain: 'ETH', address: '0x56eddb7aa87536c09ccc2793473599fd21a8b17f', label: 'Binance 17', category: 'exchange' },
  { chain: 'ETH', address: '0x9696f59e4d72e237be84ffd425dcad154bf96976', label: 'Binance 18', category: 'exchange' },
  { chain: 'ETH', address: '0x5041ed759dd4afc3a72b8192c143f72f4724081a', label: 'OKX', category: 'exchange' },
  { chain: 'ETH', address: '0xa7efae728d2936e78bda97dc267687568dd593f3', label: 'OKX 2', category: 'exchange' },
  { chain: 'ETH', address: '0xe93381fb4c4f14bda253907b18fad305d799241a', label: 'Huobi', category: 'exchange' },

  // ── Tron (USDT TRC20) — public exchange hot wallets, dominant casino rail ──
  { chain: 'TRON', address: 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb', label: 'Binance (TRON)', category: 'exchange' },
  { chain: 'TRON', address: 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs', label: 'Binance 2 (TRON)', category: 'exchange' },
  { chain: 'TRON', address: 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC', label: 'OKX (TRON)', category: 'exchange' },
  { chain: 'TRON', address: 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9', label: 'Huobi (TRON)', category: 'exchange' },

  // ── Non-EVM seeds — large, on-chain-active public addresses. Labeled
  // conservatively as "whale" because (unlike ETH/TRON) we have no keyless
  // block-explorer name-tag to confirm a specific exchange. They exist so each
  // chain shows real, live flow immediately; rename them on the Watchlist once
  // attributed.
  { chain: 'XRP', address: 'rLW9gnQo7BQhU6igk5keqYnH3TVrCxGRzm', label: 'XRP Whale', category: 'whale' },
  { chain: 'BTC', address: '3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6', label: 'Bitcoin Whale', category: 'whale' },
  { chain: 'LTC', address: 'MGxNPPB7eBoWPUaprtX9v9CXJZoD2465zN', label: 'Litecoin Whale', category: 'whale' },
]

export function seedWatchlist() {
  // INSERT OR IGNORE — adds any new seeds (e.g. new chains) without disturbing
  // operator-curated entries or prior data
  const now = Date.now()
  let added = 0
  const tx = db.transaction(() => {
    for (const s of SEEDS) {
      added += stmt.addWatch.run(s.chain, s.chain === 'ETH' ? s.address.toLowerCase() : s.address, s.label, s.category, now).changes
    }
  })
  tx()
  if (added) console.log(`[watchlist] seeded ${added} new on-chain addresses (${SEEDS.length} total in seed set)`)
}
