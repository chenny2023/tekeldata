import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'
import { webFetch } from '../net.ts'
import { priceForDay } from './prices.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Solana collector. Solana has no eth_getLogs, so this works differently from
// the EVM chains: per watched SOL address we pull recent signatures (native SOL
// via the owner, SPL USDC/USDT via the owner's token accounts), fetch each
// transaction, and derive the owner's net balance change.
//
//   • SPL USDC/USDT transfers  → valued 1:1 USD (consistent with every chain)
//   • native SOL transfers     → valued at a cached SOL/USD spot price, because
//     Solana casinos take large native-SOL deposits (circus's SOL whale feed is
//     mostly native SOL) and ignoring them would badly undercount the chain
//
// Node behaviour differs per method, so RPC rotates: publicnode (direct) for
// most calls, api.mainnet-beta (proxy) which reliably serves token-account
// lookups. Timestamps come from real blockTime. Forward-only (signature history
// gives recent depth); resumes from the last seen signature per account.
// ─────────────────────────────────────────────────────────────────────────────

const NODES: { url: string; proxy: boolean }[] = [
  { url: process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com', proxy: false },
  { url: 'https://api.mainnet-beta.solana.com', proxy: true },
]
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const STABLE_MINTS = new Set([USDC, USDT])
const MINT_SYMBOL: Record<string, string> = { [USDC]: 'USDC', [USDT]: 'USDT' }
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SIGS_PER_ACCOUNT = 12 // per tick, per account — gentle on public RPC
const ADDRS_PER_TICK = 4 // round-robin a few SOL addresses per tick

export const solEnabled = () => (process.env.SOL_ENABLED ?? '1') !== '0'

let nodeIdx = 0
export async function solRpc(method: string, params: unknown[], tries = 4): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    const node = NODES[nodeIdx % NODES.length]
    nodeIdx++
    try {
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      }
      const res = node.proxy ? await webFetch(node.url, init) : await fetch(node.url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as any
      if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 80))
      return json.result
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

// ── SOL/USD spot price, cached ───────────────────────────────────────────────
let priceCache = { usd: 0, at: 0 }
async function priceSol(): Promise<number> {
  if (priceCache.usd && Date.now() - priceCache.at < 5 * 60_000) return priceCache.usd
  try {
    const r = await webFetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(12_000) })
    const j = (await r.json()) as any
    const usd = Number(j?.data?.amount)
    if (usd > 0) priceCache = { usd, at: Date.now() }
  } catch {
    /* keep last */
  }
  return priceCache.usd
}

// net per-owner USD delta in a parsed tx: stables 1:1, native SOL × the price
// ON THE DAY of the tx (block-time historical price), not today's spot.
// returns the dominant leg with both the raw token amount and its USD value.
function dominantTransfer(tx: any): { gainer: string; loser: string; usd: number; amount: number; token: string } | null {
  const acctKeys: string[] = tx.transaction.message.accountKeys.map((k: any) => k.pubkey ?? k)
  const owners = new Map<string, { usd: number; amount: number; token: string }>()
  const bump = (owner: string, usd: number, amount: number, token: string) => {
    const cur = owners.get(owner) ?? { usd: 0, amount: 0, token }
    cur.usd += usd
    cur.amount += amount
    cur.token = token
    owners.set(owner, cur)
  }
  // SPL stable deltas (1:1 USD), grouped by token-account owner
  const pre = tx.meta.preTokenBalances ?? []
  const post = tx.meta.postTokenBalances ?? []
  const tBal = (arr: any[], sign: number) => {
    for (const b of arr) {
      if (!STABLE_MINTS.has(b.mint) || !b.owner) continue
      const amt = sign * Number(b.uiTokenAmount.uiAmount ?? 0)
      bump(b.owner, amt, amt, MINT_SYMBOL[b.mint]) // stable: amount == usd
    }
  }
  tBal(post, 1)
  tBal(pre, -1)
  // native SOL deltas (skip if any stable leg present — avoid double counting)
  const solUsd = priceForDay('SOL', (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000) || priceCache.usd
  if (owners.size === 0 && solUsd > 0) {
    for (let i = 0; i < acctKeys.length; i++) {
      const d = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9
      if (Math.abs(d) >= 0.5) bump(acctKeys[i], d * solUsd, d, 'SOL')
    }
  }
  let gainer = '', loser = '', gUsd = 0, lUsd = 0, token = 'USDC', gAmt = 0
  for (const [owner, { usd, amount, token: t }] of owners) {
    if (usd > gUsd) { gainer = owner; gUsd = usd; token = t; gAmt = Math.abs(amount) }
    if (usd < lUsd) { loser = owner; lUsd = usd }
  }
  const usd = Math.max(gUsd, -lUsd)
  if (!gainer || !loser || usd < 1) return null
  return { gainer, loser, usd, amount: gAmt, token }
}

// resolve a circus SOL whale tx to the casino-side address
export async function resolveSolWallet(sig: string, dir: 'in' | 'out'): Promise<string | null> {
  const tx = await solRpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }])
  if (!tx?.meta) return null
  await priceSol() // keep spot fresh for the historical-price fallback
  const d = dominantTransfer(tx)
  if (!d) return null
  return dir === 'in' ? d.gainer : d.loser
}

