import { config, TRANSFER_TOPIC } from '../config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { rpc, pad, tokenByAddress, toUnits } from './evm.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Deep historical backfill (Ethereum).
//
// The forward indexer keeps up with the chain head; this worker walks BACKWARD
// from the boot-time head until `deepBackfillDays` of real history is indexed.
// It uses adaptive getLogs ranges: starts wide (cheap for low-activity casino
// wallets), bisects on RPC errors (busy exchange wallets), and grows again on
// success. Progress persists in sync_state, so restarts resume where they left
// off. Historical rows are NOT pushed to the SSE feed.
//
// Timestamps are derived from block numbers (12s slots post-merge) — accurate
// to within seconds, honest for bucketing and 7d/30d windows.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_MS = 12_000
const RANGE_FLOOR = 40
const RANGE_CAP = 20_000

async function getLogsRange(
  tokens: string[],
  watched: string[],
  from: number,
  to: number,
  topicPos: 1 | 2,
): Promise<any[]> {
  // wide ranges need public nodes — Alchemy free tier caps getLogs at 10 blocks
  return rpc(
    'eth_getLogs',
    [
      {
        address: tokens,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics:
          topicPos === 2
            ? [TRANSFER_TOPIC, null, watched.map(pad)]
            : [TRANSFER_TOPIC, watched.map(pad), null],
      },
    ],
    config.evmWideRpcs,
  )
}

async function insertHistorical(logs: any[], byAddr: Map<string, WatchRow>, anchorBlock: number, anchorTs: number): Promise<number> {
  const tx = db.transaction((items: any[]): number => {
    let n = 0
    for (const log of items) {
      const token = tokenByAddress(log.address)
      if (!token) continue
      const fromA = '0x' + log.topics[1].slice(26)
      const toA = '0x' + log.topics[2].slice(26)
      const watchTo = byAddr.get(toA.toLowerCase())
      const watchFrom = byAddr.get(fromA.toLowerCase())
      const w = watchTo ?? watchFrom
      if (!w) continue
      const amount = toUnits(log.data, token.decimals)
      if (amount <= 0) continue
      const block = Number(BigInt(log.blockNumber))
      const r = stmt.insertTransfer.run({
        chain: 'ETH',
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
        direction: watchTo ? 'in' : 'out',
        block,
        ts: anchorTs - (anchorBlock - block) * BLOCK_MS,
      })
      n += r.changes
    }
    return n
  })
  // chunk + yield: a wide adaptive range can return tens of thousands of logs; one
  // synchronous transaction over all of them froze the loop ~90s+ on the 37M-row
  // table (cold cache). Chunk so the event loop stays responsive (matches tronrpc).
  let added = 0
  for (let i = 0; i < logs.length; i += 300) {
    added += tx(logs.slice(i, i + 300)) as number
    if (i + 300 < logs.length) await new Promise((r) => setImmediate(r))
  }
  return added
}

