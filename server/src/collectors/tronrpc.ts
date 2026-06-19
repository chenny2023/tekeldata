import { config, TRANSFER_TOPIC } from '../config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'
import { b58ToHex20, hex20ToB58 } from '../tronaddr.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Tron collector via the EVM-compatible JSON-RPC layer (eth_getLogs).
//
// Verified against TronGrid's public /jsonrpc: topic filtering works and the
// node accepts ranges up to 5000 blocks (~4h at 3s/block). This replaces the
// per-address REST polling with the same wide-scan strategy as Ethereum:
// one getLogs pair covers EVERY watched Tron address, and a deep backfill
// walks history backward. Point TRON_JSONRPC at a dedicated provider
// (e.g. GetBlock with protocol = JSON-RPC) for unlimited rate.
//
// Addresses: watchlist stores base58 (T…); on the wire we use 20-byte hex.
// Timestamps: derived from block numbers (3s Tron slots) against a live anchor.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_MS = 3_000
// Keyless TronGrid public jsonrpc caps eth_getLogs at 10000 results per call, and
// watched Tron casino addresses are dense enough that even ~100 blocks of USDT
// transfers can exceed that. The adaptive range must be able to shrink well below
// 100 to get under the cap — so the floor is small (a couple of blocks).
const RANGE_FLOOR = 2

// Keyless public fallback. The configured TRON_JSONRPC may be a paid/shared provider
// (e.g. GetBlock) that returns 402/401/403/429 once credits or rate limits run out —
// when that happens we don't want Tron indexing to die, so we fall back to TronGrid's
// public jsonrpc for a cooldown window (and re-probe the paid endpoint afterward).
const PUBLIC_TRON_JSONRPC = 'https://api.trongrid.io/jsonrpc'
let fallbackUntil = 0

async function rpcAt(endpoint: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'rpc error')
  return json.result
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const primary = config.tronJsonRpc
  // Already in fallback, or the configured endpoint IS the public one → go straight to public.
  if (primary === PUBLIC_TRON_JSONRPC || Date.now() < fallbackUntil) {
    return rpcAt(PUBLIC_TRON_JSONRPC, method, params)
  }
  try {
    return await rpcAt(primary, method, params)
  } catch (e) {
    // Quota/auth/rate-limit on the paid provider → switch to keyless TronGrid for 30m.
    if (/HTTP (40[1-3]|429)/.test((e as Error).message)) {
      fallbackUntil = Date.now() + 30 * 60_000
      console.warn(`[tronrpc] primary endpoint ${(e as Error).message} — falling back to public TronGrid for 30m`)
      return rpcAt(PUBLIC_TRON_JSONRPC, method, params)
    }
    throw e
  }
}

interface TronWatch {
  row: WatchRow
  hex20: string
}

function watchedTron(): TronWatch[] {
  const rows = stmt.watchByChain.all('TRON') as WatchRow[]
  const out: TronWatch[] = []
  for (const row of rows) {
    try {
      out.push({ row, hex20: b58ToHex20(row.address) })
    } catch {
      console.warn(`[tronrpc] skipping malformed address ${row.address} (${row.label})`)
    }
  }
  return out
}

const pad32 = (hex20: string) => '0x000000000000000000000000' + hex20

async function getLogsRange(
  usdtHex: string,
  watched: string[],
  from: number,
  to: number,
  topicPos: 1 | 2,
): Promise<any[]> {
  return rpc('eth_getLogs', [
    {
      address: usdtHex,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics:
        topicPos === 2
          ? [TRANSFER_TOPIC, null, watched.map(pad32)]
          : [TRANSFER_TOPIC, watched.map(pad32), null],
    },
  ])
}

// Insert in chunks, yielding the event loop between them. Tron USDT is so
// high-volume that a single tick can carry ~15k logs; inserting them all in one
// synchronous better-sqlite3 transaction would block Node's single thread for
// seconds and starve the HTTP server (API/healthcheck timeouts). Chunking +
// setImmediate keeps the loop responsive while indexing.
const INSERT_CHUNK = 1000
async function insertLogs(
  logs: any[],
  byHex: Map<string, WatchRow>,
  anchorBlock: number,
  anchorTs: number,
  emitRecent: boolean,
): Promise<number> {
  const insertChunk = db.transaction((items: any[]) => {
    let n = 0
    for (const log of items) {
      const fromHex = log.topics[1].slice(26).toLowerCase()
      const toHex = log.topics[2].slice(26).toLowerCase()
      const watchTo = byHex.get(toHex)
      const watchFrom = byHex.get(fromHex)
      const w = watchTo ?? watchFrom
      if (!w) continue
      const amount = Number(BigInt(log.data === '0x' ? '0x0' : log.data)) / 1e6 // USDT 6dp
      if (!(amount > 0)) continue
      const block = Number(BigInt(log.blockNumber))
      const ts = anchorTs - (anchorBlock - block) * BLOCK_MS
      const fromB58 = hex20ToB58(fromHex)
      const toB58 = hex20ToB58(toHex)
      const rec = {
        chain: 'TRON',
        tx_hash: log.transactionHash,
        log_index: Number(BigInt(log.logIndex ?? '0x0')),
        token: 'USDT',
        from_addr: fromB58,
        to_addr: toB58,
        counterparty: watchTo ? fromB58 : toB58,
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
        n++
        if (emitRecent && Date.now() - ts < 600_000) emitTransfer(rec)
      }
    }
    return n
  })
  let added = 0
  for (let i = 0; i < logs.length; i += INSERT_CHUNK) {
    added += insertChunk(logs.slice(i, i + INSERT_CHUNK))
    if (i + INSERT_CHUNK < logs.length) await new Promise((r) => setImmediate(r)) // breathe
  }
  return added
}

