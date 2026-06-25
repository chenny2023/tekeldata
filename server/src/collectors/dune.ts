import { db, stateGet, stateSet } from '../db.ts'
import { webFetchDirect } from '../net.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// Dune label harvester — authoritative EVM casino hot-wallet addresses.
//
// Dune's `labels.addresses` carries curated `institution`-category labels for the
// major operators across every EVM chain (e.g. "Stake.com 1..61", "1xBet",
// "Rollbit", "Roobet", "BetFury", "Gamdom", "Duelbits"). That's ~180 verified hot
// wallets spanning eth/bnb/base/arbitrum/optimism/polygon/avalanche — far broader
// per-chain coverage than our scraped EVM label dumps. We pull them into the
// watchlist (source='dune', auditable) so the existing EVM indexers capture their
// flow. NOTE: Dune has NO bitcoin/tron labels — this is EVM-only by design.
// ─────────────────────────────────────────────────────────────────────────────

const DUNE_BASE = 'https://api.dune.com/api/v1'
// Dune blockchain name → our internal chain code (only the EVM chains we index)
const CHAIN_MAP: Record<string, string> = {
  ethereum: 'ETH',
  bnb: 'BSC',
  base: 'BASE',
  arbitrum: 'ARB',
  optimism: 'OP',
  polygon: 'POLYGON',
  avalanche_c: 'AVAX',
}
// short/generic brand words that would false-match staking contracts / unrelated entities
const GENERIC = new Set(['duel', 'shock', 'degen', 'gamba', 'razed', 'yeet', 'dicey', 'winna', 'goated', 'qzino'])

const insertDune = db.prepare(
  `INSERT OR IGNORE INTO watchlist(chain, address, label, category, source, active, created_at)
   VALUES(?, ?, ?, 'casino', 'dune', 1, ?)`,
)

// casino brand names to match against Dune's institution labels: our roster +
// a few operators Dune labels that aren't in the roster.
function casinoBrands(): string[] {
  const brands: string[] = ['Bitcasino', '1xBet', 'Sportsbet']
  try {
    const path = fileURLToPath(new URL('../data/casino-roster.json', import.meta.url))
    const j = JSON.parse(readFileSync(path, 'utf8'))
    const rows = Array.isArray(j) ? j : (j.casinos ?? j.roster ?? [])
    for (const r of rows) if (r?.name) brands.push(String(r.name))
  } catch {
    /* roster optional */
  }
  return [...new Set(brands.map((b) => b.replace(/['%_]/g, '').toLowerCase()).filter((b) => b.length >= 4 && !GENERIC.has(b)))]
}

function buildSql(): string {
  const chains = Object.keys(CHAIN_MAP).map((c) => `'${c}'`).join(',')
  const likes = casinoBrands().map((b) => `lower(name) LIKE '${b}%'`).join(' OR ')
  return `SELECT blockchain, address, regexp_replace(name, ' [0-9]+$', '') AS op
          FROM labels.addresses
          WHERE category = 'institution' AND blockchain IN (${chains}) AND (${likes})`
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

// Reuse one public query (id persisted in sync_state); PATCH its SQL each run so the
// brand list tracks the roster. Returns null if Dune is unreachable / unauthorised.
async function ensureQueryId(sql: string): Promise<number | null> {
  const saved = Number(stateGet('dune:casino_qid') ?? 0)
  if (saved) {
    await dune(`/query/${saved}`, { method: 'PATCH', body: JSON.stringify({ query_sql: sql }) })
    return saved
  }
  const r = await dune('/query', { method: 'POST', body: JSON.stringify({ name: 'wcoin_casino_labels', query_sql: sql, is_private: false }) })
  if (!r || !r.ok) return null
  const id = ((await r.json()) as any)?.query_id
  if (id) stateSet('dune:casino_qid', id)
  return id || null
}

async function runDuneOnce() {
  const id = await ensureQueryId(buildSql())
  if (!id) {
    console.warn('[dune] no query id (unreachable / unauthorised)')
    return
  }
  const ex = await dune(`/query/${id}/execute`, { method: 'POST', body: '{}' })
  if (!ex || !ex.ok) {
    console.warn('[dune] execute failed', ex?.status)
    return
  }
  const eid = ((await ex.json()) as any)?.execution_id
  if (!eid) return
  let state = ''
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const s = await dune(`/execution/${eid}/status`)
    if (!s) continue
    state = ((await s.json()) as any)?.state ?? ''
    if (state === 'QUERY_STATE_COMPLETED' || state === 'QUERY_STATE_FAILED') break
  }
  if (state !== 'QUERY_STATE_COMPLETED') {
    console.warn('[dune] execution did not complete:', state)
    return
  }
  const res = await dune(`/execution/${eid}/results`)
  if (!res || !res.ok) return
  const rows = (((await res.json()) as any)?.result?.rows ?? []) as { blockchain: string; address: string; op: string }[]
  const now = Date.now()
  let added = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const chain = CHAIN_MAP[r.blockchain]
      if (!chain) continue
      const addr = String(r.address ?? '').toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue
      const label = String(r.op ?? '').replace(/\.com$/i, '').trim().slice(0, 48)
      if (!label) continue
      added += insertDune.run(chain, addr, label, now).changes
    }
  })
  tx()
  stateSet('dune:last', JSON.stringify({ ts: now, fetched: rows.length, added }))
  console.log(`[dune] casino labels: ${rows.length} rows → +${added} new EVM watch addresses`)
}

export function startDune() {
  if (!process.env.duneapi || process.env.DUNE_ENABLED === '0') {
    console.log('[dune] disabled (no duneapi key)')
    return
  }
  console.log('[dune] EVM casino-label harvester active')
  const loop = async () => {
    try {
      await runDuneOnce()
    } catch (e) {
      console.warn('[dune]', (e as Error).message)
    } finally {
      setTimeout(loop, 24 * 3600_000) // labels change slowly — daily is plenty (1 execution/day)
    }
  }
  setTimeout(loop, 300_000) // 5 min after boot, behind the heavier collectors
}
