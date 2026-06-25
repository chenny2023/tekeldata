import { config } from './config.ts'
import { db, stmt, stateGet, stateSet, WatchRow } from './db.ts'
import { workerGet, workerAll } from './readpool.ts'
import { evmBalanceUsd } from './collectors/evm.ts'
import { tronBalanceUsd } from './collectors/tron.ts'
import { tronRpcBalanceUsd } from './collectors/tronrpc.ts'
import { evmChainsBalanceUsd } from './collectors/evmchains.ts'
import { matchCasinoMeta, brandKey, brandName, CasinoMeta } from './casinometa.ts'
import { isVolumeSuspect } from './brandaliases.ts'
import { reviewScores } from './collectors/reviews.ts'
import { tokenData, TokenInfo } from './collectors/casinotokens.ts'
import { priorCoverage } from './reservehistory.ts'
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
  reserveCoverage: number | null // reserves / weekly outflow ≈ weeks of withdrawal coverage (solvency)
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
  askgamblers: number | null // AskGamblers expert rating (/10)
  complaints: number | null // casino.guru current complaint count
  unresolved: number | null // casino.guru unresolved complaints (red flag)
  userReviews: number | null // casino.guru community-review count
  reputation: number | null // composite 0–100 of all external review signals
  token: TokenInfo | null // the casino's own token market data (CoinGecko), if any
  risk: { hits: number; usd: number; addresses: string[] } | null // OFAC-sanctioned exposure
}

// The per-entity scan is expensive (90+ entities × COUNT DISTINCT over 7d of
// rows) and three polled endpoints call this — serve a cached snapshot and
// recompute at most once per aggregation interval.
let aggCache: { at: number; data: EntityAgg[] } | null = null

// Per-address unique-counterparties (players) + first-seen. COUNT(DISTINCT
// counterparty) and MIN(ts) are the two costly parts of the leaderboard — done in
// one grouped scan they freeze the single-threaded loop for tens of seconds. So
// instead we maintain them in the BACKGROUND, one address at a time (each
// WHERE watch_id=? query is fast + index-backed), yielding to the event loop
// between addresses, so the heavy work NEVER blocks a request. Eventually
// consistent: every casino's count is refreshed each cycle.
const playersMap = new Map<number, number>()
const firstSeenMap = new Map<number, number>()
const getPlayers = (): Map<number, number> => playersMap
const getFirstSeen = (): Map<number, number> => firstSeenMap

// Headline player counts for /api/stats, summed from the background-maintained
// per-entity distinct-counterparty map. This replaces the global
// COUNT(DISTINCT counterparty) over 24M rows — a ~40s SYNCHRONOUS scan that froze
// the single event loop (the sole cause of the post-deploy / hourly stalls). It's
// an active-counterparty figure (7d, summed per entity) rather than an all-time
// global distinct, but it never blocks. Empty until startStatsMaintenance's first
// pass lands (~3 min after boot), then continuously fresh.
export function maintainedPlayers(): { all: number; casino: number } {
  const cats = db.prepare('SELECT id, category FROM watchlist WHERE active=1').all() as { id: number; category: string }[]
  const catMap = new Map(cats.map((c) => [c.id, c.category]))
  let all = 0
  let casino = 0
  for (const [id, p] of playersMap) {
    all += p
    if (catMap.get(id) === 'casino') casino += p
  }
  // Cold start: the map is empty until maintenance finishes its first pass (~10 min
  // after a deploy, since each entity is a yielded COUNT(DISTINCT)). Serve the
  // last-known persisted total so the headline never shows 0 right after a deploy.
  if (all === 0) {
    try {
      const j = JSON.parse(stateGet('stats:players') || '{}')
      return { all: Number(j.all) || 0, casino: Number(j.casino) || 0 }
    } catch {
      return { all: 0, casino: 0 }
    }
  }
  return { all, casino }
}

