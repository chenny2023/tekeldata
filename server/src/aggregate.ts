import { config } from './config.ts'
import { db, stmt, WatchRow } from './db.ts'
import { evmBalanceUsd } from './collectors/evm.ts'
import { tronBalanceUsd } from './collectors/tron.ts'
import { tronRpcBalanceUsd } from './collectors/tronrpc.ts'
import { evmChainsBalanceUsd } from './collectors/evmchains.ts'
import { matchCasinoMeta, brandKey, brandName, CasinoMeta } from './casinometa.ts'
import { reviewScores } from './collectors/reviews.ts'
import { tokenData, TokenInfo } from './collectors/casinotokens.ts'
import { riskFlags } from './collectors/risk.ts'

const DAY = 86_400_000

// ── Per-entity aggregation, computed entirely from REAL indexed transfers ─────
export interface EntityAgg {
  id: number
  label: string
  category: string
  chain: string
  address: string
  volume24h: number
  volume7d: number
  inflow7d: number
  outflow7d: number
  net7d: number
  change24h: number
  txCount7d: number
  players: number // distinct counterparties (7d)
  reserves: number // real on-chain stablecoin balance
  trust: number // blended: on-chain heuristic + community votes (when present)
  onchainTrust: number
  votesUp: number
  votesDown: number
  firstSeen: number | null
  byChain: { chain: string; value: number }[] // 7d volume split across the chains this entity transacts on
  meta: CasinoMeta | null // public reference profile (license, house edge, …)
  safetyIndex: number | null // casino.guru third-party Safety Index (0–10)
  trustpilot: number | null // Trustpilot rating (★/5)
  editorial: number | null // casino.org editorial rating (/5)
  complaints: number | null // casino.guru current complaint count
  unresolved: number | null // casino.guru unresolved complaints (red flag)
  userReviews: number | null // casino.guru community-review count
  token: TokenInfo | null // the casino's own token market data (CoinGecko), if any
  risk: { hits: number; usd: number; addresses: string[] } | null // OFAC-sanctioned exposure
}

const aggSql = db.prepare(`
  SELECT
    SUM(CASE WHEN ts >= @d1 THEN usd ELSE 0 END)                              AS vol24,
    SUM(CASE WHEN ts < @d1 AND ts >= @d2 THEN usd ELSE 0 END)                 AS volPrev24,
    SUM(CASE WHEN ts >= @d7 THEN usd ELSE 0 END)                             AS vol7,
    SUM(CASE WHEN ts >= @d7 AND direction='in'  THEN usd ELSE 0 END)         AS in7,
    SUM(CASE WHEN ts >= @d7 AND direction='out' THEN usd ELSE 0 END)         AS out7,
    COUNT(CASE WHEN ts >= @d7 THEN 1 END)                                    AS tx7,
    COUNT(DISTINCT CASE WHEN ts >= @d7 THEN counterparty END)               AS players7,
    MIN(ts)                                                                   AS firstSeen
  FROM transfers WHERE watch_id = @id
`)

// The per-entity scan is expensive (90+ entities × COUNT DISTINCT over 7d of
// rows) and three polled endpoints call this — serve a cached snapshot and
// recompute at most once per aggregation interval.
let aggCache: { at: number; data: EntityAgg[] } | null = null

// Optional `category` filter keeps non-iGaming entities (exchanges, whales,
// discovered services) out of the casino-facing views. The full list is still
// computed once and cached; filtering happens on the cached snapshot so callers
// can ask for 'casino' (default in the product UI) or 'all' (cross-category).
export function aggregateEntities(category?: string): EntityAgg[] {
  const all = computeEntities()
  if (!category || category === 'all') return all
  return all.filter((e) => e.category === category)
}

