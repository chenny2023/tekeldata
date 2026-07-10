import { TRANSFER_TOPIC } from '../config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'
import { webFetch } from '../net.ts'
import { recordOp } from '../opmetrics.ts'
import { config } from '../config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Generic EVM-chain collector factory. One instance per EVM chain (BSC, BASE,
// Arbitrum, Optimism, …). Each instance runs a forward indexer + deep backfill
// over its stablecoin Transfer logs, exactly like the ETH/BSC collectors, but
// parameterised so adding a chain is config, not code.
//
//   • indexes EVERY 0x watchlist address (casinos reuse hot wallets across EVM
//     chains, so one watchlist entry accrues flow on every chain we index)
//   • per-chain decimals (BEP20 stables are 18-dec; L2 USDC is 6-dec)
//   • adaptive getLogs range (public nodes vary 5–2000 block caps)
//   • block time self-calibrated at boot from two real blocks, so timestamps
//     stay sane on fast L2s (Arbitrum ~0.25s) without per-block lookups
//   • optional proxy routing (some public nodes are only reachable via proxy)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvmToken { symbol: string; address: string; decimals: number }
export interface EvmChainCfg {
  key: string // 'BSC' | 'BASE' | 'ARB' | 'OP' — stored as transfers.chain + sync_state prefix
  name: string
  rpcs: string[]
  tokens: EvmToken[]
  explorerHosts: string[] // circus.fyi tx links for this chain (for attribution)
  maxRange: number
  pollMs: number
  maxRangesPerTick: number
  backfillBlocks: number // forward boot window
  nominalBlockMs: number // fallback if calibration fails
  useProxy: boolean
}

const RANGE_FLOOR = 50
const pad = (addr: string) => '0x000000000000000000000000' + addr.toLowerCase().replace(/^0x/, '')

export interface EvmChain {
  key: string
  explorerHosts: string[]
  stable: string[] // lowercased stablecoin contract addresses (for tx resolution)
  rpc: (method: string, params: unknown[]) => Promise<any>
  balanceUsd: (address: string) => Promise<number>
  start: () => void
}

