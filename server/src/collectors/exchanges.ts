import { db, stateGet, stateSet } from '../db.ts'
import { webFetchDirect } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Centralized-exchange address harvester (external label source for discovery).
//
// The graph-expand candidate engine (graphexpand.ts) can't tell a casino's OWN
// treasury wallet from its EXCHANGE/payment-processor purely from on-chain flow —
// EVM counterparty co-occurrence doesn't prove ownership. The dominance guard helps
// but is defeated when a brand's own flow is wash-inflated. The clean fix is an
// EXTERNAL label: if a candidate counterparty is a known CEX hot wallet, exclude it.
//
// We pull Dune's curated CEX labels (labels.addresses, category in cex-like names)
// across the EVM chains we index into `exchange_addresses` (source='dune-cex',
// auditable + bulk-reversible). This table is ONLY read to filter graph candidates —
// it is never written into casino attribution, so it cannot move public reserve or
// volume numbers. Returns 0 rows harmlessly if Dune is unreachable or the category
// name doesn't match (verify via /api/diag/exchange-addresses, then adjust CATEGORIES).
// ─────────────────────────────────────────────────────────────────────────────

const DUNE_BASE = 'https://api.dune.com/api/v1'
// Dune blockchain name → our internal chain code (the EVM chains we index)
const CHAIN_MAP: Record<string, string> = {
  ethereum: 'ETH',
  bnb: 'BSC',
  base: 'BASE',
  arbitrum: 'ARB',
  optimism: 'OP',
  polygon: 'POLYGON',
  avalanche_c: 'AVAX',
}
// Dune label categories that denote a centralized exchange. Hedged across the names
// Dune's spellbook has used; unknown names simply return no rows (harmless).
const CATEGORIES = ["'cex'", "'centralized_exchange'", "'exchange'"]
const MAX_ROWS = 20_000 // bound the import; top CEX hot wallets are what matter for the filter

const insertExchange = db.prepare(
  `INSERT OR IGNORE INTO exchange_addresses(chain, address, exchange, source, created_at)
   VALUES(?, ?, ?, 'dune-cex', ?)`,
)

function buildSql(): string {
  const chains = Object.keys(CHAIN_MAP).map((c) => `'${c}'`).join(',')
  return `SELECT blockchain, address, name
          FROM labels.addresses
          WHERE category IN (${CATEGORIES.join(',')}) AND blockchain IN (${chains})
          LIMIT ${MAX_ROWS}`
}

async function dune(path: string, init: Record<string, unknown> = {}): Promise<Response | null> {
  const key = process.env.duneapi
  if (!key) return null
  try {
    return await webFetchDirect(DUNE_BASE + path, {
      ...init,
      headers: { 'X-Dune-Api-Key': key, 'Content-Type': 'application/json', ...((init.headers as object) ?? {}) },
    } as any)
  } catch {
    return null
  }
}

// Reuse one persisted public query, PATCH its SQL each run (mirrors dune.ts).
async function ensureQueryId(sql: string): Promise<number | null> {
  const saved = Number(stateGet('dune:cex_qid') ?? 0)
  if (saved) {
    await dune(`/query/${saved}`, { method: 'PATCH', body: JSON.stringify({ query_sql: sql }) })
    return saved
  }
  const r = await dune('/query', { method: 'POST', body: JSON.stringify({ name: 'wcoin_cex_labels', query_sql: sql, is_private: false }) })
  if (!r || !r.ok) return null
  const id = ((await r.json()) as any)?.query_id
  if (id) stateSet('dune:cex_qid', id)
  return id || null
}

async function runOnce() {
  const id = await ensureQueryId(buildSql())
  if (!id) {
    console.warn('[exchanges] no query id (unreachable / unauthorised)')
    return
  }
  const ex = await dune(`/query/${id}/execute`, { method: 'POST', body: '{}' })
  if (!ex || !ex.ok) {
    console.warn('[exchanges] execute failed', ex?.status)
    return
  }
  const eid = ((await ex.json()) as any)?.execution_id
  if (!eid) return
  let state = ''
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const s = await dune(`/execution/${eid}/status`)
    if (!s) continue
    state = ((await s.json()) as any)?.state ?? ''
    if (state === 'QUERY_STATE_COMPLETED' || state === 'QUERY_STATE_FAILED') break
  }
  if (state !== 'QUERY_STATE_COMPLETED') {
    console.warn('[exchanges] execution did not complete:', state)
    return
  }
  const res = await dune(`/execution/${eid}/results`)
  if (!res || !res.ok) return
  const rows = (((await res.json()) as any)?.result?.rows ?? []) as { blockchain: string; address: string; name: string }[]
  const now = Date.now()
  let added = 0
  // chunk the insert so a large label set can't stall the event loop with one big write
  for (let i = 0; i < rows.length; i += 1000) {
    const slice = rows.slice(i, i + 1000)
    db.transaction(() => {
      for (const r of slice) {
        const chain = CHAIN_MAP[r.blockchain]
        if (!chain) continue
        const addr = String(r.address ?? '').toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(addr)) continue
        const name = String(r.name ?? 'exchange').replace(/\s+\d+$/, '').trim().slice(0, 48) || 'exchange'
        added += insertExchange.run(chain, addr, name, now).changes
      }
    })()
    await new Promise((r) => setImmediate(r)) // yield between chunks
  }
  stateSet('exchanges:last', JSON.stringify({ ts: now, fetched: rows.length, added }))
  console.log(`[exchanges] CEX labels: ${rows.length} rows → +${added} new exchange addresses`)
}

export function startExchanges() {
  if (!process.env.duneapi || process.env.EXCHANGES_ENABLED === '0') {
    console.log('[exchanges] disabled (no duneapi key)')
    return
  }
  console.log('[exchanges] CEX-label harvester active (Dune)')
  const loop = async () => {
    try {
      await runOnce()
    } catch (e) {
      console.warn('[exchanges]', (e as Error).message)
    } finally {
      setTimeout(loop, 24 * 3600_000) // labels change slowly — daily
    }
  }
  setTimeout(loop, 360_000) // 6 min after boot, behind dune.ts (shares the Dune account)
}
