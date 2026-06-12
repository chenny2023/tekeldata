import { config } from '../config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'

class RateLimited extends Error {}

async function tronGet(path: string): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.tronKey) headers['TRON-PRO-API-KEY'] = config.tronKey
  const res = await fetch(config.tronApi + path, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 429) throw new RateLimited('429')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Process ONE watched Tron address per call (round-robin) to stay friendly with
// the keyless TronGrid rate limit. Returns true if it actually hit the network.
let rrIndex = 0
export async function runTronOnce(): Promise<boolean> {
  const rows = stmt.watchByChain.all('TRON') as WatchRow[]
  if (rows.length === 0) return false
  const w = rows[rrIndex % rows.length]
  rrIndex++
  const usdt = config.tronUsdt

  const stateKey = `tron:${w.address}:lastTs`
  let minTs = Number(stateGet(stateKey) ?? 0)
  if (minTs === 0) minTs = Date.now() - config.tronBackfillHours * 3600_000

  try {
    let totalAdded = 0
    // paginate: up to tronPagesPerTick pages per visit, advancing minTs each page
    // so progress persists even if a later page rate-limits
    for (let page = 0; page < config.tronPagesPerTick; page++) {
      const url =
        `/v1/accounts/${w.address}/transactions/trc20` +
        `?limit=50&order_by=block_timestamp,asc&min_timestamp=${minTs + 1}` +
        `&contract_address=${usdt.address}`
      const json = await tronGet(url)
      const data: any[] = json.data ?? []
      let maxTs = minTs
      let added = 0

      const insert = db.transaction((items: any[]) => {
        for (const t of items) {
          const ts = Number(t.block_timestamp)
          if (ts > maxTs) maxTs = ts
          const fromA = t.from
          const toA = t.to
          const isIn = toA === w.address
          const isOut = fromA === w.address
          if (!isIn && !isOut) continue
          const decimals = t.token_info?.decimals ?? usdt.decimals
          const amount = Number(t.value) / 10 ** decimals
          if (!(amount > 0)) continue
          const rec = {
            chain: 'TRON',
            tx_hash: t.transaction_id,
            log_index: 0,
            token: t.token_info?.symbol ?? 'USDT',
            from_addr: fromA,
            to_addr: toA,
            counterparty: isIn ? fromA : toA,
            amount,
            usd: amount,
            watch_id: w.id,
            label: w.label,
            category: w.category,
            direction: isIn ? 'in' : 'out',
            block: 0,
            ts,
          }
          const r = stmt.insertTransfer.run(rec)
          if (r.changes > 0) {
            // only near-real-time rows hit the live SSE feed
            if (Date.now() - ts < 600_000) emitTransfer(rec)
            added++
          }
        }
      })
      insert(data)
      totalAdded += added
      if (maxTs > minTs) {
        minTs = maxTs
        stateSet(stateKey, maxTs)
      }
      if (data.length < 50) break // caught up
      await new Promise((r) => setTimeout(r, 400))
    }
    if (totalAdded) console.log(`[tron] ${w.label}: +${totalAdded} transfers`)
    return true
  } catch (e) {
    if (e instanceof RateLimited) {
      console.warn(`[tron] ${w.label}: rate-limited, backing off`)
      return false
    }
    console.warn(`[tron] ${w.label} failed:`, (e as Error).message)
    return true
  }
}

// Real TRC20 USDT balance (reserves) for a Tron account
export async function tronBalanceUsd(address: string): Promise<number> {
  try {
    const json = await tronGet(`/v1/accounts/${address}`)
    const acct = json.data?.[0]
    if (!acct) return 0
    const trc20: Array<Record<string, string>> = acct.trc20 ?? []
    for (const entry of trc20) {
      const raw = entry[config.tronUsdt.address]
      if (raw != null) return Number(raw) / 10 ** config.tronUsdt.decimals
    }
    return 0
  } catch {
    return 0
  }
}

export function startTron() {
  let backoff = config.tronPollMs
  const loop = async () => {
    let ok = true
    try {
      ok = await runTronOnce()
    } catch (e) {
      console.warn('[tron] cycle error:', (e as Error).message)
    } finally {
      // exponential backoff on rate-limit, reset on success
      backoff = ok ? config.tronPollMs : Math.min(backoff * 2, 60_000)
      setTimeout(loop, backoff)
    }
  }
  loop()
}