function computeEntities(): EntityAgg[] {
  if (aggCache && Date.now() - aggCache.at < config.aggregateMs) return aggCache.data
  const now = Date.now()
  const params = { d1: now - DAY, d2: now - 2 * DAY, d7: now - 7 * DAY }
  const rows = stmt.activeWatch.all() as WatchRow[]
  const out: EntityAgg[] = []

  const voteRows = db
    .prepare(
      `SELECT watch_id,
              SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) up,
              SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) down
       FROM votes GROUP BY watch_id`,
    )
    .all() as { watch_id: number; up: number; down: number }[]
  const voteMap = new Map(voteRows.map((v) => [v.watch_id, v]))

  // 7d volume per (entity, chain) in one scan — gives each entity its real
  // multi-chain deposit split (one watch entry accrues flow on every EVM chain)
  const chainRows = db
    .prepare('SELECT watch_id, chain, SUM(usd) v FROM transfers WHERE ts >= ? GROUP BY watch_id, chain')
    .all(params.d7) as { watch_id: number; chain: string; v: number }[]
  const byChainMap = new Map<number, { chain: string; value: number }[]>()
  for (const r of chainRows) {
    const arr = byChainMap.get(r.watch_id) ?? []
    arr.push({ chain: r.chain, value: r.v ?? 0 })
    byChainMap.set(r.watch_id, arr)
  }
  const reviews = reviewScores()
  const tokens = tokenData()
  const risks = riskFlags()

  for (const w of rows) {
    const a = aggSql.get({ id: w.id, ...params }) as any
    const vol24 = a.vol24 ?? 0
    const volPrev = a.volPrev24 ?? 0
    const change24h = volPrev > 0 ? ((vol24 - volPrev) / volPrev) * 100 : vol24 > 0 ? 100 : 0
    const bal = (db.prepare('SELECT usd FROM balances WHERE watch_id = ?').get(w.id) as any)?.usd ?? 0
    const v = voteMap.get(w.id)
    const votesUp = v?.up ?? 0
    const votesDown = v?.down ?? 0

    out.push({
      id: w.id,
      label: w.label,
      category: w.category,
      chain: w.chain,
      address: w.address,
      volume24h: vol24,
      volume7d: a.vol7 ?? 0,
      inflow7d: a.in7 ?? 0,
      outflow7d: a.out7 ?? 0,
      net7d: (a.in7 ?? 0) - (a.out7 ?? 0),
      change24h,
      txCount7d: a.tx7 ?? 0,
      players: a.players7 ?? 0,
      reserves: bal,
      ...blendTrust(
        trustScore({
          reserves: bal,
          volume7d: a.vol7 ?? 0,
          inflow7d: a.in7 ?? 0,
          outflow7d: a.out7 ?? 0,
          firstSeen: a.firstSeen,
          now,
        }),
        votesUp,
        votesDown,
      ),
      votesUp,
      votesDown,
      firstSeen: a.firstSeen ?? null,
      byChain: (byChainMap.get(w.id) ?? []).sort((x, y) => y.value - x.value),
      meta: w.category === 'casino' ? matchCasinoMeta(w.label) : null,
      safetyIndex: w.category === 'casino' ? reviews.get(brandKey(w.label))?.safety ?? null : null,
      trustpilot: w.category === 'casino' ? reviews.get(brandKey(w.label))?.trustpilot ?? null : null,
      editorial: w.category === 'casino' ? reviews.get(brandKey(w.label))?.editorial ?? null : null,
      complaints: w.category === 'casino' ? reviews.get(brandKey(w.label))?.complaints ?? null : null,
      unresolved: w.category === 'casino' ? reviews.get(brandKey(w.label))?.unresolved ?? null : null,
      userReviews: w.category === 'casino' ? reviews.get(brandKey(w.label))?.userReviews ?? null : null,
      token: w.category === 'casino' ? tokens.get(brandKey(w.label)) ?? null : null,
      risk: risks.get(w.id) ?? null,
    })
  }
  out.sort((x, y) => y.volume7d - x.volume7d)
  aggCache = { at: Date.now(), data: out }
  return out
}

