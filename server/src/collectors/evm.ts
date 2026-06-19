import { config, TRANSFER_TOPIC } from '../config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'

let rpcIdx = 0
export async function rpc(
  method: string,
  params: unknown[],
  urls: string[] = config.evmRpcs,
  tries = urls.length * 2,
): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    const url = urls[rpcIdx % urls.length]
    rpcIdx++
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error.message || 'rpc error')
      return json.result
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

export const pad = (addr: string) => '0x000000000000000000000000' + addr.toLowerCase().replace(/^0x/, '')
export const tokenByAddress = (a: string) =>
  config.evmTokens.find((t) => t.address.toLowerCase() === a.toLowerCase())
const tokenBySymbol = tokenByAddress

export function toUnits(dataHex: string, decimals: number): number {
  const v = BigInt(dataHex.length ? dataHex : '0x0')
  // keep precision: integer part + fractional
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = Number(v % base) / Number(base)
  return Number(whole) + frac
}

async function getLogs(addresses: string[], fromBlock: number, toBlock: number, topicPos: 1 | 2, watched: string[]) {
  return rpc('eth_getLogs', [
    {
      address: addresses,
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      topics:
        topicPos === 2
          ? [TRANSFER_TOPIC, null, watched.map(pad)] // to = watched  → deposit
          : [TRANSFER_TOPIC, watched.map(pad), null], // from = watched → withdrawal
    },
  ])
}

export async function runEvmOnce() {
  const rows = stmt.watchByChain.all('ETH') as WatchRow[]
  if (rows.length === 0) return
  const byAddr = new Map(rows.map((r) => [r.address.toLowerCase(), r]))
  const watched = rows.map((r) => r.address.toLowerCase())
  const tokenAddrs = config.evmTokens.map((t) => t.address)

  const head = Number(BigInt(await rpc('eth_blockNumber', [])))
  let last = Number(stateGet('evm:lastBlock') ?? 0)
  if (last === 0) last = head - config.evmBackfillBlocks
  if (last >= head) return

  let processed = 0
  let ranges = 0
  for (let from = last + 1; from <= head; from += config.evmChunk) {
    if (ranges >= config.evmMaxRangesPerTick) break // catch up gradually across ticks
    ranges++
    const to = Math.min(from + config.evmChunk - 1, head)
    let logs: any[] = []
    try {
      const [deposits, withdrawals] = await Promise.all([
        getLogs(tokenAddrs, from, to, 2, watched),
        getLogs(tokenAddrs, from, to, 1, watched),
      ])
      logs = [...deposits, ...withdrawals]
    } catch (e) {
      console.warn(`[evm] getLogs ${from}-${to} failed, will retry next tick:`, (e as Error).message)
      break // stop advancing; retry this range next cycle
    }

    const insert = db.transaction((items: any[]) => {
      for (const log of items) {
        const token = tokenBySymbol(log.address)
        if (!token) continue
        const fromA = '0x' + log.topics[1].slice(26)
        const toA = '0x' + log.topics[2].slice(26)
        const watchTo = byAddr.get(toA.toLowerCase())
        const watchFrom = byAddr.get(fromA.toLowerCase())
        const w = watchTo ?? watchFrom
        if (!w) continue
        const direction = watchTo ? 'in' : 'out'
        const counterparty = watchTo ? fromA : toA
        const amount = toUnits(log.data, token.decimals)
        if (amount <= 0) continue
        const rec = {
          chain: 'ETH',
          tx_hash: log.transactionHash,
          log_index: Number(BigInt(log.logIndex ?? '0x0')),
          token: token.symbol,
          from_addr: fromA,
          to_addr: toA,
          counterparty,
          amount,
          usd: amount, // stablecoin 1:1
          watch_id: w.id,
          label: w.label,
          category: w.category,
          direction,
          block: Number(BigInt(log.blockNumber)),
          ts: Date.now(),
        }
        const r = stmt.insertTransfer.run(rec)
        if (r.changes > 0) emitTransfer(rec)
      }
    })
    // Insert in chunks, yielding the event loop between them. A wide range (or a
    // post-downtime catch-up) can return thousands of logs; one synchronous
    // transaction over all of them — each row touching 5 indexes on the 37M-row
    // table — froze the loop for ~90s+ on a cold cache (healthcheck 000). Chunking
    // + setImmediate keeps the loop responsive while indexing (matches tronrpc).
    for (let i = 0; i < logs.length; i += 300) {
      insert(logs.slice(i, i + 300))
      if (i + 300 < logs.length) await new Promise((r) => setImmediate(r))
    }
    processed += logs.length
    stateSet('evm:lastBlock', to)
    last = to
    if (to < head) await new Promise((r) => setTimeout(r, config.evmChunkDelayMs))
  }
  if (processed) console.log(`[evm] indexed up to block ${last} (+${processed} logs)`)
}

// Real on-chain stablecoin balance (reserves) via balanceOf eth_call
export async function evmBalanceUsd(address: string): Promise<number> {
  let total = 0
  for (const t of config.evmTokens) {
    try {
      const data = '0x70a08231' + pad(address).slice(2)
      const res = await rpc('eth_call', [{ to: t.address, data }, 'latest'])
      total += toUnits(res, t.decimals)
    } catch {
      /* skip token on error */
    }
  }
  return total
}

export function startEvm() {
  const loop = async () => {
    try {
      await runEvmOnce()
    } catch (e) {
      console.warn('[evm] cycle error:', (e as Error).message)
    } finally {
      setTimeout(loop, config.evmPollMs)
    }
  }
  loop()
}
