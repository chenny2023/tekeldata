import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, stateGet, stateSet, stmt, isInfraDenied } from '../db.ts'
import { arkhamFetch } from '../net.ts'

// Arkham chain → our watchlist chain code. All EVM chains share one 'ETH' row
// (the indexer reuses the address across every EVM network); Tron/Sol/BTC direct.
function ourChain(chain: string, chainType: string): string | null {
  if (chainType === 'evm') return 'ETH'
  const c = (chain || '').toLowerCase()
  if (c === 'tron') return 'TRON'
  if (c === 'solana' || c === 'sol') return 'SOL'
  if (c === 'bitcoin' || c === 'btc') return 'BTC'
  return null
}

function hostOf(u: string): string | null {
  if (!u) return null
  try {
    return new URL(u.startsWith('http') ? u : 'https://' + u).hostname.replace(/^www\./, '').toLowerCase() || null
  } catch {
    return null
  }
}
// normalize a casino/entity name for comparison (drop generic words + punctuation)
function normName(s: string): string {
  return (s || '').toLowerCase().replace(/casino|sportsbook|\.com|\.io|\.gg|\.bet|official|crypto/g, '').replace(/[^a-z0-9]+/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// Arkham Intelligence collector. Maps each roster casino → its Arkham "gambling"
// entity (search by name), then pulls all-chain reserves from the entity's
// portfolio. This expands on-chain coverage far beyond the chains/tokens we index
// ourselves — Arkham attributes Tron, Bitcoin, every EVM chain, etc. Paced for the
// API's rate limit. Volume (windowed transfer USD) lands in a later phase.
// ─────────────────────────────────────────────────────────────────────────────

// Mainstream tokens only (the user's rule: ignore shitcoins/casino tokens). Match
// by ticker; bridged/peg stables (binance-bridged-usdc…) all carry a usdc/usdt sym.
const MAIN_SYMBOLS = new Set([
  'usdt', 'usdc', 'usdc.e', 'dai', 'busd', 'tusd', 'usdp', 'pyusd', 'fdusd', 'bsc-usd', 'usds', 'usde',
  'eth', 'weth', 'beth', 'steth', 'wsteth', 'btc', 'btcb', 'wbtc', 'cbbtc', 'tbtc',
  'bnb', 'wbnb', 'trx', 'sol', 'xrp', 'ltc', 'doge', 'bch', 'ada', 'avax', 'matic', 'pol', 'ton', 'dot',
])
function isMainstream(symbol: string): boolean {
  return MAIN_SYMBOLS.has((symbol || '').toLowerCase())
}

// Arkham is aggressively rate-limited (429). With a big resolve queue the collector would
// otherwise hammer the same seed every 6s, burning the key and never progressing. Track a
// shared backoff: on 429 escalate the cool-off (2→30 min), and skip ALL Arkham calls while
// cooling so the loop idles instead of hammering; a 200 resets it.
let rateLimitUntil = 0
let consecutive429 = 0
const rateLimited = (): boolean => Date.now() < rateLimitUntil
function noteStatus(status: number): void {
  if (status === 429) {
    consecutive429++
    rateLimitUntil = Date.now() + Math.min(30, 2 * consecutive429) * 60_000
  } else if (status === 200) {
    consecutive429 = 0
    rateLimitUntil = 0
  }
}

const upsertSeed = db.prepare('INSERT INTO arkham_casino(key, name, domain) VALUES(@key, @name, @domain) ON CONFLICT(key) DO UPDATE SET domain=COALESCE(arkham_casino.domain, @domain)')
const setResolved = db.prepare('UPDATE arkham_casino SET entity_id=@id, entity_type=@type, resolved_at=@now WHERE key=@key')
const setMetrics = db.prepare('UPDATE arkham_casino SET reserves_usd=@reserves, volume7d_usd=COALESCE(@volume, volume7d_usd), updated_at=@now WHERE key=@key')

function seedFromRoster() {
  try {
    const path = fileURLToPath(new URL('../data/casino-roster.json', import.meta.url))
    const roster = JSON.parse(readFileSync(path, 'utf8')) as any[]
    let n = 0
    const keys: string[] = []
    const tx = db.transaction(() => {
      for (const c of roster) {
        const name = String(c.name ?? '').trim()
        const key = String(c.slug ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const domain = hostOf(String(c.website_url || c.website || ''))
        if (name && key) {
          keys.push(key)
          n += upsertSeed.run({ key, name, domain }).changes
        }
      }
    })
    tx()
    if (n) console.log(`[arkham] seeded ${n} casinos from roster`)
    // Arkham's resolver is severely rate-limited, so focus its scarce budget on the
    // curated roster: drop UNRESOLVED non-roster seeds (e.g. the bulk directory seeds we
    // tried earlier) so the loop resolves the high-value roster casinos instead of churning
    // obscure ones. Resolved/attributed entries are kept regardless. Idempotent.
    if (keys.length) {
      const ph = keys.map(() => '?').join(',')
      const pruned = db
        .prepare(`DELETE FROM arkham_casino WHERE resolved_at=0 AND (entity_id IS NULL OR entity_id='') AND key NOT IN (${ph})`)
        .run(...keys).changes
      if (pruned) console.log(`[arkham] pruned ${pruned} unresolved non-roster seeds (focus resolve budget on roster)`)
    }
  } catch (e) {
    console.warn('[arkham] roster seed failed:', (e as Error).message)
  }
}

// Widen on-chain coverage past the hand-curated roster: seed every RATED casino from our
// directory (1763 listed) into the Arkham resolve queue. resolveOne validates each by exact
// name or real website domain and marks no-match seeds done (never retried), so this grows
// coverage toward and past competitors with NO mis-attribution risk. Idempotent.
function seedFromDirectory(): void {
  // OFF by default: Arkham is rate-limited (429), so the bulk directory expansion now runs
  // through Dune (collectors/dune.ts), which returns all matches in one query. Set
  // ARKHAM_SEED_DIRECTORY=1 to also feed the directory into Arkham's slow resolve queue.
  if ((process.env.ARKHAM_SEED_DIRECTORY ?? '0') === '0') return
  try {
    const rows = db
      .prepare("SELECT name, website, domain FROM casino_directory WHERE name IS NOT NULL AND name != '' AND tp_rating IS NOT NULL")
      .all() as { name: string; website: string | null; domain: string | null }[]
    let n = 0
    const tx = db.transaction(() => {
      for (const c of rows) {
        const name = String(c.name).trim()
        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (!name || key.length < 2) continue
        const domain = c.domain || hostOf(String(c.website || ''))
        n += upsertSeed.run({ key, name, domain }).changes
      }
    })
    tx()
    if (n) console.log(`[arkham] seeded ${n} rated casinos from directory → resolve queue`)
  } catch (e) {
    console.warn('[arkham] directory seed failed:', (e as Error).message)
  }
}

// fetch an entity's canonical website (search results omit it) for domain validation
async function entityWebsite(id: string): Promise<string | null> {
  try {
    const res = arkhamFetch(`/intelligence/entity/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(25_000) })
    if (!res) return null
    const r = await res
    if (r.status !== 200) return null
    return ((await r.json()) as { website?: string }).website ?? null
  } catch {
    return null
  }
}

// Resolve a casino → its Arkham gambling entity, VALIDATED (the search ranks loosely
// and would otherwise mis-attribute, e.g. "7Bit Casino" → "500-casino"). Accept a
// candidate only when its name matches OR its real website domain == the casino's.
async function resolveOne(): Promise<boolean> {
  if (rateLimited()) return false
  const row = db.prepare('SELECT key, name, domain FROM arkham_casino WHERE resolved_at=0 ORDER BY key LIMIT 1').get() as
    | { key: string; name: string; domain: string | null }
    | undefined
  if (!row) return false
  const now = Date.now()
  try {
    const res = arkhamFetch(`/intelligence/search?query=${encodeURIComponent(row.name)}`, { signal: AbortSignal.timeout(30_000) })
    if (!res) return false
    const r = await res
    noteStatus(r.status)
    if (r.status !== 200) {
      if (r.status !== 429) console.warn(`[arkham] search ${row.name}: HTTP ${r.status}`) // 429 handled by backoff
      return true
    }
    const j = (await r.json()) as { arkhamEntities?: { id: string; name: string; type: string }[] }
    const cands = (j.arkhamEntities ?? []).filter((e) => e.type === 'gambling')
    const want = normName(row.name)
    // 1) exact normalized-name match among candidates (free)
    let chosen = cands.find((e) => normName(e.name) === want)
    // 2) else validate the top candidates by their real website domain
    if (!chosen && row.domain) {
      for (const c of cands.slice(0, 3)) {
        if (hostOf(await entityWebsite(c.id)) === row.domain) {
          chosen = c
          break
        }
      }
    }
    setResolved.run({ key: row.key, id: chosen?.id ?? '', type: chosen?.type ?? '', now })
    if (chosen) console.log(`[arkham] ${row.name} → entity ${chosen.id}`)
    else console.log(`[arkham] ${row.name}: no confident match (${cands.length} gambling cands)`)
  } catch (e) {
    console.warn(`[arkham] search ${row.name}: ${(e as Error).message.slice(0, 40)}`)
  }
  return true
}

function sumReserves(portfolio: Record<string, Record<string, any>>): number {
  let total = 0
  for (const chain in portfolio) {
    const toks = portfolio[chain]
    if (!toks || typeof toks !== 'object') continue
    for (const id in toks) {
      const t = toks[id]
      if (t && isMainstream(t.symbol) && typeof t.usd === 'number' && Number.isFinite(t.usd)) total += t.usd
    }
  }
  return total
}

const REFRESH_MS = 6 * 3600_000 // refresh reserves every ~6h
const VOL_WINDOW_MS = 7 * 86400_000
const VOL_MAX_PAGES = 8 // up to 2000 recent transfers; the very largest entities undercount (a 7d floor)

// Phase 2 — Arkham-attributed cross-chain transfer volume over the trailing 7d.
// This counts throughput on chains/tokens we don't index ourselves (BTC native,
// full Tron, every EVM), so it complements the on-chain volume the indexer derives
// from harvested wallets. Bounded paging keeps it within the rate limit; for the
// highest-volume entities (Stake-scale) the window isn't fully covered, so the
// figure is a floor — surfaced as such, never as an exact total.
// Map an Arkham transfer's chain string → our chain code. Arkham uses names like
// "ethereum"/"tron"/"bitcoin"/"base". This is the BTC/Tron attribution: Arkham reports
// those transfers, our own indexer barely does.
// Map an Arkham chain string (transfer field OR portfolio key) → our chain code.
function chainCode(raw: string): string | null {
  const c = String(raw ?? '').toLowerCase()
  if (!c) return null
  if (c === 'tron' || c === 'trx') return 'TRON'
  if (c === 'bitcoin' || c === 'btc') return 'BTC'
  if (c === 'solana' || c === 'sol') return 'SOL'
  if (c === 'litecoin' || c === 'ltc') return 'LTC'
  if (c === 'dogecoin' || c === 'doge') return 'DOGE'
  if (c === 'ripple' || c === 'xrp') return 'XRP'
  if (c === 'ethereum' || c === 'eth') return 'ETH'
  if (c === 'base') return 'BASE'
  if (c === 'arbitrum' || c === 'arbitrum_one' || c === 'arb') return 'ARB'
  if (c === 'optimism' || c === 'op') return 'OP'
  if (c === 'polygon' || c === 'matic' || c === 'pol') return 'POLYGON'
  if (c === 'bsc' || c === 'binance_smart_chain' || c === 'bnb') return 'BSC'
  if (c === 'avalanche' || c === 'avax') return 'AVAX'
  return c.slice(0, 12).toUpperCase() // fallback: surface the raw chain rather than drop it
}

function txChain(t: any): string | null {
  return chainCode(String(t.chain ?? t.blockchain ?? t.chainName ?? ''))
}

// Per-chain reserves from the (working, non-429) portfolio endpoint. Arkham's
// portfolio is keyed by chain → token → {symbol, usd}; summing mainstream USD per
// chain gives an AUTHORITATIVE cross-chain reserve split (BTC/Tron/SOL included)
// without needing addresses or the rate-limited transfers endpoint.
function sumReservesByChain(portfolio: Record<string, Record<string, any>>): Record<string, number> {
  const byChain: Record<string, number> = {}
  for (const chain in portfolio) {
    const code = chainCode(chain)
    if (!code) continue
    const toks = portfolio[chain]
    if (!toks || typeof toks !== 'object') continue
    let sum = 0
    for (const id in toks) {
      const t = toks[id]
      if (t && isMainstream(t.symbol) && typeof t.usd === 'number' && Number.isFinite(t.usd)) sum += t.usd
    }
    if (sum > 0) byChain[code] = (byChain[code] ?? 0) + sum
  }
  return byChain
}

let loggedTxSample = false
async function entityVolume7d(entityId: string): Promise<{ total: number; byChain: Record<string, number> } | null> {
  const since = Date.now() - VOL_WINDOW_MS
  let total = 0
  const byChain: Record<string, number> = {}
  let sawAny = false
  for (let page = 0; page < VOL_MAX_PAGES; page++) {
    const res = arkhamFetch(
      `/transfers?base=${encodeURIComponent(entityId)}&timeGte=${since}&limit=250&offset=${page * 250}&sortKey=time&sortDir=desc`,
      { signal: AbortSignal.timeout(30_000) },
    )
    if (!res) return null
    const r = await res
    if (r.status !== 200) return sawAny ? { total, byChain } : null // transient mid-sweep → keep what we have
    const list = ((await r.json()) as { transfers?: any[] }).transfers ?? []
    if (!list.length) break
    sawAny = true
    if (!loggedTxSample && list[0]) { loggedTxSample = true; console.log('[arkham] transfer fields:', Object.keys(list[0]).join(',')) } // one-time: verify the chain field name
    for (const t of list) {
      const sym = t.tokenSymbol ?? t.token?.symbol ?? t.symbol ?? ''
      const usd = typeof t.historicalUSD === 'number' ? t.historicalUSD : typeof t.usd === 'number' ? t.usd : 0
      if (isMainstream(sym) && Number.isFinite(usd) && usd > 0) {
        total += usd
        const ch = txChain(t)
        if (ch) byChain[ch] = (byChain[ch] ?? 0) + usd
      }
    }
    if (list.length < 250) break // window exhausted
  }
  return { total, byChain }
}

// pull all-chain portfolio for a resolved entity → mainstream reserves USD
async function refreshOne(): Promise<boolean> {
  if (rateLimited()) return false
  const row = db
    .prepare("SELECT key, name, entity_id FROM arkham_casino WHERE entity_id IS NOT NULL AND entity_id != '' AND updated_at < @stale ORDER BY updated_at LIMIT 1")
    .get({ stale: Date.now() - REFRESH_MS }) as { key: string; name: string; entity_id: string } | undefined
  if (!row) return false
  const now = Date.now()
  try {
    const res = arkhamFetch(`/portfolio/entity/${encodeURIComponent(row.entity_id)}?time=${now}`, { signal: AbortSignal.timeout(30_000) })
    if (!res) return false
    const r = await res
    noteStatus(r.status)
    if (r.status === 200) {
      const pf = (await r.json()) as any
      const reserves = sumReserves(pf)
      // AUTHORITATIVE per-chain reserve split from the same (working) portfolio
      // response — this is the BTC/Tron/SOL cross-chain attribution that the daily
      // chain distribution uses. No extra API call, no addresses, no 429.
      const reservesByChain = sumReservesByChain(pf)
      // same pass: trailing-7d cross-chain volume (Phase 2). Rate-limited (429) for
      // most entities, so treated as best-effort; the per-chain RESERVES above are
      // the reliable signal.
      const vol = await entityVolume7d(row.entity_id).catch(() => null)
      const volume = vol?.total ?? null
      setMetrics.run({ key: row.key, reserves, volume, now })
      db.prepare('INSERT INTO arkham_reserve_history(key, reserves_usd, ts) VALUES(?, ?, ?)').run(row.key, reserves, now)
      // persist per-chain reserves (replace this entity's prior rows atomically)
      if (Object.keys(reservesByChain).length) {
        const saveR = db.transaction(() => {
          db.prepare('DELETE FROM arkham_chain_reserves WHERE key=?').run(row.key)
          const ins = db.prepare('INSERT INTO arkham_chain_reserves(key, chain, usd, ts) VALUES(?,?,?,?)')
          for (const [ch, v] of Object.entries(reservesByChain)) if (v > 0) ins.run(row.key, ch, v, now)
        })
        saveR()
      }
      // best-effort per-chain VOLUME (only populates when /transfers isn't 429)
      if (vol && Object.keys(vol.byChain).length) {
        const save = db.transaction(() => {
          db.prepare('DELETE FROM arkham_chain_volume WHERE key=?').run(row.key)
          const ins = db.prepare('INSERT INTO arkham_chain_volume(key, chain, vol7d, ts) VALUES(?,?,?,?)')
          for (const [ch, v] of Object.entries(vol.byChain)) if (v > 0) ins.run(row.key, ch, v, now)
        })
        save()
      }
      const chainStr = Object.entries(reservesByChain).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, v]) => `${c} $${Math.round(v).toLocaleString()}`).join(' · ')
      console.log(`[arkham] ${row.name}: reserves $${Math.round(reserves).toLocaleString()}${chainStr ? ` [${chainStr}]` : ''}${volume != null ? `, vol7d $${Math.round(volume).toLocaleString()}` : ''}`)
    } else {
      console.warn(`[arkham] portfolio ${row.name}: HTTP ${r.status}`)
      setMetrics.run({ key: row.key, reserves: null, volume: null, now }) // advance so we don't loop on a bad entity
    }
  } catch (e) {
    console.warn(`[arkham] portfolio ${row.name}: ${(e as Error).message.slice(0, 40)}`)
  }
  return true
}

// Harvest the casino's own hot-wallet addresses from its transfers and add them
// to the watchlist → the multi-chain indexer then tracks their volume. This is
// how we expand transaction coverage beyond the hand-curated brands. Per-user
// deposit addresses are skipped (thousands, noisy); we take the labelled wallets.
async function harvestOne(): Promise<boolean> {
  if (rateLimited()) return false
  const row = db
    .prepare("SELECT key, name, entity_id FROM arkham_casino WHERE entity_id != '' AND addr_harvested=0 ORDER BY reserves_usd DESC LIMIT 1")
    .get() as { key: string; name: string; entity_id: string } | undefined
  if (!row) return false
  try {
    const res = arkhamFetch(`/transfers?base=${encodeURIComponent(row.entity_id)}&limit=250`, { signal: AbortSignal.timeout(30_000) })
    if (!res) return false
    const r = await res
    noteStatus(r.status)
    if (r.status !== 200) return true // transient — retry later (don't mark harvested)
    const j = (await r.json()) as { transfers?: any[] }
    const seen = new Set<string>()
    const now = Date.now()
    let added = 0
    for (const t of j.transfers ?? []) {
      for (const a of [t.fromAddress, t.toAddress]) {
        if (!a?.address) continue
        const owned = a.arkhamEntity?.id === row.entity_id || a.depositServiceID === row.entity_id
        if (!owned) continue
        if (/deposit/i.test(a.arkhamLabel?.name ?? '')) continue // skip per-user deposit addrs
        if (isInfraDenied(a.address)) continue // never harvest known DEX/infra contracts
        const chain = ourChain(a.chain, a.arkhamLabel?.chainType ?? '')
        if (!chain) continue
        const addr = chain === 'ETH' ? String(a.address).toLowerCase() : String(a.address) // ETH lowercased, TRON base58
        const dkey = chain + ':' + addr.toLowerCase()
        if (seen.has(dkey)) continue
        seen.add(dkey)
        added += stmt.addWatch.run(chain, addr, row.name, 'casino', now).changes
      }
    }
    db.prepare('UPDATE arkham_casino SET addr_harvested=1 WHERE key=?').run(row.key)
    if (added) console.log(`[arkham] ${row.name}: +${added} wallet addresses → indexer`)
  } catch (e) {
    console.warn(`[arkham] harvest ${row.name}: ${(e as Error).message.slice(0, 40)}`)
  }
  return true
}

export function startArkham() {
  if ((process.env.ARKHAM_ENABLED ?? '1') === '0') return
  if (!(process.env.arkham || process.env.ARKHAM_API_KEY)) {
    console.log('[arkham] no API key — collector idle')
    return
  }
  console.log('[arkham] entity attribution collector active')
  seedFromRoster()
  seedFromDirectory() // widen coverage from the rated directory (validated per-seed)
  // one-time accelerated re-sweep: mark resolved entities stale so refreshOne picks them
  // up immediately (verify per-chain BTC/Tron attribution without waiting the 6h cadence).
  // Each refresh sets updated_at=now, so the normal 6h cadence resumes automatically —
  // no revert needed; just clear the env so a later restart doesn't re-sweep.
  if (process.env.ARKHAM_FORCE_REFRESH === '1') {
    try {
      const n = db.prepare("UPDATE arkham_casino SET updated_at=0 WHERE entity_id IS NOT NULL AND entity_id != ''").run().changes
      console.log(`[arkham] FORCE_REFRESH: ${n} entities marked stale for a one-time re-sweep`)
    } catch {
      /* non-fatal */
    }
  }
  // one-time: the first run matched without domain validation (some wrong) — redo
  if (!stateGet('arkham:revalidate:v1')) {
    const n = db.prepare('UPDATE arkham_casino SET resolved_at=0, entity_id=NULL, reserves_usd=NULL').run().changes
    stateSet('arkham:revalidate:v1', 1)
    if (n) console.log(`[arkham] cleared ${n} matches to re-resolve with domain validation`)
  }
  let iter = 0
  const loop = async () => {
    // priority: resolve entities → harvest their addresses into the indexer →
    // keep reserves fresh. Interleave a reserve refresh every 3rd tick so matched
    // casinos surface reserves without waiting for the full resolve/harvest pass.
    const worked = (await resolveOne().catch(() => false)) || (await harvestOne().catch(() => false))
    let refreshed = false
    if (!worked || ++iter % 3 === 0) refreshed = await refreshOne().catch(() => false)
    setTimeout(loop, worked || refreshed ? 6_000 : 60_000)
  }
  setTimeout(loop, 30_000)
}

// Live debug: fetch one resolved entity's recent transfers and return the raw shape,
// so we can confirm the per-chain field name + that the API responds (the verification
// log rolls off the window). Bypasses the 6h refresh cadence entirely.
export async function arkhamProbe(): Promise<any> {
  const row = db.prepare("SELECT key, name, entity_id FROM arkham_casino WHERE entity_id IS NOT NULL AND entity_id != '' ORDER BY updated_at DESC LIMIT 1").get() as
    | { key: string; name: string; entity_id: string }
    | undefined
  if (!row) return { error: 'no resolved entity' }
  const res = arkhamFetch(`/transfers?base=${encodeURIComponent(row.entity_id)}&timeGte=${Date.now() - VOL_WINDOW_MS}&limit=5&sortKey=time&sortDir=desc`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (!res) return { error: 'arkhamFetch returned null (no key?)' }
  const r = await res
  if (r.status !== 200) return { entity: row.name, status: r.status }
  const list = ((await r.json()) as { transfers?: any[] }).transfers ?? []
  return {
    entity: row.name,
    count: list.length,
    transferKeys: list[0] ? Object.keys(list[0]) : [],
    samples: list.slice(0, 4).map((t: any) => ({
      chain: t.chain,
      blockchain: t.blockchain,
      chainName: t.chainName,
      network: t.network,
      sym: t.tokenSymbol ?? t.token?.symbol ?? t.symbol,
      usd: t.historicalUSD ?? t.usd,
      mapped: txChain(t),
    })),
    rows: db.prepare('SELECT COUNT(*) n FROM arkham_chain_volume').get(),
  }
}

// Live debug: probe NON-transfers endpoints for an entity to see whether any of
// them expose the entity's per-chain addresses (the /transfers endpoint that
// harvestAddresses uses is rate-limited 429). If an address-bearing field exists
// here, we can harvest Tron/BTC casino wallets from the authoritative source
// without the 429. Returns a compact shape (keys + any address-like values).
export async function arkhamAddressProbe(key?: string): Promise<any> {
  const row = (
    key
      ? db.prepare("SELECT key, name, entity_id FROM arkham_casino WHERE key=? AND entity_id != ''").get(key)
      : db.prepare("SELECT key, name, entity_id FROM arkham_casino WHERE entity_id != '' ORDER BY reserves_usd DESC LIMIT 1").get()
  ) as { key: string; name: string; entity_id: string } | undefined
  if (!row) return { error: 'no resolved entity' }
  const id = row.entity_id
  const out: any = { entity: row.name, key: row.key, entity_id: id, probes: {} }
  const probe = async (label: string, path: string) => {
    try {
      const res = arkhamFetch(path, { signal: AbortSignal.timeout(25_000) })
      if (!res) return (out.probes[label] = { error: 'no key' })
      const r = await res
      if (r.status !== 200) return (out.probes[label] = { status: r.status })
      const j: any = await r.json()
      // surface top-level keys + chain keys + a hunt for address-shaped strings
      const top = j && typeof j === 'object' ? Object.keys(j) : typeof j
      const addrs: string[] = []
      const scan = (o: any, depth: number) => {
        if (depth > 4 || addrs.length >= 12 || !o || typeof o !== 'object') return
        for (const k in o) {
          const v = o[k]
          if (typeof v === 'string' && (/^0x[0-9a-fA-F]{40}$/.test(v) || /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v) || /^(bc1[a-z0-9]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,39})$/.test(v))) {
            addrs.push((k.includes('chain') || k.includes('Chain') ? '' : '') + v)
          } else if (typeof v === 'object') scan(v, depth + 1)
        }
      }
      scan(j, 0)
      out.probes[label] = { status: 200, topKeys: top, sampleAddrs: addrs.slice(0, 12), chainKeys: j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j).slice(0, 20) : undefined }
    } catch (e) {
      out.probes[label] = { error: (e as Error).message }
    }
  }
  await probe('entity', `/intelligence/entity/${encodeURIComponent(id)}`)
  await probe('portfolio', `/portfolio/entity/${encodeURIComponent(id)}?time=${Date.now()}`)
  await probe('entity_addresses', `/intelligence/entity/${encodeURIComponent(id)}/addresses`)
  return out
}

export interface ArkhamMetric {
  reserves: number | null
  volume7d: number | null
}
// key (roster slug) → arkham metrics, for the aggregate/leaderboard merge
export function arkhamMetrics(): Map<string, ArkhamMetric> {
  const out = new Map<string, ArkhamMetric>()
  for (const r of db.prepare("SELECT key, reserves_usd, volume7d_usd FROM arkham_casino WHERE entity_id != ''").all() as any[]) {
    out.set(r.key, { reserves: r.reserves_usd, volume7d: r.volume7d_usd })
  }
  return out
}