// One-time migration: v1-collected TRON rows have synthetic block=0/log_index=0
// and would duplicate the jsonrpc rows. Drop them; the backfill below restores
// the same window with real block numbers and log indices.
function migrateFromV1() {
  if (stateGet('tronrpc:migrated')) return
  const n = db.prepare("DELETE FROM transfers WHERE chain='TRON'").run().changes
  for (const row of db.prepare("SELECT key FROM sync_state WHERE key LIKE 'tron:%'").all() as any[]) {
    db.prepare('DELETE FROM sync_state WHERE key=?').run(row.key)
  }
  stateSet('tronrpc:migrated', 1)
  if (n) console.log(`[tronrpc] migrated: dropped ${n} v1 rows — re-indexing with real block data`)
}

// ── forward indexer ───────────────────────────────────────────────────────────
// Adaptive range (like the backfill): more watched addresses → more logs per
// block span, and a fixed range would wedge on "more than 10000 results".
let fwdRange = 0
let fwdFailsAtFloor = 0
export async function runTronRpcOnce() {
  const watched = watchedTron()
  if (watched.length === 0) return
  const byHex = new Map(watched.map((w) => [w.hex20, w.row]))
  const hexes = watched.map((w) => w.hex20)
  const usdtHex = '0x' + b58ToHex20(config.tronUsdt.address)

  const head = Number(BigInt(await rpc('eth_blockNumber', [])))
  let last = Number(stateGet('tronrpc:lastBlock') ?? 0)
  if (last === 0) last = head - 100
  if (last >= head) return

  if (!fwdRange) fwdRange = config.tronMaxRange
  let from = last + 1
  while (from <= head) {
    const to = Math.min(from + fwdRange - 1, head)
    try {
      // sequential (not parallel) to stay under shared-endpoint burst limits
      const deposits = await getLogsRange(usdtHex, hexes, from, to, 2)
      await new Promise((r) => setTimeout(r, 300))
      const withdrawals = await getLogsRange(usdtHex, hexes, from, to, 1)
      const added = await insertLogs([...deposits, ...withdrawals], byHex, head, Date.now(), true)
      stateSet('tronrpc:lastBlock', to)
      if (added) console.log(`[tronrpc] blocks ${from}-${to}: +${added} transfers`)
      from = to + 1
      fwdRange = Math.min(config.tronMaxRange, Math.ceil(fwdRange * 1.5))
      fwdFailsAtFloor = 0
    } catch (e) {
      const msg = (e as Error).message
      // Only the result-size cap is fixable by shrinking the block span. Transient
      // errors (HTTP 429 rate-limit, network/5xx) must NOT shrink or skip — that
      // would silently drop transfers; instead bubble up so the caller backs off
      // and we retry the SAME span.
      const overCap = /more than 10000|exceed|too many|response size|limit exceeded/i.test(msg)
      if (overCap && fwdRange > RANGE_FLOOR) {
        fwdRange = Math.max(RANGE_FLOOR, Math.floor(fwdRange / 2))
        continue
      }
      // Genuinely over-cap even at the floor (a single ultra-dense block) — skip the
      // span after a few tries rather than wedging the forward indexer forever.
      if (overCap && ++fwdFailsAtFloor >= 4) {
        console.warn(`[tronrpc] skipping blocks ${from}-${to} (over cap at floor): ${msg}`)
        stateSet('tronrpc:lastBlock', to)
        from = to + 1
        fwdFailsAtFloor = 0
        continue
      }
      throw e // transient (429/network) or not-yet-at-skip-threshold → back off, no data loss
    }
  }
}

