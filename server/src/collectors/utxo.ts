import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { emitTransfer } from '../bus.ts'
import { webFetch } from '../net.ts'
import { priceForDay } from './prices.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Generic UTXO collector (Bitcoin + Litecoin) over the Esplora API. UTXO chains
// have no token contracts and no eth_getLogs, so per watched address we pull its
// recent transactions, net the value moving in/out of the address, and value it
// at the coin's historical (block-time) price. Forward-only, resuming from the
// last seen txid per address. Esplora hosts: blockstream.info (BTC),
// litecoinspace.org (LTC) — both keyless.
// ─────────────────────────────────────────────────────────────────────────────

interface UtxoChain {
  key: string // 'BTC' | 'LTC'
  asset: string // price asset
  apis: string[] // esplora bases, rotated (spreads load + survives one host throttling)
  pollMs: number
  batch: number // addresses processed per poll (clustering grew the BTC set to thousands)
}

const CHAINS: UtxoChain[] = [
  // mempool.space leads for BTC: 50 tx/page (vs blockstream's 25) and gentler rate
  // limits, so backfill catches up ~2× faster; blockstream is the rotation fallback.
  { key: 'BTC', asset: 'BTC', apis: ['https://mempool.space/api', 'https://blockstream.info/api'], pollMs: 20_000, batch: Number(process.env.BTC_INDEX_BATCH ?? 5) },
  { key: 'LTC', asset: 'LTC', apis: ['https://litecoinspace.org/api'], pollMs: 20_000, batch: 1 },
]

const enabled = (key: string) => process.env[`${key}_ENABLED`] !== '0'

let hostRr = 0
async function esplora(apis: string[], path: string): Promise<any | null> {
  for (let i = 0; i < apis.length + 2; i++) {
    const api = apis[hostRr++ % apis.length]
    try {
      const r = await webFetch(api + path, { signal: AbortSignal.timeout(15_000) })
      if (r.ok) return await r.json()
      if (r.status === 404) return null
    } catch {
      /* rotate host + retry */
    }
    await new Promise((res) => setTimeout(res, 1500))
  }
  return null
}

