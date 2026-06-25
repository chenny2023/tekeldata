import { db, stmt, stateGet, stateSet, WatchRow } from '../db.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// BTC address clustering (common-input-ownership heuristic).
//
// Unlike EVM (brianleect gambling-label dumps) or Tron (Tronscan tags), Bitcoin
// has NO bulk casino-address source — we only hand-seed a few hot wallets per
// operator. That under-counts massively: a casino sweeps deposits across hundreds
// of addresses, and we only watch a handful, so we capture a sliver of real flow
// (e.g. CSGOEmpire showed ~$0.9M/7d vs an ~$85M reality).
//
// Fix without any paid API: expand each casino's address set on-chain. The
// industry-standard heuristic — two addresses spent as inputs in the SAME tx are
// controlled by one entity (you need every input's key to sign) — lets us walk a
// casino's known hot wallets out to its full deposit/sweep cluster. The utxo.ts
// collector then indexes the newly-watched addresses, and the captured volume
// converges on reality. Conservative guards prevent over-merging.
//
// Discovered addresses are tagged source='btc-cluster' (auditable + bulk-reversible)
// and inherit the seed's casino label so volume aggregates under the right operator.
// ─────────────────────────────────────────────────────────────────────────────

// Both hosts speak the Esplora API; mempool.space serves 50 tx/page (vs 25) and
// rate-limits more gently, so it leads. Rotating spreads load + survives one host
// throttling. (Railway egress is outside the GFW, so these resolve directly.)
const ESPLORA_HOSTS = ['https://mempool.space/api', 'https://blockstream.info/api']

// Opening to 5000 proved the long tail beyond ~1k/operator is dust (no extra volume)
// and it clogged the index queue, so a hand-seeded high-value wallet couldn't get
// indexed. Cap at 1000 — enough to map the real deposit cluster, not the dust.
const PER_CASINO_CAP = Number(process.env.BTC_CLUSTER_CAP ?? 1000) // max addresses per operator label
const PER_CYCLE_MAX = Number(process.env.BTC_CLUSTER_CYCLE_MAX ?? 400) // cap rows inserted per cycle (avoid a big sync write)
const SCAN_PAGES = 6 // pages of a seed's history scanned per visit
// Casino deposit infra is HD wallets — one address per user, hundreds/thousands of
// them — periodically SWEPT into a hot wallet in a single many-input consolidation
// tx. Those big consolidations are exactly where the deposit-address cluster is
// revealed (common-input-ownership: every input is co-owned, and MORE inputs = MORE
// certainty, not less). The old cap of 30 was discarding the richest txs. Keep a
// high ceiling only to bound JSON parsing; the CoinJoin guard handles false merges.
const MAX_INPUTS = Number(process.env.BTC_CLUSTER_MAX_INPUTS ?? 2500)
const COINJOIN_MIN_INPUTS = 5 // CoinJoin guard kicks in at/above this input count
const RECLUSTER_COOLDOWN_MS = 30 * 60_000 // a fetch-failing seed is parked this long
const CYCLE_MS = 90_000 // one seed per cycle (gentle)
const BTC_RE = /^(bc1[a-z0-9]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,39})$/

const insertClustered = db.prepare(
  `INSERT OR IGNORE INTO watchlist(chain, address, label, category, source, active, created_at)
   VALUES('BTC', ?, ?, 'casino', 'btc-cluster', 1, ?)`,
)

let hostRr = 0
async function esplora(path: string): Promise<any | null> {
  for (let i = 0; i < ESPLORA_HOSTS.length * 2; i++) {
    const host = ESPLORA_HOSTS[hostRr++ % ESPLORA_HOSTS.length]
    try {
      const r = await webFetch(host + path, { signal: AbortSignal.timeout(15_000) })
      if (r.ok) return await r.json()
      if (r.status === 404) return null // genuinely no such resource — don't burn retries
    } catch {
      /* rotate host + retry */
    }
    await new Promise((res) => setTimeout(res, 1200))
  }
  return null
}

// CoinJoin/mixing signature: many inputs AND ≥3 outputs sharing one value (equal-output
// rounds). Casino hot wallets don't mix, so skipping these avoids false cross-entity merges.
function looksLikeCoinJoin(tx: any): boolean {
  const nin = (tx.vin ?? []).length
  if (nin < COINJOIN_MIN_INPUTS) return false
  const byVal = new Map<number, number>()
  for (const o of tx.vout ?? []) byVal.set(o.value, (byVal.get(o.value) ?? 0) + 1)
  return [...byVal.values()].some((c) => c >= 3)
}