// ── Brand-level aggregation (wallet clustering by known attribution) ──────────
// A real casino runs many wallets across chains (Stake.com + Stake.com(11) +
// TRON + …). Per-wallet rows badly undercount the brand, so group every entity
// by its brand key and sum — matching how circus.fyi reports one figure per
// casino. This is exact, not heuristic: the wallets are grouped by their own
// block-explorer name-tags, which we already trust.
export interface BrandAgg {
  brand: string
  category: string
  wallets: number
  chains: string[]
  volume24h: number
  volume7d: number
  inflow7d: number
  outflow7d: number
  net7d: number
  change24h: number
  txCount7d: number
  players: number
  reserves: number
  trust: number
  byChain: { chain: string; value: number }[]
  meta: CasinoMeta | null
  safetyIndex: number | null
  trustpilot: number | null
  editorial: number | null
  complaints: number | null
  unresolved: number | null
  userReviews: number | null
  token: TokenInfo | null
  risk: { hits: number; usd: number } | null
  members: { id: number; label: string; chain: string; address: string; volume7d: number }[]
}

let brandCache: { at: number; data: BrandAgg[] } | null = null
export function aggregateBrands(category?: string): BrandAgg[] {
  const all = computeBrands()
  if (!category || category === 'all') return all
  return all.filter((b) => b.category === category)
}

function computeBrands(): BrandAgg[] {
  if (brandCache && Date.now() - brandCache.at < config.aggregateMs) return brandCache.data
  const entities = aggregateEntities()
  const groups = new Map<string, EntityAgg[]>()
  for (const e of entities) {
    const key = `${e.category}:${brandKey(e.label)}`
    const arr = groups.get(key) ?? []
    arr.push(e)
    groups.set(key, arr)
  }
  const out: BrandAgg[] = []
  for (const members of groups.values()) {
    const head = members.reduce((a, b) => (b.volume7d > a.volume7d ? b : a), members[0])
    const sum = (f: (e: EntityAgg) => number) => members.reduce((s, e) => s + f(e), 0)
    const chainVol = new Map<string, number>()
    for (const e of members) for (const c of e.byChain) chainVol.set(c.chain, (chainVol.get(c.chain) ?? 0) + c.value)
    const vol7 = sum((e) => e.volume7d)
    const vol24 = sum((e) => e.volume24h)
    const volPrev = sum((e) => (e.change24h !== 0 ? e.volume24h / (1 + e.change24h / 100) : e.volume24h))
    out.push({
      brand: brandName(head.label),
      category: head.category,
      wallets: members.length,
      chains: [...new Set(members.flatMap((e) => e.byChain.map((c) => c.chain)))].sort(),
      volume24h: vol24,
      volume7d: vol7,
      inflow7d: sum((e) => e.inflow7d),
      outflow7d: sum((e) => e.outflow7d),
      net7d: sum((e) => e.net7d),
      change24h: volPrev > 0 ? ((vol24 - volPrev) / volPrev) * 100 : vol24 > 0 ? 100 : 0,
      txCount7d: sum((e) => e.txCount7d),
      players: sum((e) => e.players), // upper bound (cross-wallet overlap not deduped)
      reserves: sum((e) => e.reserves),
      trust: vol7 > 0 ? Math.round(sum((e) => e.trust * e.volume7d) / vol7) : head.trust, // volume-weighted
      byChain: [...chainVol.entries()].map(([chain, value]) => ({ chain, value })).sort((a, b) => b.value - a.value),
      meta: members.map((e) => e.meta).find(Boolean) ?? null,
      safetyIndex: members.map((e) => e.safetyIndex).find((s) => s != null) ?? null,
      trustpilot: members.map((e) => e.trustpilot).find((s) => s != null) ?? null,
      editorial: members.map((e) => e.editorial).find((s) => s != null) ?? null,
      complaints: members.map((e) => e.complaints).find((s) => s != null) ?? null,
      unresolved: members.map((e) => e.unresolved).find((s) => s != null) ?? null,
      userReviews: members.map((e) => e.userReviews).find((s) => s != null) ?? null,
      token: members.map((e) => e.token).find((t) => t != null) ?? null,
      risk: members.some((e) => e.risk)
        ? { hits: sum((e) => e.risk?.hits ?? 0), usd: sum((e) => e.risk?.usd ?? 0) }
        : null,
      members: members
        .map((e) => ({ id: e.id, label: e.label, chain: e.chain, address: e.address, volume7d: e.volume7d }))
        .sort((a, b) => b.volume7d - a.volume7d),
    })
  }
  out.sort((x, y) => y.volume7d - x.volume7d)
  brandCache = { at: Date.now(), data: out }
  return out
}