let maintaining = false
// true once the background players count has finished its first full pass — until
// then `players` is unreliable (~0), so volume-suspect heuristics must stay off.
let playersPassComplete = false
export async function startStatsMaintenance(): Promise<void> {
  if (maintaining) return
  maintaining = true
  const idsQ = db.prepare('SELECT id FROM watchlist WHERE active=1')
  // These two are the costly per-entity scans (COUNT(DISTINCT counterparty), MIN(ts)).
  // Run them through the read worker so they execute OFF the main event loop — when
  // READ_WORKER is disabled, workerGet transparently runs them on the main thread
  // (same as before). Either way the loop yields between every entity.
  const P_SQL = 'SELECT COUNT(DISTINCT counterparty) p FROM transfers WHERE watch_id=? AND ts>=?'
  const F_SQL = 'SELECT MIN(ts) f FROM transfers WHERE watch_id=?'
  const yield_ = () => new Promise((r) => setImmediate(r))
  for (;;) {
    try {
      const ids = (idsQ.all() as { id: number }[]).map((r) => r.id)
      const d7 = Date.now() - 7 * 86_400_000
      for (const id of ids) {
        try {
          const p = await workerGet<{ p: number }>(P_SQL, [id, d7])
          playersMap.set(id, p?.p ?? 0)
          if (!firstSeenMap.has(id)) {
            const f = await workerGet<{ f: number }>(F_SQL, [id]) // first-seen is static
            firstSeenMap.set(id, f?.f ?? 0)
          }
        } catch {
          /* skip a bad row */
        }
        await yield_() // hand the event loop back between every address
      }
      playersPassComplete = true // every entity now has a real counterparty count
      // a full pass completed — persist the rolled-up headline so a fresh deploy
      // serves last-known players instantly (the in-memory map starts empty)
      try {
        const { all, casino } = maintainedPlayers()
        if (all > 0) stateSet('stats:players', JSON.stringify({ all, casino }))
      } catch {
        /* non-fatal */
      }
    } catch {
      /* transient */
    }
    await new Promise((r) => setTimeout(r, 120_000)) // ~2 min between full refresh cycles
  }
}

// Optional `category` filter keeps non-iGaming entities (exchanges, whales,
// discovered services) out of the casino-facing views. The full list is still
// computed once and cached; filtering happens on the cached snapshot so callers
// can ask for 'casino' (default in the product UI) or 'all' (cross-category).
export async function aggregateEntities(category?: string): Promise<EntityAgg[]> {
  const all = await computeEntities()
  if (!category || category === 'all') return all
  return all.filter((e) => e.category === category)
}

