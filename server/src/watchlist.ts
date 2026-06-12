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
]

export function seedWatchlist() {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n
  if (count > 0) return
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const s of SEEDS) {
      stmt.addWatch.run(s.chain, s.chain === 'ETH' ? s.address.toLowerCase() : s.address, s.label, s.category, now)
    }
  })
  tx()
  console.log(`[watchlist] seeded ${SEEDS.length} real on-chain addresses`)
}