export function makeEvmChain(cfg: EvmChainCfg): EvmChain {
  const tokenByAddr = (a: string) => cfg.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase())
  const sk = (s: string) => `${cfg.key.toLowerCase()}:${s}`
  let rpcIdx = 0
  let blockMs = cfg.nominalBlockMs

  async function rpc(method: string, params: unknown[], tries = cfg.rpcs.length * 2): Promise<any> {
    let lastErr: unknown
    for (let i = 0; i < tries; i++) {
      const url = cfg.rpcs[rpcIdx % cfg.rpcs.length]
      rpcIdx++
      try {
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        }
        const res = cfg.useProxy ? await webFetch(url, init) : await fetch(url, init)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as any
        if (json.error) throw new Error(json.error.message || 'rpc error')
        // Defensive: some public providers return a non-array result for eth_getLogs
        // (null, an object, an error-ish payload). Returning that would make the caller's
        // `[...deposits, ...withdrawals]` throw "not iterable" mid-loop and the forward
        // loop could retry it tight enough to STARVE the event loop (this took the site
        // down 2026-06-21). Treat it as a provider failure so we rotate to the next RPC,
        // or — if all fail — throw cleanly so the caller backs off. Never return junk.
        if (method === 'eth_getLogs' && !Array.isArray(json.result)) {
          throw new Error('eth_getLogs returned a non-array result (bad provider)')
        }
        return json.result
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }

  function toUnits(dataHex: string, decimals: number): number {
    const v = BigInt(dataHex && dataHex !== '0x' ? dataHex : '0x0')
    const base = 10n ** BigInt(decimals)
    return Number(v / base) + Number(v % base) / Number(base)
  }

  const evmWatched = (): WatchRow[] =>
    (stmt.activeWatch.all() as WatchRow[]).filter((r) => /^0x[0-9a-fA-F]{40}$/.test(r.address))

  async function getLogs(from: number, to: number, topicPos: 1 | 2, watched: string[]) {
    return rpc('eth_getLogs', [
      {
        address: cfg.tokens.map((t) => t.address),
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: topicPos === 2 ? [TRANSFER_TOPIC, null, watched.map(pad)] : [TRANSFER_TOPIC, watched.map(pad), null],
      },
    ])
  }

  function insertLogs(logs: any[], byAddr: Map<string, WatchRow>, anchorBlock: number, anchorTs: number, emitRecent: boolean): number {
    let added = 0
    const tx = db.transaction((items: any[]) => {
      for (const log of items) {
        const token = tokenByAddr(log.address)
        if (!token) continue
        const fromA = '0x' + log.topics[1].slice(26)
        const toA = '0x' + log.topics[2].slice(26)
        const watchTo = byAddr.get(toA.toLowerCase())
        const watchFrom = byAddr.get(fromA.toLowerCase())
        const w = watchTo ?? watchFrom
        if (!w) continue
        const amount = toUnits(log.data, token.decimals)
        if (!(amount > 0)) continue
        const block = Number(BigInt(log.blockNumber))
        const ts = anchorTs - (anchorBlock - block) * blockMs
        const rec = {
          chain: cfg.key,
          tx_hash: log.transactionHash,
          log_index: Number(BigInt(log.logIndex ?? '0x0')),
          token: token.symbol,
          from_addr: fromA,
          to_addr: toA,
          counterparty: watchTo ? fromA : toA,
          amount,
          usd: amount,
          watch_id: w.id,
          label: w.label,
          category: w.category,
          direction: watchTo ? ('in' as const) : ('out' as const),
          block,
          ts,
        }
        const r = stmt.insertTransfer.run(rec)
        if (r.changes > 0) {
          added++
          if (emitRecent && Date.now() - ts < 600_000) emitTransfer(rec)
        }
      }
    })
    tx(logs)
    return added
  }

  // measure real average block time from two recent blocks (self-calibration)
  async function calibrateBlockMs(head: number) {
    try {
      const span = Math.min(50_000, Math.max(2_000, Math.floor(head / 10)))
      const [a, b] = await Promise.all([
        rpc('eth_getBlockByNumber', ['0x' + (head - span).toString(16), false]),
        rpc('eth_getBlockByNumber', ['0x' + head.toString(16), false]),
      ])
      const ta = Number(BigInt(a.timestamp)) * 1000
      const tb = Number(BigInt(b.timestamp)) * 1000
      if (tb > ta) {
        blockMs = (tb - ta) / span
        stateSet(sk('blockMs'), Math.round(blockMs))
      }
    } catch {
      /* keep nominal */
    }
  }

  let fwdRange = 0
  async function forwardOnce() {
    const watched = evmWatched()
    if (watched.length === 0) return
    const byAddr = new Map(watched.map((w) => [w.address.toLowerCase(), w]))
    const hexes = watched.map((w) => w.address.toLowerCase())

    const head = Number(BigInt(await rpc('eth_blockNumber', [])))
    let last = Number(stateGet(sk('lastBlock')) ?? 0)
    if (last === 0) last = head - cfg.backfillBlocks
    if (last >= head) return

    if (!fwdRange) fwdRange = cfg.maxRange
    let ranges = 0
    let from = last + 1
    while (from <= head && ranges < cfg.maxRangesPerTick) {
      ranges++
      const to = Math.min(from + fwdRange - 1, head)
      try {
        const deposits = await getLogs(from, to, 2, hexes)
        await new Promise((r) => setTimeout(r, 200))
        const withdrawals = await getLogs(from, to, 1, hexes)
        const added = insertLogs([...deposits, ...withdrawals], byAddr, head, Date.now(), true)
        stateSet(sk('lastBlock'), to)
        if (added) console.log(`[${cfg.key.toLowerCase()}] blocks ${from}-${to}: +${added} transfers`)
        from = to + 1
        fwdRange = Math.min(cfg.maxRange, Math.ceil(fwdRange * 1.4))
      } catch (e) {
        if (fwdRange > RANGE_FLOOR) { fwdRange = Math.max(RANGE_FLOOR, Math.floor(fwdRange / 2)); continue }
        throw e
      }
    }
  }

  async function backfillOnce() {
    if (config.deepBackfillDays <= 0) return
    const watched = evmWatched()
    if (watched.length === 0) return
    const byAddr = new Map(watched.map((w) => [w.address.toLowerCase(), w]))
    const hexes = watched.map((w) => w.address.toLowerCase())

    let anchorBlock = Number(stateGet(sk('anchor')) ?? 0)
    let anchorTs = Number(stateGet(sk('anchorTs')) ?? 0)
    if (!anchorBlock) {
      anchorBlock = Number(BigInt(await rpc('eth_blockNumber', [])))
      anchorTs = Date.now()
      await calibrateBlockMs(anchorBlock)
      stateSet(sk('anchor'), anchorBlock)
      stateSet(sk('anchorTs'), anchorTs)
    } else {
      blockMs = Number(stateGet(sk('blockMs')) ?? cfg.nominalBlockMs) || cfg.nominalBlockMs
    }
    const target = anchorBlock - Math.ceil((config.deepBackfillDays * 86_400_000) / blockMs)
    let cursor = Number(stateGet(sk('cursor')) ?? anchorBlock)

    if (cursor <= target) {
      const doneCount = Number(stateGet(sk('doneWatchCount')) ?? 0)
      if (doneCount && watched.length >= doneCount + 5) {
        cursor = anchorBlock
        stateSet(sk('cursor'), cursor)
      } else {
        if (!doneCount) stateSet(sk('doneWatchCount'), watched.length)
        return
      }
    }

    let range = cfg.maxRange
    let failsAtFloor = 0
    console.log(`[${cfg.key.toLowerCase()}] backfill ${cursor} → ${target} (${(((cursor - target) * blockMs) / 86_400_000).toFixed(1)}d remaining)`)
    let ops = 0
    while (cursor > target && ops < 40) {
      ops++
      const from = Math.max(target, cursor - range)
      try {
        const deposits = await getLogs(from, cursor, 2, hexes)
        await new Promise((r) => setTimeout(r, 250))
        const withdrawals = await getLogs(from, cursor, 1, hexes)
        const added = insertLogs([...deposits, ...withdrawals], byAddr, anchorBlock, anchorTs, false)
        cursor = from - 1
        stateSet(sk('cursor'), cursor)
        range = Math.min(cfg.maxRange, Math.ceil(range * 1.4))
        failsAtFloor = 0
        if (added > 0) {
          const daysLeft = Math.max(0, ((cursor - target) * blockMs) / 86_400_000)
          console.log(`[${cfg.key.toLowerCase()}] backfill +${added} · ${daysLeft.toFixed(1)}d left`)
        }
      } catch {
        if (range > RANGE_FLOOR) range = Math.max(RANGE_FLOOR, Math.floor(range / 2))
        else if (++failsAtFloor >= 4) { cursor = from - 1; stateSet(sk('cursor'), cursor); failsAtFloor = 0 }
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    if (cursor <= target) {
      stateSet(sk('doneWatchCount'), watched.length)
      console.log(`[${cfg.key.toLowerCase()}] backfill complete — ${config.deepBackfillDays}d of ${cfg.name} history indexed`)
    }
  }

  async function balanceUsd(address: string): Promise<number> {
    let total = 0
    for (const t of cfg.tokens) {
      try {
        const data = '0x70a08231' + pad(address).slice(2)
        const res = await rpc('eth_call', [{ to: t.address, data }, 'latest'])
        total += toUnits(res, t.decimals)
      } catch { /* skip */ }
    }
    return total
  }

  function start() {
    console.log(`[${cfg.key.toLowerCase()}] ${cfg.name} collector active${cfg.useProxy ? ' (via proxy)' : ''}`)
    const forward = async () => {
      try { await forwardOnce() } catch (e) { recordOp(`rpc.forward_error.${cfg.key.toLowerCase()}`); console.warn(`[${cfg.key.toLowerCase()}] forward error:`, (e as Error).message) }
      finally { setTimeout(forward, cfg.pollMs) }
    }
    forward()
    const backfill = async () => {
      try { await backfillOnce() } catch (e) { console.warn(`[${cfg.key.toLowerCase()}] backfill error:`, (e as Error).message) }
      finally { setTimeout(backfill, 120_000) }
    }
    setTimeout(backfill, 25_000)
  }

  return {
    key: cfg.key,
    explorerHosts: cfg.explorerHosts,
    stable: cfg.tokens.map((t) => t.address.toLowerCase()),
    rpc,
    balanceUsd,
    start,
  }
}