// ── deep historical backfill (mirrors the ETH backfiller) ─────────────────────
export async function runTronBackfill() {
  if (config.deepBackfillDays <= 0) return
  const watched = watchedTron()
  if (watched.length === 0) return
  const byHex = new Map(watched.map((w) => [w.hex20, w.row]))
  const hexes = watched.map((w) => w.hex20)
  const usdtHex = '0x' + b58ToHex20(config.tronUsdt.address)

  let anchorBlock = Number(stateGet('tronrpc:anchor') ?? 0)
  let anchorTs = Number(stateGet('tronrpc:anchorTs') ?? 0)
  if (!anchorBlock) {
    anchorBlock = Number(BigInt(await rpc('eth_blockNumber', [])))
    anchorTs = Date.now()
    stateSet('tronrpc:anchor', anchorBlock)
    stateSet('tronrpc:anchorTs', anchorTs)
  }
  const target = anchorBlock - Math.ceil((config.deepBackfillDays * 86_400_000) / BLOCK_MS)
  let cursor = Number(stateGet('tronrpc:cursor') ?? anchorBlock)

  if (cursor <= target) {
    const doneCount = Number(stateGet('tronrpc:doneWatchCount') ?? 0)
    if (doneCount && watched.length >= doneCount + 5) {
      console.log(`[tronrpc] watchlist grew ${doneCount} → ${watched.length}, rescanning history`)
      cursor = anchorBlock
      stateSet('tronrpc:cursor', cursor)
    } else {
      if (!doneCount) stateSet('tronrpc:doneWatchCount', watched.length)
      return
    }
  }

  let range = config.tronMaxRange
  let failsAtFloor = 0
  console.log(
    `[tronrpc] backfill ${cursor} → ${target} (${(((cursor - target) * BLOCK_MS) / 86_400_000).toFixed(1)}d remaining)`,
  )
  while (cursor > target) {
    const from = Math.max(target, cursor - range)
    try {
      const deposits = await getLogsRange(usdtHex, hexes, from, cursor, 2)
      await new Promise((r) => setTimeout(r, 400))
      const withdrawals = await getLogsRange(usdtHex, hexes, from, cursor, 1)
      const added = await insertLogs([...deposits, ...withdrawals], byHex, anchorBlock, anchorTs, false)
      cursor = from - 1
      stateSet('tronrpc:cursor', cursor)
      range = Math.min(config.tronMaxRange, Math.ceil(range * 1.5))
      failsAtFloor = 0
      if (added > 0) {
        const daysLeft = Math.max(0, ((cursor - target) * BLOCK_MS) / 86_400_000)
        console.log(`[tronrpc] backfill ${from}-${cursor + range}: +${added} · ${daysLeft.toFixed(1)}d left`)
      }
    } catch (e) {
      const overCap = /more than 10000|exceed|too many|response size|limit exceeded/i.test((e as Error).message)
      if (range > RANGE_FLOOR) range = Math.max(RANGE_FLOOR, Math.floor(range / 2))
      // Only skip a span when it's genuinely over the result cap at the floor — not
      // on transient 429/network errors (those just retry after the polite sleep).
      else if (overCap && ++failsAtFloor >= 4) {
        cursor = from - 1
        stateSet('tronrpc:cursor', cursor)
        failsAtFloor = 0
      }
    }
    await new Promise((r) => setTimeout(r, 1200)) // polite on shared jsonrpc
  }
  stateSet('tronrpc:doneWatchCount', watched.length)
  console.log(`[tronrpc] backfill complete — ${config.deepBackfillDays}d of TRON history indexed`)
}

// ── reserves via eth_call balanceOf (replaces v1 account API) ─────────────────
export async function tronRpcBalanceUsd(addressB58: string): Promise<number> {
  try {
    const usdtHex = '0x' + b58ToHex20(config.tronUsdt.address)
    const data = '0x70a08231' + pad32(b58ToHex20(addressB58)).slice(2)
    const res = await rpc('eth_call', [{ to: usdtHex, data }, 'latest'])
    return Number(BigInt(res === '0x' ? '0x0' : res)) / 1e6
  } catch {
    return 0
  }
}

export function startTronRpc() {
  migrateFromV1()
  let backoff = config.tronPollMs
  const forward = async () => {
    let ok = true
    try {
      await runTronRpcOnce()
    } catch (e) {
      ok = false
      console.warn('[tronrpc] forward error:', (e as Error).message)
    } finally {
      // exponential backoff on shared-endpoint rate limits, reset on success
      backoff = ok ? config.tronPollMs : Math.min(backoff * 2, 90_000)
      setTimeout(forward, backoff)
    }
  }
  forward()

  const backfill = async () => {
    try {
      await runTronBackfill()
    } catch (e) {
      console.warn('[tronrpc] backfill error:', (e as Error).message)
    } finally {
      setTimeout(backfill, 120_000)
    }
  }
  setTimeout(backfill, 15_000)
}
