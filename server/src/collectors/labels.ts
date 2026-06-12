import { db, stmt, stateGet, stateSet } from '../db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Casino-wallet attribution harvester. Collects REAL public labels:
//
//  • ETH  — Etherscan's "gambling" account labels, via the maintained public
//           dump at github.com/brianleect/etherscan-labels (45+ casinos:
//           1xBet, Bitsler, Parlay, etc.). Source of truth: Etherscan label cloud.
//  • TRON — Tronscan's public `addressTag` field, harvested from the top USDT
//           holder list (keyless API). Tags are classified into casino /
//           exchange by keyword; unknown tags are skipped, never guessed.
//
// Runs on boot (max once per REFRESH_DAYS) and adds entries to the same
// watchlist the indexer consumes — so every harvested casino wallet starts
// accruing real transfer history immediately.
// ─────────────────────────────────────────────────────────────────────────────

const ETH_GAMBLING_URL =
  'https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/etherscan/accounts/gambling.json'
const TRON_HOLDERS_URL =
  'https://apilist.tronscanapi.com/api/token_trc20/holders?contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const REFRESH_DAYS = 7
const TRON_PAGES = 20 // top 20 × 50 = 1000 holders scanned
const PAGE_SIZE = 50

const GAMBLING_RE = /casino|gambl|bet(?!a)|stake|dice|slots?|poker|lottery|lotto|jackpot|roobet|rollbit|bitsler|wager|1xbet|bovada|fortunejack/i
const EXCHANGE_RE = /binance|okx|okex|huobi|htx|bybit|kraken|coinbase|kucoin|gate\.io|bitfinex|mexc|bitget|crypto\.com|upbit|bithumb|exchange/i
const SKIP_RE = /tether|treasury|justlend|foundation|usdd|wrapped|multisig|burn/i

function cleanLabel(raw: string): string {
  // "Bitsler.com: USDT" → "Bitsler.com" ; keep names tight
  return raw.split(':')[0].trim().slice(0, 48)
}

async function harvestEthGambling(): Promise<number> {
  const res = await fetch(ETH_GAMBLING_URL, { signal: AbortSignal.timeout(25_000) })
  if (!res.ok) throw new Error(`labels dump HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, string>
  const now = Date.now()
  let added = 0
  const tx = db.transaction(() => {
    for (const [address, name] of Object.entries(json)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue
      const r = stmt.addWatch.run('ETH', address.toLowerCase(), cleanLabel(name), 'casino', now)
      added += r.changes
    }
  })
  tx()
  return added
}

async function harvestTronTags(): Promise<number> {
  const now = Date.now()
  let added = 0
  for (let page = 0; page < TRON_PAGES; page++) {
    try {
      const res = await fetch(`${TRON_HOLDERS_URL}&start=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`, {
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      for (const h of json.trc20_tokens ?? []) {
        const tag: string = h.addressTag ?? ''
        const addr: string = h.holder_address ?? ''
        if (!tag || !addr || SKIP_RE.test(tag)) continue
        let category: string | null = null
        if (GAMBLING_RE.test(tag)) category = 'casino'
        else if (EXCHANGE_RE.test(tag)) category = 'exchange'
        if (!category) continue // unknown tag → never guess
        const r = stmt.addWatch.run('TRON', addr, cleanLabel(tag), category, now)
        added += r.changes
      }
    } catch (e) {
      console.warn(`[labels] tron page ${page} failed:`, (e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 1200)) // keyless API politeness
  }
  return added
}

export async function runLabelHarvest(force = false) {
  const last = Number(stateGet('labels:lastRun') ?? 0)
  if (!force && Date.now() - last < REFRESH_DAYS * 86_400_000) return
  console.log('[labels] harvesting public casino-wallet attributions…')
  let eth = 0
  let tron = 0
  try {
    eth = await harvestEthGambling()
  } catch (e) {
    console.warn('[labels] eth harvest failed:', (e as Error).message)
  }
  try {
    tron = await harvestTronTags()
  } catch (e) {
    console.warn('[labels] tron harvest failed:', (e as Error).message)
  }
  stateSet('labels:lastRun', Date.now())
  console.log(`[labels] done — +${eth} ETH casino wallets, +${tron} TRON tagged wallets`)
}

export function startLabels() {
  // boot harvest (non-blocking) + weekly refresh
  runLabelHarvest().catch(() => {})
  setInterval(() => runLabelHarvest().catch(() => {}), 12 * 3600_000)
}
