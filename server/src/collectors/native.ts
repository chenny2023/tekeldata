import { config } from '../config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'
import { webFetch } from '../net.ts'
import { priceForDay } from './prices.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Native-coin (ETH / BNB) deposit & withdrawal scanner.
//
// Our stablecoin rails ride ERC20 Transfer LOGS, which eth_getLogs filters
// cheaply by topic+address. Native value transfers emit NO logs — they live in
// the block's transaction list — and public nodes don't expose trace_filter
// keylessly. So we scan full blocks (eth_getBlockByNumber with txs) and keep the
// ones whose from/to touches a watched casino wallet, priced at block-time USD.
//
// Casino 0x hot wallets are stored once and reused across every EVM chain, so we
// scan the SAME watched-address set on ETH (native ETH) and BSC (native BNB).
// Full-block parsing is heavy: we BOUND blocks/tick, yield between blocks, and if
// we fall too far behind the tip we rejoin it (native deposits are sparse — being
// current matters more than scanning every historical block). No deep backfill.
// BSC public nodes are datacenter-blocked, so its RPC routes through the proxy.
// ─────────────────────────────────────────────────────────────────────────────

const HEX = (n: number) => '0x' + n.toString(16)
const WEI = 10 ** 18
const MAX_LAG = 600 // if we fall >600 blocks behind the tip, skip the gap and rejoin

let rpcIdx = 0
async function rpcCall(method: string, params: unknown[], rpcs: string[], useProxy: boolean, tries = rpcs.length * 2): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    const url = rpcs[rpcIdx++ % rpcs.length]
    try {
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      }
      const res = useProxy ? await webFetch(url, init) : await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as any
      if (json.error) throw new Error(json.error.message || 'rpc error')
      return json.result
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

// every active 0x watchlist address — casinos reuse hot wallets across EVM chains
const evmWatched = (): WatchRow[] => (stmt.activeWatch.all() as WatchRow[]).filter((r) => /^0x[0-9a-fA-F]{40}$/.test(r.address))

async function scanNativeOnce(chainKey: string, asset: string, rpcs: string[], useProxy: boolean, maxBlocksPerTick: number, bootWindow: number) {
  const rows = evmWatched()
  if (rows.length === 0) return
  const byAddr = new Map(rows.map((r) => [r.address.toLowerCase(), r]))
  const watched = new Set(rows.map((r) => r.address.toLowerCase()))

  const head = Number(BigInt(await rpcCall('eth_blockNumber', [], rpcs, useProxy)))
  const stateKey = `native:${chainKey}:lastBlock`
  let last = Number(stateGet(stateKey) ?? 0)
  if (last === 0 || head - last > MAX_LAG) last = head - bootWindow // start at / rejoin the tip
  if (last >= head) return

  let scanned = 0
  let hits = 0
  for (let b = last + 1; b <= head; b++) {
    if (scanned >= maxBlocksPerTick) break
    let block: any
    try {
      block = await rpcCall('eth_getBlockByNumber', [HEX(b), true], rpcs, useProxy)
    } catch (e) {
      console.warn(`[native ${chainKey}] block ${b} failed, retry next tick:`, (e as Error).message)
      break // don't advance — retry this block next cycle
    }
    if (!block) break
    const tsMs = Number(BigInt(block.timestamp ?? '0x0')) * 1000
    const price = priceForDay(asset, tsMs)
    const recs: any[] = []
    for (const tx of block.transactions ?? []) {
      if (!tx || typeof tx !== 'object' || !tx.hash) continue
      const to = (tx.to ?? '').toLowerCase()
      const from = (tx.from ?? '').toLowerCase()
      const wTo = to && watched.has(to) ? byAddr.get(to) : undefined
      const wFrom = from && watched.has(from) ? byAddr.get(from) : undefined
      if (!wTo && !wFrom) continue
      const wei = BigInt(tx.value ?? '0x0')
      if (wei === 0n) continue // contract call with no native value moved
      const amount = Number(wei) / WEI
      if (!(amount > 0)) continue
      const w = wTo ?? wFrom! // a deposit (to watched) takes priority for labelling
      recs.push({
        chain: chainKey,
        tx_hash: tx.hash,
        log_index: -1, // sentinel: native value transfer, never collides with a real log row
        token: asset,
        from_addr: from,
        to_addr: to,
        counterparty: wTo ? from : to,
        amount,
        usd: amount * price,
        watch_id: w.id,
        label: w.label,
        category: w.category,
        direction: wTo ? 'in' : 'out',
        block: b,
        ts: Date.now(),
      })
    }
    if (recs.length) {
      const insert = db.transaction((items: any[]) => {
        for (const rec of items) {
          const r = stmt.insertTransfer.run(rec)
          if (r.changes > 0) emitTransfer(rec)
        }
      })
      // chunk + yield so a high-volume block can't freeze the loop (see evm.ts)
      for (let i = 0; i < recs.length; i += 300) {
        insert(recs.slice(i, i + 300))
        if (i + 300 < recs.length) await new Promise((r) => setImmediate(r))
      }
      hits += recs.length
    }
    scanned++
    stateSet(stateKey, b)
    last = b
    if (b < head) await new Promise((r) => setTimeout(r, 30)) // breathe between heavy full-block parses
  }
  if (hits) console.log(`[native ${chainKey}] +${hits} ${asset} transfers (scanned ${scanned} blocks → ${last})`)
}

function startNativeChain(chainKey: string, asset: string, rpcs: string[], useProxy: boolean, maxBlocksPerTick: number) {
  const loop = async () => {
    try {
      await scanNativeOnce(chainKey, asset, rpcs, useProxy, maxBlocksPerTick, 40)
    } catch (e) {
      console.warn(`[native ${chainKey}] cycle error:`, (e as Error).message)
    } finally {
      setTimeout(loop, config.evmPollMs)
    }
  }
  loop()
}

export function startNative() {
  if ((process.env.NATIVE_ENABLED ?? '1') === '0') return
  console.log('[native] ETH + BNB native-coin deposit scanners active')
  startNativeChain('ETH', 'ETH', config.evmRpcs, false, 6)
  if (config.bscEnabled) startNativeChain('BSC', 'BNB', config.bscRpcs, true, 6) // BSC via proxy
}
