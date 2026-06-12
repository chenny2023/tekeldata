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

function insertHistorical(logs: any[], byAddr: Map<string, WatchRow>, anchorBlock: number, anchorTs: number): number {
  let added = 0
  const tx = db.transaction((items: any[]) => {
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
      added += r.changes
    }
  })
  tx(logs)
  return added
}

export async function runBackfill() {
  if (config.deepBackfillDays <= 0) return
  const rows = stmt.watchByChain.all('ETH') as WatchRow[]
  if (rows.length === 0) return
  const byAddr = new Map(rows.map((r) => [r.address.toLowerCase(), r]))
  const watched = rows.map((r) => r.address.toLowerCase())
  const tokens = config.evmTokens.map((t) => t.address)

  // anchor = head at first backfill run (fixed so the cursor is monotonic)
  let anchorBlock = Number(stateGet('backfill:anchor') ?? 0)
  let anchorTs = Number(stateGet('backfill:anchorTs') ?? 0)
  if (!anchorBlock) {
    anchorBlock = Number(BigInt(await rpc('eth_blockNumber', [])))
    anchorTs = Date.now()
    stateSet('backfill:anchor', anchorBlock)
    stateSet('backfill:anchorTs', anchorTs)
  }
  const target = anchorBlock - Math.ceil((config.deepBackfillDays * 86_400_000) / BLOCK_MS)
  let cursor = Number(stateGet('backfill:cursor') ?? anchorBlock)

  if (cursor <= target) {
    // done — but if the watchlist has grown meaningfully (label harvest), rescan
    const doneCount = Number(stateGet('backfill:doneWatchCount') ?? 0)
    if (doneCount && rows.length >= doneCount + 10) {
      console.log(`[backfill] watchlist grew ${doneCount} → ${rows.length}, rescanning history`)
      cursor = anchorBlock
      stateSet('backfill:cursor', cursor)
    } else {
      if (!doneCount) stateSet('backfill:doneWatchCount', rows.length)
      return
    }
  }

  let range = Number(stateGet('backfill:range') ?? config.deepBackfillStartRange)
  let failsAtFloor = 0
  console.log(
    `[backfill] walking ${cursor} → ${target} (${(((cursor - target) * BLOCK_MS) / 86_400_000).toFixed(1)}d of history remaining)`,
  )

  while (cursor > target) {
    const from = Math.max(target, cursor - range)
    const to = cursor
    try {
      const [deposits, withdrawals] = await Promise.all([
        getLogsRange(tokens, watched, from, to, 2),
        getLogsRange(tokens, watched, from, to, 1),
      ])
      const added = insertHistorical([...deposits, ...withdrawals], byAddr, anchorBlock, anchorTs)
      cursor = from - 1
      stateSet('backfill:cursor', cursor)
      range = Math.min(RANGE_CAP, Math.ceil(range * 1.5))
      stateSet('backfill:range', range)
      failsAtFloor = 0
      if (added > 0) {
        const daysLeft = ((cursor - target) * BLOCK_MS) / 86_400_000
        console.log(`[backfill] blocks ${from}-${to}: +${added} transfers · ${Math.max(0, daysLeft).toFixed(1)}d left`)
      }
    } catch (e) {
      if (range > RANGE_FLOOR) {
        range = Math.max(RANGE_FLOOR, Math.floor(range / 2)) // bisect on error
        stateSet('backfill:range', range)
      } else {
        failsAtFloor++
        if (failsAtFloor >= 4) {
          console.warn(`[backfill] blocks ${from}-${to} unreadable after retries, skipping range`)
          cursor = from - 1
          stateSet('backfill:cursor', cursor)
          failsAtFloor = 0
        }
      }
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  stateSet('backfill:doneWatchCount', rows.length)
  console.log(`[backfill] complete — ${config.deepBackfillDays}d of ETH history indexed`)
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