// Walk one address segment backward for a bounded number of ranges, then yield
// (so segments interleave). Returns true while the segment still has history to
// index, false when complete. Each segment keeps its own adaptive range + cursor
// so the sparse casino set never inherits the exchange set's collapsed range.
async function backfillSegment(
  seg: string,
  rows: WatchRow[],
  anchorBlock: number,
  anchorTs: number,
  target: number,
  maxOps: number,
): Promise<boolean> {
  if (rows.length === 0) return false
  const byAddr = new Map(rows.map((r) => [r.address.toLowerCase(), r]))
  const watched = rows.map((r) => r.address.toLowerCase())
  const tokens = config.evmTokens.map((t) => t.address)

  let cursor = Number(stateGet(`backfill:${seg}:cursor`) ?? anchorBlock)
  if (cursor <= target) {
    const doneCount = Number(stateGet(`backfill:${seg}:done`) ?? 0)
    if (doneCount && rows.length >= doneCount + 5) {
      console.log(`[backfill:${seg}] watchlist grew ${doneCount} → ${rows.length}, rescanning history`)
      cursor = anchorBlock
      stateSet(`backfill:${seg}:cursor`, cursor)
    } else {
      if (!doneCount) stateSet(`backfill:${seg}:done`, rows.length)
      return false
    }
  }

  let range = Number(stateGet(`backfill:${seg}:range`) ?? config.deepBackfillStartRange)
  let failsAtFloor = 0
  let ops = 0
  while (cursor > target && ops < maxOps) {
    ops++
    const from = Math.max(target, cursor - range)
    const to = cursor
    try {
      const [deposits, withdrawals] = await Promise.all([
        getLogsRange(tokens, watched, from, to, 2),
        getLogsRange(tokens, watched, from, to, 1),
      ])
      const added = await insertHistorical([...deposits, ...withdrawals], byAddr, anchorBlock, anchorTs)
      cursor = from - 1
      stateSet(`backfill:${seg}:cursor`, cursor)
      range = Math.min(RANGE_CAP, Math.ceil(range * 1.5))
      stateSet(`backfill:${seg}:range`, range)
      failsAtFloor = 0
      if (added > 0) {
        const daysLeft = ((cursor - target) * BLOCK_MS) / 86_400_000
        console.log(`[backfill:${seg}] +${added} transfers · ${Math.max(0, daysLeft).toFixed(1)}d of history left`)
      }
    } catch {
      if (range > RANGE_FLOOR) {
        range = Math.max(RANGE_FLOOR, Math.floor(range / 2))
        stateSet(`backfill:${seg}:range`, range)
      } else if (++failsAtFloor >= 4) {
        cursor = from - 1
        stateSet(`backfill:${seg}:cursor`, cursor)
        failsAtFloor = 0
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (cursor <= target) {
    stateSet(`backfill:${seg}:done`, rows.length)
    console.log(`[backfill:${seg}] complete — ${config.deepBackfillDays}d indexed`)
    return false
  }
  return true
}

export async function runBackfill() {
  if (config.deepBackfillDays <= 0) return
  const rows = stmt.watchByChain.all('ETH') as WatchRow[]
  if (rows.length === 0) return

  let anchorBlock = Number(stateGet('backfill:anchor') ?? 0)
  let anchorTs = Number(stateGet('backfill:anchorTs') ?? 0)
  if (!anchorBlock) {
    anchorBlock = Number(BigInt(await rpc('eth_blockNumber', [])))
    anchorTs = Date.now()
    stateSet('backfill:anchor', anchorBlock)
    stateSet('backfill:anchorTs', anchorTs)
  }
  const target = anchorBlock - Math.ceil((config.deepBackfillDays * 86_400_000) / BLOCK_MS)

  // one-time migration: seed both segment cursors from the old combined cursor
  // so we don't re-scan history already indexed by the pre-split backfill
  if (stateGet('backfill:cursor') && !stateGet('backfill:cas:cursor')) {
    const old = String(stateGet('backfill:cursor'))
    stateSet('backfill:cas:cursor', old)
    stateSet('backfill:exch:cursor', old)
    console.log('[backfill] migrated to segmented cursors (casino fast-track + exchange)')
  }

  // PRIORITY: casinos / services / whales are sparse → wide ranges → fast.
  // The dense exchange set runs only once the casino history is caught up, so
  // exchange volume never throttles the casino backfill that powers the UI.
  const casinoRows = rows.filter((r) => r.category !== 'exchange')
  const exchangeRows = rows.filter((r) => r.category === 'exchange')
  const casinoBusy = await backfillSegment('cas', casinoRows, anchorBlock, anchorTs, target, 400)
  if (!casinoBusy) await backfillSegment('exch', exchangeRows, anchorBlock, anchorTs, target, 120)
}

export function startBackfill() {
  // initial pass + periodic re-check (catches watchlist growth after harvests)
  const loop = async () => {
    try {
      await runBackfill()
    } catch (e) {
      console.warn('[backfill] cycle error:', (e as Error).message)
    } finally {
      setTimeout(loop, 120_000)
    }
  }
  setTimeout(loop, 10_000) // let the forward indexer & harvester boot first
}