// Blend the on-chain heuristic with real community votes (circus-style
// "audits + user votes"). Votes contribute up to 30%, weighted by sample size
// so a single vote can't swing an entity's score.
function blendTrust(onchain: number, up: number, down: number): { trust: number; onchainTrust: number } {
  const total = up + down
  if (total === 0) return { trust: onchain, onchainTrust: onchain }
  const community = 50 + 50 * ((up - down) / total)
  const weight = 0.3 * Math.min(1, total / 10)
  return { trust: Math.round(onchain * (1 - weight) + community * weight), onchainTrust: onchain }
}

// Transparent, fully-derived trust heuristic (0–100) over REAL on-chain signals:
//   • reserve coverage  — reserves vs weekly outflow (solvency proxy)
//   • flow balance      — how close inflow/outflow are (healthy 2-way liquidity)
//   • track record      — how long we've observed on-chain activity
//   • liquidity depth   — absolute reserves (log-scaled)
function trustScore(s: {
  reserves: number
  volume7d: number
  inflow7d: number
  outflow7d: number
  firstSeen: number | null
  now: number
}): number {
  const coverage = s.outflow7d > 0 ? Math.min(1, s.reserves / s.outflow7d) : s.reserves > 0 ? 1 : 0.4
  const total = s.inflow7d + s.outflow7d
  const balance = total > 0 ? 1 - Math.abs(s.inflow7d - s.outflow7d) / total : 0.5
  const ageDays = s.firstSeen ? (s.now - s.firstSeen) / DAY : 0
  const track = Math.min(1, ageDays / 30)
  const depth = s.reserves > 0 ? Math.min(1, Math.log10(s.reserves + 10) / 9) : 0.2
  const score = 100 * (coverage * 0.34 + balance * 0.26 + depth * 0.24 + track * 0.16)
  return Math.round(Math.max(8, Math.min(99, score)))
}

// ── Refresh real on-chain reserves for every watched address ──────────────────
let refreshing = false
export async function refreshBalances() {
  if (refreshing) return
  refreshing = true
  try {
    const rows = stmt.activeWatch.all() as WatchRow[]
    for (const w of rows) {
      let usd: number
      if (w.chain === 'ETH') {
        // EVM address — sum reserves across mainnet + every extra EVM chain
        const balances = await Promise.all([evmBalanceUsd(w.address), ...evmChainsBalanceUsd(w.address)])
        usd = balances.reduce((a, b) => a + b, 0)
      } else {
        usd = config.tronMode === 'jsonrpc' ? await tronRpcBalanceUsd(w.address) : await tronBalanceUsd(w.address)
      }
      // skip overwriting a known balance with 0 on a transient fetch failure
      if (usd > 0 || !(db.prepare('SELECT usd FROM balances WHERE watch_id=?').get(w.id) as any)?.usd) {
        stmt.upsertBalance.run(w.id, usd, Date.now())
      }
      await new Promise((r) => setTimeout(r, w.chain === 'TRON' ? 2000 : 120))
    }
  } finally {
    refreshing = false
  }
}

export function startAggregation() {
  refreshBalances().catch(() => {})
  setInterval(() => refreshBalances().catch(() => {}), config.aggregateMs * 4)
}