let rr = 0
async function clusterOnce() {
  const all = stmt.activeWatch.all() as WatchRow[]
  const seeds = all.filter((w) => w.chain === 'BTC' && w.category === 'casino')
  if (seeds.length === 0) return
  // cluster CURATED seeds (hand-added hot wallets) before cluster-discovered ones, so
  // a freshly-seeded operator (e.g. Stake) expands ahead of re-scanning known clusters
  seeds.sort((a, b) => ((a as any).source === 'btc-cluster' ? 1 : 0) - ((b as any).source === 'btc-cluster' ? 1 : 0))
  const now = Date.now()

  // Prefer a seed still being clustered (not done, not in cooldown); else round-robin
  // re-scan a finished seed occasionally to pick up freshly-active sibling addresses.
  let seed = seeds.find((s) => {
    if (stateGet(`btcclu:done:${s.address}`)) return false
    const cd = Number(stateGet(`btcclu:cd:${s.address}`) ?? 0)
    return now - cd > RECLUSTER_COOLDOWN_MS
  })
  if (!seed) {
    seed = seeds[rr % seeds.length]
    rr++
  }

  // enforce the per-operator cap (count current BTC addresses under this label)
  const labelCount = all.filter((w) => w.chain === 'BTC' && w.label === seed!.label).length
  if (labelCount >= PER_CASINO_CAP) {
    stateSet(`btcclu:done:${seed.address}`, '1')
    return
  }

  // scan the seed's history; collect addresses co-spent alongside it
  const siblings = new Map<string, number>()
  let cursor = stateGet(`btcclu:cur:${seed.address}`) || null
  let pages = 0
  let gotData = false
  let exhausted = false
  while (pages < SCAN_PAGES) {
    const path = cursor
      ? `/address/${seed.address}/txs/chain/${cursor}`
      : `/address/${seed.address}/txs`
    const txs = await esplora(path)
    if (!Array.isArray(txs)) break
    if (txs.length === 0) {
      exhausted = true
      break
    }
    gotData = true
    for (const tx of txs) {
      const ins: string[] = (tx.vin ?? [])
        .map((i: any) => i.prevout?.scriptpubkey_address)
        .filter(Boolean)
      if (!ins.includes(seed!.address)) continue // seed must be a spender to prove co-ownership
      if (ins.length > MAX_INPUTS || looksLikeCoinJoin(tx)) continue
      for (const a of ins) if (a !== seed!.address) siblings.set(a, (siblings.get(a) ?? 0) + 1)
    }
    cursor = txs[txs.length - 1].txid
    pages++
    if (txs.length < 25) {
      exhausted = true
      break
    } // short page = end of history (handles either host's page size)
    await new Promise((res) => setTimeout(res, 400))
  }

  // attach the most-corroborated siblings first, up to the remaining cap — but no
  // more than PER_CYCLE_MAX in one transaction, so a high cap can't insert thousands
  // of rows in a single synchronous write and stall the event loop. The seed isn't
  // marked done until its history is exhausted, so the rest land on later cycles.
  let added = 0
  let budget = Math.min(PER_CASINO_CAP - labelCount, PER_CYCLE_MAX)
  const ranked = [...siblings.entries()].sort((a, b) => b[1] - a[1])
  const txn = db.transaction(() => {
    for (const [addr] of ranked) {
      if (budget <= 0) break
      if (!BTC_RE.test(addr)) continue
      const r = insertClustered.run(addr, seed!.label, now)
      if (r.changes > 0) {
        added++
        budget--
      }
    }
  })
  txn()

  if (exhausted) {
    stateSet(`btcclu:done:${seed.address}`, '1')
    stateSet(`btcclu:cur:${seed.address}`, '')
  } else if (gotData && cursor) {
    stateSet(`btcclu:cur:${seed.address}`, cursor)
  } else {
    stateSet(`btcclu:cd:${seed.address}`, String(now))
  }
  if (added) {
    const total = labelCount + added
    stateSet(`btcclu:count:${seed.label}`, String(total))
    console.log(`[btcclu] ${seed.label}: +${added} clustered (now ~${total}/${PER_CASINO_CAP})`)
  }
}

export function startBtcCluster() {
  if (process.env.BTC_ENABLED === '0' || process.env.BTC_CLUSTER === '0') {
    console.log('[btcclu] disabled')
    return
  }
  // One-time re-open: operators previously hit the old 150 cap (and big consolidation
  // txs were being skipped), so they're flagged done with their cursors spent. Bump
  // the version to clear that progress and re-cluster from scratch under the new cap /
  // MAX_INPUTS so the deposit-address clusters get fully expanded.
  const CLUSTER_VERSION = 'v3-open-2026-06'
  if (stateGet('btcclu:version') !== CLUSTER_VERSION) {
    const n = db.prepare("DELETE FROM sync_state WHERE key LIKE 'btcclu:done:%' OR key LIKE 'btcclu:cur:%' OR key LIKE 'btcclu:cd:%'").run().changes
    stateSet('btcclu:version', CLUSTER_VERSION)
    console.log(`[btcclu] re-open: cleared ${n} progress keys → re-clustering under cap ${PER_CASINO_CAP}, max-inputs ${MAX_INPUTS}`)
  }
  console.log('[btcclu] BTC address clustering active (common-input-ownership)')
  const loop = async () => {
    try {
      await clusterOnce()
    } catch (e) {
      console.warn('[btcclu]', (e as Error).message)
    } finally {
      setTimeout(loop, CYCLE_MS)
    }
  }
  setTimeout(loop, 60_000) // let boot settle (collectors + watch seeding) first
}