// net the value (sats) flowing into / out of `addr` in one tx, and identify the
// dominant counterparty address on the opposite side
function settle(tx: any, addr: string): { dir: 'in' | 'out'; coins: number; counterparty: string } | null {
  let received = 0
  for (const o of tx.vout ?? []) if (o.scriptpubkey_address === addr) received += o.value ?? 0
  let sent = 0
  for (const i of tx.vin ?? []) if (i.prevout?.scriptpubkey_address === addr) sent += i.prevout.value ?? 0
  if (received === 0 && sent === 0) return null
  const net = received - sent
  if (net > 0) {
    // deposit — counterparty = largest input address that isn't us
    const ins = new Map<string, number>()
    for (const i of tx.vin ?? []) { const a = i.prevout?.scriptpubkey_address; if (a && a !== addr) ins.set(a, (ins.get(a) ?? 0) + (i.prevout.value ?? 0)) }
    const cp = [...ins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'coinbase'
    return { dir: 'in', coins: net / 1e8, counterparty: cp }
  } else {
    const outs = new Map<string, number>()
    for (const o of tx.vout ?? []) { const a = o.scriptpubkey_address; if (a && a !== addr) outs.set(a, (outs.get(a) ?? 0) + (o.value ?? 0)) }
    const cp = [...outs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
    return { dir: 'out', coins: -net / 1e8, counterparty: cp }
  }
}

// how far back to backfill an address the first time we see it (and the cap on a
// single poll's catch-up). High-activity casino wallets do hundreds of tx/week, so
// without pagination we used to capture only the latest ~25 and lose the rest.
const INDEX_HORIZON_DAYS = 14
const BACKFILL_PAGES = 20 // pages per poll for an in-progress backfill (gentle burst; resumed next poll via the saved cursor — a big wallet finishes over several polls)
const FWD_PAGES = 8 // forward-sync cap (steady state only needs a few)
const RETRY_COOLDOWN_MS = 20 * 60_000 // a fetch-failing address is parked this long so it can't block the backfill queue

let rr = 0
async function indexChain(ch: UtxoChain) {
  const watched = (stmt.activeWatch.all() as WatchRow[]).filter((w) => w.chain === ch.key)
  if (watched.length === 0) return
  const cl = ch.key.toLowerCase()
  const now = Date.now()
  // Pick the first address that still needs its one-time deep backfill AND isn't in a
  // failure cooldown (so a single fetch-failing/rate-limited address can't wedge the
  // queue). bf flag + cursor are DB-persisted, so progress survives the frequent
  // redeploys. Once everything is backfilled, round-robin for ongoing forward sync.
  let w = watched.find((x) => {
    if (stateGet(`${cl}:bf:${x.address}`)) return false
    const cd = Number(stateGet(`${cl}:bfcd:${x.address}`) ?? 0)
    return now - cd > RETRY_COOLDOWN_MS
  })
  const isBackfill = !!w
  if (!w) {
    w = watched[rr % watched.length]
    rr++
  }
  const seenKey = `${cl}:seen:${w.address}`
  const bfKey = `${cl}:bf:${w.address}`
  const bfCurKey = `${cl}:bfcur:${w.address}`
  const lastSeen = stateGet(seenKey)
  const horizon = now - INDEX_HORIZON_DAYS * 86_400_000

  // Esplora is newest-first, 25/page. Forward sync stops at lastSeen; a backfill walks
  // toward the 14d horizon a bounded chunk at a time, RESUMING from the saved cursor.
  const fresh: any[] = []
  let newestTop: string | null = null
  let cursor: string | null = isBackfill ? stateGet(bfCurKey) || null : null
  let pages = 0
  let reached = false
  let gotData = false
  const cap = isBackfill ? BACKFILL_PAGES : FWD_PAGES
  while (pages < cap && !reached) {
    const path = cursor ? `/address/${w.address}/txs/chain/${cursor}` : `/address/${w.address}/txs`
    const txs = await esplora(ch.apis, path)
    if (!Array.isArray(txs) || txs.length === 0) break
    gotData = true
    if (!cursor) newestTop = txs[0].txid // top of the address — the forward resume point
    for (const tx of txs) {
      if (!isBackfill && tx.txid === lastSeen) { reached = true; break } // forward-sync stop
      const ts = (tx.status?.block_time ?? Math.floor(now / 1000)) * 1000
      if (tx.status?.block_time && ts < horizon) { reached = true; break } // far enough back
      fresh.push(tx)
    }
    cursor = txs[txs.length - 1].txid
    pages++
    if (!reached) await new Promise((res) => setTimeout(res, 350)) // gentle pacing → avoid Esplora rate-limit
  }

  // insert oldest-first, chunked + yield so a big catch-up never blocks the loop
  let added = 0
  fresh.reverse()
  for (let i = 0; i < fresh.length; i++) {
    const tx = fresh[i]
    const s = settle(tx, w.address)
    if (s) {
      const ts = (tx.status?.block_time ?? Math.floor(Date.now() / 1000)) * 1000
      const usd = s.coins * priceForDay(ch.asset, ts)
      if (usd > 0) {
        const rec = {
          chain: ch.key, tx_hash: tx.txid, log_index: 0, token: ch.asset,
          from_addr: s.dir === 'in' ? s.counterparty : w.address,
          to_addr: s.dir === 'in' ? w.address : s.counterparty,
          counterparty: s.counterparty, amount: s.coins, usd,
          watch_id: w.id, label: w.label, category: w.category,
          direction: s.dir, block: tx.status?.block_height ?? 0, ts,
        }
        const r = stmt.insertTransfer.run(rec)
        if (r.changes > 0) { added++; if (Date.now() - ts < 600_000) emitTransfer(rec) }
      }
    }
    if (i % 50 === 49) await new Promise((res) => setImmediate(res)) // yield every 50 rows
  }

  if (newestTop) stateSet(seenKey, newestTop) // forward resume point (set on the first poll, before deep history)
  if (isBackfill) {
    if (reached) {
      stateSet(bfKey, '1') // backfill complete
      stateSet(bfCurKey, '')
    } else if (gotData && cursor) {
      stateSet(bfCurKey, cursor) // more history to fetch — resume here next poll
    } else {
      stateSet(`${cl}:bfcd:${w.address}`, String(now)) // fetch failed → park so the queue advances
    }
  }
  if (added) console.log(`[${cl}] ${w.label}: +${added} transfers (${pages}p${isBackfill ? ' backfill' + (reached ? ' ✓' : '…') : ''})`)
}

export function startUtxo() {
  for (const ch of CHAINS) {
    if (!enabled(ch.key)) { console.log(`[${ch.key.toLowerCase()}] disabled`); continue }
    console.log(`[${ch.key.toLowerCase()}] ${ch.key} collector active (Esplora, historically priced)`)
    const loop = async () => {
      // process `batch` addresses per poll — clustering grew the BTC watch set into
      // the thousands, so one-per-poll couldn't keep the backfill queue moving
      try { for (let k = 0; k < ch.batch; k++) await indexChain(ch) } catch (e) { console.warn(`[${ch.key.toLowerCase()}]`, (e as Error).message) }
      finally { setTimeout(loop, ch.pollMs) }
    }
    setTimeout(loop, 35_000)
  }
}
