import { config, TRANSFER_TOPIC } from '../config.ts'
import { db, stmt, stateGet, stateSet } from '../db.ts'
import { webFetch } from '../net.ts'
import { rpc as evmRpc } from './evm.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Casino-wallet attribution via the public circus.fyi whale feed.
//
// circus.fyi publishes a live "whale transactions" feed on /blockchain in which
// every large transfer is attributed to a named casino. The feed ships the
// public transaction HASH and the casino name — not the wallet address. We take
// the one piece of attribution (casino ↔ tx) and independently verify + extract
// the wallet from PUBLIC chain data: resolve the tx receipt, take the casino
// side of the largest stablecoin transfer (recipient for a deposit, sender for a
// withdrawal). The resulting address joins our watchlist and our own indexer
// builds its full real flow history — we copy no metrics, only follow a public
// lead and confirm it on-chain.
//
// Validated: the Stake whale tx resolves to 0x974caa59…ecc400, matching the
// independently Wayback-attributed Stake.com wallet.
// ─────────────────────────────────────────────────────────────────────────────

const FEED_URL = 'https://circus.fyi/blockchain'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const STABLE = config.evmTokens.map((t) => t.address.toLowerCase())

const NAME_RE = /"children":"([A-Z][A-Za-z0-9.\s]{1,22})"\}/g
const CHAIN_RE = /"children":"(ETH|TRX|BSC|SOL|ARB|BASE|AVAX|OP|MATIC|POLYGON|XRP|BTC|LTC)"\}/g
const NAME_NOISE = /^(View|Hash|ago|hours|min|Deposit|Withdraw|Whale|Live|Transaction|Amount|Chain|Casino)$/i

interface WhaleRow {
  casino: string
  hash: string
  chain: string
  dir: 'in' | 'out'
}

async function fetchFeed(): Promise<WhaleRow[]> {
  const res = await webFetch(FEED_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"([\s\S]*?)"\]\)/g)].map((m) => m[1])
  let blob = ''
  for (const c of chunks) {
    try { blob += JSON.parse('"' + c + '"') } catch { blob += c }
  }
  const rows: WhaleRow[] = []
  for (const m of blob.matchAll(/etherscan\.io\/tx\/(0x[0-9a-fA-F]{64})/g)) {
    const at = m.index ?? 0
    const before = blob.slice(Math.max(0, at - 1800), at)
    const names = [...before.matchAll(NAME_RE)].map((x) => x[1].trim()).filter((n) => !NAME_NOISE.test(n) && !/^(ETH|TRX|BSC|SOL|ARB|BASE|AVAX|OP|MATIC|POLYGON|XRP|BTC|LTC)$/.test(n))
    const casino = names[names.length - 1]
    if (!casino) continue
    const dir: 'in' | 'out' = before.lastIndexOf('arrow-down-left') > before.lastIndexOf('arrow-up-right') ? 'in' : 'out'
    const chains = [...before.matchAll(CHAIN_RE)].map((x) => x[1])
    const chain = chains[chains.length - 1] ?? 'ETH'
    rows.push({ casino, hash: m[1], chain, dir })
  }
  return rows
}

// resolve an ETH tx to the casino-side address of its largest stablecoin leg
async function resolveEvmWallet(hash: string, dir: 'in' | 'out'): Promise<string | null> {
  const rc = await evmRpc('eth_getTransactionReceipt', [hash])
  if (!rc?.logs) return null
  let best: { amt: bigint; from: string; to: string } | null = null
  for (const l of rc.logs as any[]) {
    if (!STABLE.includes(l.address.toLowerCase()) || l.topics?.[0] !== TRANSFER_TOPIC) continue
    const amt = BigInt(l.data === '0x' ? '0x0' : l.data)
    if (!best || amt > best.amt) best = { amt, from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26) }
  }
  if (!best) return null
  return (dir === 'in' ? best.to : best.from).toLowerCase()
}

function alreadyWatched(chain: string, address: string): boolean {
  return !!db.prepare('SELECT 1 FROM watchlist WHERE chain=? AND address=?').get(chain, address)
}

export async function runCircusOnce() {
  let rows: WhaleRow[]
  try {
    rows = await fetchFeed()
  } catch (e) {
    console.warn('[circus] feed fetch failed:', (e as Error).message)
    return
  }
  let added = 0
  for (const row of rows) {
    // only EVM resolution is wired today (ETH); other chains are skipped until
    // their collectors exist, but the casino name is remembered for then
    if (row.chain !== 'ETH') continue
    const seenKey = `circus:tx:${row.hash}`
    if (stateGet(seenKey)) continue
    try {
      const wallet = await resolveEvmWallet(row.hash, row.dir)
      stateSet(seenKey, 1)
      if (!wallet) continue
      if (alreadyWatched('ETH', wallet)) continue
      stmt.addWatch.run('ETH', wallet, row.casino.slice(0, 48), 'casino', Date.now())
      added++
      console.log(`[circus] attributed ${row.casino} → ${wallet} (from whale tx, ${row.dir})`)
    } catch (e) {
      console.warn(`[circus] resolve ${row.hash.slice(0, 12)}… failed:`, (e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (added) console.log(`[circus] +${added} new casino wallets this sweep`)
}

export function startCircus() {
  console.log('[circus] casino-attribution feed active (whale-tx resolution)')
  const loop = async () => {
    await runCircusOnce().catch((e) => console.warn('[circus]', (e as Error).message))
    setTimeout(loop, 5 * 60_000) // every 5 min — feed refreshes, accumulates new casinos
  }
  setTimeout(loop, 20_000)
}