async function computeEntities(): Promise<EntityAgg[]> {
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
  // the two 7d GROUP BY scans over the 24M-row transfers table are the heavy part —
  // run them in the read worker (off the main event loop). workerAll falls back to
  // the main thread when READ_WORKER is disabled, so behaviour is unchanged there.
  const chainRows = (await workerAll(
    'SELECT watch_id, chain, SUM(usd) v FROM transfers WHERE ts >= ? GROUP BY watch_id, chain',
    [params.d7],
  )) as { watch_id: number; chain: string; v: number }[]
  const byChainMap = new Map<number, { chain: string; value: number }[]>()
  for (const r of chainRows) {
    const arr = byChainMap.get(r.watch_id) ?? []
    arr.push({ chain: r.chain, value: r.v ?? 0 })
    byChainMap.set(r.watch_id, arr)
  }
  const reviews = reviewScores()
  const tokens = tokenData()
  const risks = riskFlags()

  // Per-address volume/flow stats in ONE grouped scan over the 7d window (was a
  // per-address query × COUNT(DISTINCT) — O(addresses) full scans that blew up to
  // 30s+ once Arkham harvesting widened the watchlist). firstSeen + balances are
  // likewise loaded once into Maps instead of a query per address.
  const aggRows = (await workerAll(
    `SELECT watch_id,
       SUM(CASE WHEN ts >= ? THEN usd ELSE 0 END)            AS vol24,
       SUM(CASE WHEN ts < ? AND ts >= ? THEN usd ELSE 0 END) AS volPrev24,
       SUM(usd)                                              AS vol7,
       SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END)    AS in7,
       SUM(CASE WHEN direction='out' THEN usd ELSE 0 END)    AS out7,
       COUNT(*)                                              AS tx7
     FROM transfers WHERE ts >= ? GROUP BY watch_id`,
    [params.d1, params.d1, params.d2, params.d7],
  )) as any[]
  const aggMap = new Map<number, any>(aggRows.map((r) => [r.watch_id, r]))
  const firstMap = getFirstSeen() // first-seen barely changes — cached hourly, off the hot path
  const playerCounts = getPlayers() // background-maintained — never blocks the request
  const balMap = new Map<number, number>((db.prepare('SELECT watch_id, usd FROM balances').all() as any[]).map((r) => [r.watch_id, r.usd]))

  for (const w of rows) {
    const a = aggMap.get(w.id) ?? {}
    a.firstSeen = firstMap.get(w.id) ?? null
    const vol24 = a.vol24 ?? 0
    const volPrev = a.volPrev24 ?? 0
    const change24h = volPrev > 0 ? ((vol24 - volPrev) / volPrev) * 100 : vol24 > 0 ? 100 : 0
    const bal = balMap.get(w.id) ?? 0
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
      players: playerCounts.get(w.id) ?? 0,
      reserves: bal,
      reserveCoverage: (a.out7 ?? 0) > 0 ? bal / (a.out7 as number) : null, // weeks of withdrawal coverage
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
      askgamblers: w.category === 'casino' ? reviews.get(brandKey(w.label))?.askgamblers ?? null : null,
      complaints: w.category === 'casino' ? reviews.get(brandKey(w.label))?.complaints ?? null : null,
      unresolved: w.category === 'casino' ? reviews.get(brandKey(w.label))?.unresolved ?? null : null,
      userReviews: w.category === 'casino' ? reviews.get(brandKey(w.label))?.userReviews ?? null : null,
      reputation:
        w.category === 'casino'
          ? reputationScore({
              safetyIndex: reviews.get(brandKey(w.label))?.safety ?? null,
              trustpilot: reviews.get(brandKey(w.label))?.trustpilot ?? null,
              editorial: reviews.get(brandKey(w.label))?.editorial ?? null,
              askgamblers: reviews.get(brandKey(w.label))?.askgamblers ?? null,
              complaints: reviews.get(brandKey(w.label))?.complaints ?? null,
              unresolved: reviews.get(brandKey(w.label))?.unresolved ?? null,
            })
          : null,
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
// An auto-detected "Casino-pattern 0x…" / raw-address / unknown label is on-chain
// activity we can't yet attribute to a real brand — it must never be shown as a
// verified casino (kept out of rankings, profiles, sentiment & verified totals).
export function isUnattributed(label: string): boolean {
  const s = String(label || '').trim().toLowerCase()
  return /^casino-pattern\b/.test(s) || /^0x[0-9a-f]{4,}/.test(s) || /^(unknown|unnamed|unidentified|unattributed)\b/.test(s)
}

export interface BrandAgg {
  brand: string
  category: string
  attributed: boolean // false for auto-detected 'Casino-pattern 0x…' / raw-address labels
  confidence: 'high' | 'medium' | 'low' // data confidence for public display
  volumeSuspect: boolean // anomalous on-chain volume (wash/internal) — keep out of volume rankings
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
  reserveCoverage: number | null
  coverageChange: number | null // coverage vs ~7d ago (relative) — colours the trend
  trust: number
  byChain: { chain: string; value: number }[]
  meta: CasinoMeta | null
  safetyIndex: number | null
  trustpilot: number | null
  editorial: number | null
  askgamblers: number | null
  complaints: number | null
  unresolved: number | null
  userReviews: number | null
  reputation: number | null
  token: TokenInfo | null
  risk: { hits: number; usd: number } | null
  members: { id: number; label: string; chain: string; address: string; volume7d: number }[]
}

// a brand is a dead auto-harvested label (e.g. the 2018 etherscan "gambling"
// dApps: Fomo3D, PowH3D, iDice…) when it has no roster profile AND no indexed
// activity AND no reserves — pure noise that shouldn't clutter the leaderboard.
const isDeadLabel = (b: BrandAgg) => b.category === 'casino' && !b.meta && b.volume7d <= 0 && b.reserves <= 0

let brandCache: { at: number; data: BrandAgg[] } | null = null
export async function aggregateBrands(category?: string): Promise<BrandAgg[]> {
  const raw = await computeBrands()
  // only prune dead labels once the aggregate is WARM (some brand has volume) — on
  // a cold post-deploy window everything reads 0 and we'd wrongly hide real casinos
  const warm = raw.some((b) => b.volume7d > 0 || b.reserves > 0)
  const all = warm ? raw.filter((b) => !isDeadLabel(b)) : raw
  if (!category || category === 'all') return all
  return all.filter((b) => b.category === category)
}

async function computeBrands(): Promise<BrandAgg[]> {
  if (brandCache && Date.now() - brandCache.at < config.aggregateMs) return brandCache.data
  const entities = await aggregateEntities()
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
    const bName = brandName(head.label)
    const brReserves = sum((e) => e.reserves)
    const brOutflow = sum((e) => e.outflow7d)
    const brCoverage = brOutflow > 0 ? brReserves / brOutflow : null
    // period-over-period coverage change (vs ~7d ago) — null until history exists
    const prior = head.category === 'casino' ? priorCoverage(bName) : null
    const coverageChange = prior != null && prior > 0 && brCoverage != null ? (brCoverage - prior) / prior : null
    // attribution + data confidence (drives what's allowed on public surfaces)
    const metaV = members.map((e) => e.meta).find(Boolean) ?? null
    const safetyV = members.map((e) => e.safetyIndex).find((s) => s != null) ?? null
    const tpV = members.map((e) => e.trustpilot).find((s) => s != null) ?? null
    const agV = members.map((e) => e.askgamblers).find((s) => s != null) ?? null
    const edV = members.map((e) => e.editorial).find((s) => s != null) ?? null
    const ratingCount = [safetyV, tpV, agV, edV].filter((v) => v != null).length
    const attributed = !isUnattributed(bName) && !isUnattributed(head.label)
    const volumeSuspect = attributed && isVolumeSuspect(bName, vol7, sum((e) => e.players), playersPassComplete, sum((e) => e.txCount7d))
    const confidence: 'high' | 'medium' | 'low' = !attributed
      ? 'low'
      : metaV || ratingCount >= 2 || (vol7 > 0 && brReserves > 0)
        ? 'high'
        : vol7 > 0 || brReserves > 0 || ratingCount >= 1
          ? 'medium'
          : 'low'
    out.push({
      brand: bName,
      category: head.category,
      attributed,
      confidence,
      volumeSuspect,
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
      reserves: brReserves,
      reserveCoverage: brCoverage,
      coverageChange,
      trust: vol7 > 0 ? Math.round(sum((e) => e.trust * e.volume7d) / vol7) : head.trust, // volume-weighted
      byChain: [...chainVol.entries()].map(([chain, value]) => ({ chain, value })).sort((a, b) => b.value - a.value),
      meta: metaV,
      safetyIndex: safetyV,
      trustpilot: tpV,
      editorial: edV,
      askgamblers: agV,
      complaints: members.map((e) => e.complaints).find((s) => s != null) ?? null,
      unresolved: members.map((e) => e.unresolved).find((s) => s != null) ?? null,
      userReviews: members.map((e) => e.userReviews).find((s) => s != null) ?? null,
      reputation: members.map((e) => e.reputation).find((s) => s != null) ?? null,
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
// Composite REPUTATION score (0–100) synthesising the external trust signals we
// collect into one headline number — distinct from the on-chain `trust` (which
// stays a pure on-chain/solvency signal). Weighted blend of the independent
// ratings, with a complaint penalty (unresolved disputes weigh most). Returns
// null when we have no reputation signal at all for the casino.
export interface RepInputs {
  safetyIndex: number | null // 0–10
  trustpilot: number | null // /5
  editorial: number | null // /5
  askgamblers: number | null // /10
  complaints: number | null
  unresolved: number | null
}
function reputationScore(r: RepInputs): number | null {
  const sigs: { v: number; w: number }[] = []
  if (r.safetyIndex != null) sigs.push({ v: r.safetyIndex * 10, w: 1.2 }) // expert review, weighted highest
  if (r.trustpilot != null) sigs.push({ v: r.trustpilot * 20, w: 1.0 }) // consumer reviews
  if (r.editorial != null) sigs.push({ v: r.editorial * 20, w: 0.7 }) // editorial review
  if (r.askgamblers != null) sigs.push({ v: r.askgamblers * 10, w: 1.0 }) // AskGamblers expert rating /10
  if (sigs.length === 0) return null
  let s = sigs.reduce((a, x) => a + x.v * x.w, 0) / sigs.reduce((a, x) => a + x.w, 0)
  // complaint penalty: unresolved disputes are the sharpest red flag
  if (r.unresolved && r.unresolved > 0) s -= Math.min(25, r.unresolved * 4)
  else if (r.complaints && r.complaints > 5) s -= Math.min(8, r.complaints - 5)
  return Math.round(Math.max(0, Math.min(100, s)))
}

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