// ── indexing ─────────────────────────────────────────────────────────────────
const ataCache = new Map<string, string[]>() // owner → [token account pubkeys]
async function tokenAccounts(owner: string): Promise<string[]> {
  if (ataCache.has(owner)) return ataCache.get(owner)!
  const accts: string[] = []
  for (const mint of [USDC, USDT]) {
    try {
      const r = await solRpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }])
      for (const a of r?.value ?? []) accts.push(a.pubkey)
    } catch {
      /* tolerate */
    }
  }
  ataCache.set(owner, accts)
  return accts
}

let rr = 0
async function indexAddress(w: WatchRow) {
  const owner = w.address
  // accounts to scan: the owner (native SOL) + its stable token accounts (SPL)
  const accounts = [owner, ...(await tokenAccounts(owner))]
  for (const acct of accounts) {
    const lastKey = `sol:last:${acct}`
    const until = stateGet(lastKey) || undefined
    let sigs: any[]
    try {
      sigs = (await solRpc('getSignaturesForAddress', [acct, { limit: SIGS_PER_ACCOUNT, ...(until ? { until } : {}) }])) ?? []
    } catch {
      continue
    }
    if (sigs.length === 0) continue
    let newest: string | null = null
    let added = 0
    // process oldest→newest so `until` advances correctly
    for (const s of sigs.slice().reverse()) {
      if (s.err) continue
      let tx: any
      try {
        tx = await solRpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }])
      } catch {
        continue
      }
      if (!tx?.meta) continue
      const d = dominantTransfer(tx)
      if (d && (d.gainer === owner || d.loser === owner)) {
        const direction = d.gainer === owner ? 'in' : 'out'
        const counterparty = direction === 'in' ? d.loser : d.gainer
        const rec = {
          chain: 'SOL',
          tx_hash: s.signature,
          log_index: 0,
          token: d.token,
          from_addr: direction === 'in' ? counterparty : owner,
          to_addr: direction === 'in' ? owner : counterparty,
          counterparty,
          amount: d.amount, // raw token units (SOL or USDC); usd is the valued amount
          usd: d.usd,
          watch_id: w.id,
          label: w.label,
          category: w.category,
          direction: direction as 'in' | 'out',
          block: tx.slot ?? 0,
          ts: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
        }
        const r = stmt.insertTransfer.run(rec)
        if (r.changes > 0) {
          added++
          if (Date.now() - rec.ts < 600_000) emitTransfer(rec)
        }
      }
      newest = s.signature
      await new Promise((r) => setTimeout(r, 120))
    }
    if (newest) stateSet(lastKey, newest)
    if (added) console.log(`[sol] ${w.label}: +${added} transfers`)
  }
}

export async function runSolanaOnce() {
  const watched = (stmt.activeWatch.all() as WatchRow[]).filter((w) => w.chain === 'SOL' && SOL_ADDR.test(w.address))
  if (watched.length === 0) return
  await priceSol() // refresh spot for the historical-price fallback
  for (let i = 0; i < Math.min(ADDRS_PER_TICK, watched.length); i++) {
    const w = watched[rr % watched.length]
    rr++
    try {
      await indexAddress(w)
    } catch (e) {
      console.warn(`[sol] ${w.label} failed:`, (e as Error).message)
    }
  }
}

// Current reserves held by a Solana address, in USD: native SOL at spot plus the
// owner's SPL USDC/USDT token accounts (1:1, same basis as every other chain).
// Returns null on RPC failure so the caller can tell "fetch failed" apart from
// "wallet is empty" — writing a 0 over a known balance would fake a drawdown.
export async function solBalanceUsd(address: string): Promise<number | null> {
  if (!SOL_ADDR.test(address)) return null
  try {
    const lamports = await solRpc('getBalance', [address])
    const native = Number(lamports?.value ?? 0) / 1e9
    let usd = native * priceForDay('SOL', Date.now())
    // SPL stables live in separate token accounts owned by the address
    const accounts = await solRpc('getTokenAccountsByOwner', [
      address,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' },
    ])
    for (const a of accounts?.value ?? []) {
      const info = a?.account?.data?.parsed?.info
      if (!info || !STABLE_MINTS.has(info.mint)) continue
      usd += Number(info.tokenAmount?.uiAmount ?? 0)
    }
    return Number.isFinite(usd) ? usd : null
  } catch {
    return null
  }
}

export function startSolana() {
  if (!solEnabled()) {
    console.log('[sol] disabled (SOL_ENABLED=0)')
    return
  }
  console.log('[sol] Solana collector active (SPL stables 1:1 + native SOL priced)')
  const loop = async () => {
    try { await runSolanaOnce() } catch (e) { console.warn('[sol]', (e as Error).message) }
    finally { setTimeout(loop, 15_000) }
  }
  setTimeout(loop, 30_000)
}
