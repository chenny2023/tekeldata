import { useEffect, useRef, useState } from 'react'

// ── Types mirror the backend (server/src) ─────────────────────────────────────
export interface CategoryStats {
  totalVolume: number
  volume7d: number
  totalTransfers: number
  uniquePlayers: number
  reserves: number
  entities: number
  chainSplit: { chain: string; value: number }[]
}

export interface Stats {
  totalVolume: number
  volume7d: number
  totalTransfers: number
  uniquePlayers: number
  reserves: number
  entities: number
  liveStreamers: number
  chainSplit: { chain: string; value: number }[]
  casino?: CategoryStats // iGaming-only headline figures (exchanges/whales excluded)
}

export interface Entity {
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
  players: number
  reserves: number
  reserveCoverage: number | null
  trust: number
  onchainTrust: number
  votesUp: number
  votesDown: number
  firstSeen: number | null
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
  risk: { hits: number; usd: number; addresses: string[] } | null
}

export interface TokenInfo {
  symbol: string
  price: number
  marketCap: number
  change24h: number | null
  change7d: number | null
  fdv: number | null
  volume24h: number | null
  athChangePct: number | null
  buyback: boolean
}

export interface CasinoMeta {
  name: string
  license: string | null
  foundedYear: number | null
  houseEdge: number | null
  sportsHouseEdge: number | null
  currencies: string[]
  chains: string[]
  website: string | null
  logo: string | null
}

export interface Brand {
  brand: string
  category: string
  attributed: boolean
  confidence: 'high' | 'medium' | 'low'
  volumeSuspect: boolean
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
  coverageChange: number | null
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

export interface Transfer {
  chain: string
  tx_hash: string
  token: string
  from_addr: string
  to_addr: string
  counterparty: string
  amount: number
  usd: number
  watch_id: number
  label: string
  category: string
  direction: 'in' | 'out'
  block: number
  ts: number
}

export interface SeriesPoint {
  t: number
  deposits: number
  withdrawals: number
}

export interface FlowBucket {
  name: string
  color: string
  count: number
  volume: number
  players: number
  share: number
}

export interface StreamerRow {
  id: string
  handle: string
  platform: string
  viewers: number
  live: number
  title: string
  game: string
  thumbnail: string
  followers: number
  affiliation: string | null
}

export interface StreamerProfile {
  platform: string
  slug: string
  name: string
  followers: number
  content: string | null
  language: string | null
  bio: string | null
  telegram: string | null
  discord: string | null
  twitter: string | null
  instagram: string | null
  youtube: string | null
}
export interface StreamerDetail {
  profile: StreamerProfile | null
  live: StreamerRow | null
}

export interface ContentPreview {
  status: string // qa_pass | risk_high | qa_fail | generation_fail | disabled | qa_pass_no_x_keys
  risk?: string
  error?: string
  data?: {
    content_type?: string
    tweets?: { text: string }[]
    post_text?: string
    image?: { title?: string; subtitle?: string; rows?: { rank: number; brand: string; value: string }[]; footer?: string }
    data_notes?: string[]
  }
  qa?: { pass: boolean; riskLevel: string; failures: string[] }
}
export interface ContentLogRow {
  date: string
  content_type: string
  status: string
  risk_level: string | null
  model: string | null
  published_url: string | null
  skipped_reason: string | null
  error: string | null
  created_at: number
}

export interface FavoriteItem {
  brandKey: string
  label: string
  createdAt: number
  stats: {
    volume7d: number
    volume24h: number
    net7d: number
    reserves: number
    trust: number
    chains: string[]
    safetyIndex: number | null
    trustpilot: number | null
    change24h: number
  } | null
}

export interface SentimentEntity extends Entity {
  mentions7d: number
  mentionsPos: number
  mentionsNeg: number
  telegramSubs: number
  myVote: number
  chains?: string[] // brand-merged: every chain the operator transacts on
  wallets?: number // brand-merged: number of attributed wallets
}

export interface AuthUser {
  id: number
  email: string
  role: string
}

export interface WatchRow {
  id: number
  chain: string
  address: string
  label: string
  category: string
  active: number
  created_at: number
}

export interface Health {
  ok: boolean
  env: string
  watchlist: number
  transfers: number
  evmLastBlock: number
  historyDays: number
  backfillPct: number
  twitch: boolean
  time: number
}

const BASE = '/api'

// ── auth token (persisted) ────────────────────────────────────────────────────
const TOKEN_KEY = 'wcoin_token'
export function getToken(): string | null {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null
}
export function setToken(token: string | null) {
  if (typeof localStorage === 'undefined') return
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}
function authHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface DirRow {
  domain: string
  name: string
  website: string
  twitter: string | null
  email: string | null
  site_ok: number
  x_ok: number
  email_ok: number
  source: string | null
  status: string | null
  tp_rating: number | null
  tp_reviews: number | null
  last_checked: number
}
export interface OnchainProtocol {
  slug: string
  name: string
  category: string | null
  chains: string | null
  tvl: number | null
  change_1d: number | null
  change_7d: number | null
  mcap: number | null
  url: string | null
  twitter: string | null
  logo: string | null
}
export interface ProtocolsResp {
  count: number
  totalTvl: number
  byCategory: Record<string, number>
  protocols: OnchainProtocol[]
}
export interface PredictionMarket {
  id: string
  question: string
  volume: number | null
  liquidity: number | null
  outcomes: string[] | null
  prices: string[] | null
  end_date: string | null
  category: string | null
  url: string | null
}
export interface PredictionsResp {
  count: number
  totalVolume: number
  markets: PredictionMarket[]
}
export interface Sponsorship {
  casino: string
  streamers: number
  reach: number
  liveNow: number
  liveViewers: number
  streamersList: { handle: string; platform: string; followers: number; live: number; viewers: number }[]
}
export interface SponsorshipsResp {
  count: number
  sponsorships: Sponsorship[]
}
export interface SearchResults {
  casinos: { name: string }[]
  directory: { name: string; domain: string | null; rating: number | null }[]
  streamers: { handle: string; platform: string }[]
  wallets: { label: string; chain: string; address: string }[]
}
export interface Notification {
  type: string
  title: string
  detail: string
  ts: number
  href: string
}
export interface Coverage {
  casinos: number
  sitesLive: number
  trustpilotRated: number
  reservesCount: number
  reservesUsd: number
  predictionMarkets: number
  predictionVolume: number
  protocols: number
  protocolTvl: number
  mentions: number
  streamers: number
  trustRated: number
  chains: number
}
export interface ArkhamReserves {
  count: number
  totalUsd: number
  totalVolume7d: number
  casinos: { name: string; domain: string | null; entityId: string; reservesUsd: number; volume7dUsd: number | null; change7d: number | null; solvencyAlert: boolean }[]
}
export interface DirStats {
  total: number
  site: number
  x: number
  email: number
  included: number
  rated: number
  checked: number
}

// CSV export needs the auth header, so fetch as a blob + trigger the download
export async function downloadDirectoryCsv(filter = 'live') {
  const res = await fetch(`${BASE}/directory/export.csv?filter=${filter}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`export HTTP ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'casino-directory.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: authHeaders() })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as any)?.error ?? `HTTP ${res.status}`)
  return json as T
}

export const api = {
  stats: () => getJson<Stats>('/stats'),
  entities: (category?: string) =>
    getJson<Entity[]>('/entities' + (category && category !== 'all' ? `?category=${category}` : '')),
  casinos: (category = 'casino') => getJson<Entity[]>(`/casinos?category=${category}`),
  brands: (category = 'casino') => getJson<Brand[]>(`/brands?category=${category}`),
  transfers: (q: { chain?: string; dir?: string; min?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (q.chain) p.set('chain', q.chain)
    if (q.dir) p.set('dir', q.dir)
    if (q.min) p.set('min', String(q.min))
    if (q.limit) p.set('limit', String(q.limit))
    return getJson<Transfer[]>('/transfers?' + p.toString())
  },
  series: (days = 7, category = 'casino') =>
    getJson<SeriesPoint[]>(`/series?days=${days}` + (category && category !== 'all' ? `&category=${category}` : '')),
  // automated X content pipeline — dry-run preview (generate + QA, never posts) + run log
  contentPreview: (type: string) => getJson<ContentPreview>(`/content/preview?type=${encodeURIComponent(type)}`),
  contentLog: () => getJson<{ items: ContentLogRow[] }>('/content/log'),
  contentCardImage: async (): Promise<string> => {
    const res = await fetch(`${BASE}/content/card-preview.png`, { headers: authHeaders() })
    if (!res.ok) throw new Error('card unavailable')
    return URL.createObjectURL(await res.blob())
  },
  contentPublish: (type: string) =>
    sendJson<{ started?: boolean; type?: string; note?: string; error?: string }>('/content/publish', 'POST', { type }),
  entitySeries: (id: number, days = 30) =>
    getJson<{ chains: string[]; series: ({ t: number } & Record<string, number>)[] }>(`/entity/${id}/series?days=${days}`),
  entityFlow: (id: number, days = 30) =>
    getJson<{ entity: string | null; days: number; sources: FlowNode[]; sinks: FlowNode[] }>(`/entity/${id}/flow?days=${days}`),
  flow: (category = 'casino') =>
    getJson<FlowBucket[]>('/flow' + (category && category !== 'all' ? `?category=${category}` : '')),
  streamers: () =>
    getJson<{ enabled: boolean; twitch: boolean; roster: number; streamers: StreamerRow[]; offline: StreamerRow[] }>(
      '/streamers',
    ),
  sentiment: (category = 'casino') =>
    getJson<{ redditEnabled: boolean; newsEnabled: boolean; mentionsBySource: Record<string, number>; entities: SentimentEntity[] }>(
      `/sentiment?category=${category}`,
    ),
  watchlist: () => getJson<WatchRow[]>('/watchlist'),
  health: () => getJson<Health>('/health'),
  addWatch: (body: { chain: string; address: string; label: string; category: string }) =>
    sendJson<{ ok: boolean }>('/watchlist', 'POST', body),
  removeWatch: (id: number) => sendJson<{ ok: boolean }>(`/watchlist/${id}`, 'DELETE'),
  // personal watchlist (per-user favourited casinos)
  myWatchlist: () => getJson<{ items: FavoriteItem[] }>('/me/watchlist'),
  addFavorite: (label: string) => sendJson<{ ok: boolean; brandKey: string }>('/me/watchlist', 'POST', { label }),
  removeFavorite: (key: string) => sendJson<{ ok: boolean }>(`/me/watchlist/${encodeURIComponent(key)}`, 'DELETE'),
  addRoster: (body: { platform: string; slug: string }) => sendJson<{ ok: boolean }>('/roster', 'POST', body),
  vote: (watch_id: number, vote: 1 | -1) => sendJson<{ ok: boolean }>('/vote', 'POST', { watch_id, vote }),
  // passwordless auth: request a 6-digit code, then exchange it for a session
  requestCode: (email: string) =>
    sendJson<{ sent: boolean; delivered: boolean; devCode?: string }>('/auth/request-code', 'POST', { email }),
  verifyCode: (email: string, code: string) =>
    sendJson<{ token: string; user: AuthUser }>('/auth/verify', 'POST', { email, code }),
  me: () => getJson<{ user: AuthUser }>('/auth/me'),
  logout: () => sendJson<{ ok: boolean }>('/auth/logout', 'POST'),
  directory: (filter?: string, q?: string) => {
    const p = new URLSearchParams()
    if (filter) p.set('filter', filter)
    if (q) p.set('q', q)
    return getJson<{ stats: DirStats; rows: DirRow[] }>('/directory?' + p.toString())
  },
  arkhamReserves: () => getJson<ArkhamReserves>('/arkham/reserves'),
  coverage: () => getJson<Coverage>('/coverage'),
  search: (q: string) => getJson<SearchResults>('/search?q=' + encodeURIComponent(q)),
  notifications: () => getJson<{ items: Notification[] }>('/notifications'),
  sponsorships: () => getJson<SponsorshipsResp>('/sponsorships'),
  streamer: (platform: string, slug: string) => getJson<StreamerDetail>(`/streamer?platform=${encodeURIComponent(platform)}&slug=${encodeURIComponent(slug)}`),
  protocols: (category?: string) => getJson<ProtocolsResp>('/protocols' + (category ? `?category=${encodeURIComponent(category)}` : '')),
  predictions: () => getJson<PredictionsResp>('/predictions'),
  alertRules: () => getJson<AlertRule[]>('/alerts/rules'),
  createAlertRule: (body: { kind: string; scope: string; scopeLabel?: string; threshold: number; windowH?: number; webhook?: string; notifyEmail?: boolean }) =>
    sendJson<{ ok: boolean }>('/alerts/rules', 'POST', body),
  deleteAlertRule: (id: number) => sendJson<{ ok: boolean }>(`/alerts/rules/${id}`, 'DELETE'),
  alertEvents: (limit = 50) => getJson<AlertEvent[]>(`/alerts/events?limit=${limit}`),
  marketSnapshot: () => getJson<MarketSnapshot>('/snapshot/market'),
  subscribe: (email: string) => sendJson<{ sent: boolean; delivered?: boolean; devCode?: string; alreadyActive?: boolean }>('/subscribe', 'POST', { email }),
  subscribeVerify: (email: string, code: string) =>
    sendJson<{ active: boolean; unsubscribeToken?: string; frequency?: string }>('/subscribe/verify', 'POST', { email, code }),
}

export interface MarketSnapshot {
  snapshot_date: string
  tracked_volume_24h: number
  net_flow_24h: number
  active_casinos: number
  active_chains: number
  live_streamers: number
  reserves_total: number
  reserve_change_7d: number | null
  confidence_level: string
  payload: {
    topMovers: { label: string; vol24h: number; vol7d: number; net7d: number; trust: number | null; repSignal?: number | null; confidence?: string; change24h?: number | null }[]
    topReserves: { label: string; reserves: number; coverage: number | null; level?: string; confidence?: string }[]
    chainVolume: { chain: string; vol24h: number }[]
    whaleGroups?: { label: string; chain: string; direction: string; count: number; total: number; largest: number }[]
    whales: { label: string; chain: string; usd: number; direction: string; ts: number }[]
    unattributed?: { count: number; vol24h: number; vol7d: number; top: { label: string; vol7d: number }[] }
  }
  error?: string
}

export interface FlowNode {
  name: string
  usd: number
  named: boolean
}

export interface AlertRule {
  id: number
  kind: string
  scope: string
  scope_label: string | null
  threshold: number
  window_h: number
  webhook: string | null
  active: number
  created_at: number
}
export interface AlertEvent {
  id: number
  rule_id: number
  kind: string
  title: string
  detail: string | null
  usd: number | null
  entity: string | null
  chain: string | null
  tx_hash: string | null
  ts: number
}

// ── Generic polling hook ──────────────────────────────────────────────────────
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 15_000, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fetcher)
  fnRef.current = fetcher

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let fails = 0
    let loadedOnce = false
    const schedule = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(tick, ms)
    }
    const tick = () => {
      // Pause while the tab is hidden — backgrounded tabs hammering the single-
      // threaded backend is pure waste. We reschedule a light check; the real
      // refetch happens immediately on visibilitychange.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule(intervalMs)
        return
      }
      fnRef
        .current()
        .then((d) => {
          if (!alive) return
          setData(d)
          setError(null)
          setLoading(false)
          fails = 0
          loadedOnce = true
          schedule(intervalMs)
        })
        .catch((e) => {
          if (!alive) return
          setError(String(e.message ?? e))
          setLoading(false)
          fails++
          // Before the FIRST successful load (e.g. a brief backend warmup window
          // right after a deploy), retry quickly so the page doesn't sit blank —
          // a transient must not be amplified into a minute-long empty screen.
          // Once data has loaded at least once, back off on failures (cap 60s).
          schedule(loadedOnce ? Math.min(intervalMs * 2 ** Math.min(fails, 4), 60_000) : 3_000)
        })
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fails = 0
        schedule(0)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading }
}

// ── Shared SSE live transfer feed (single connection for the whole app) ───────
let liveBuffer: Transfer[] = []
const liveListeners = new Set<() => void>()
let es: EventSource | null = null

function ensureStream() {
  if (es || typeof window === 'undefined') return
  es = new EventSource(BASE + '/stream')
  es.onmessage = (ev) => {
    try {
      const t = JSON.parse(ev.data) as Transfer
      liveBuffer = [t, ...liveBuffer].slice(0, 300)
      liveListeners.forEach((l) => l())
    } catch {
      /* ignore */
    }
  }
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do
  }
}

// Seed the buffer once from REST so the feed isn't empty before the first SSE push
let seeded = false
function seedLive() {
  if (seeded) return
  seeded = true
  api
    .transfers({ limit: 100 })
    .then((rows) => {
      const have = new Set(liveBuffer.map((t) => t.tx_hash + t.direction))
      const merged = [...liveBuffer, ...rows.filter((r) => !have.has(r.tx_hash + r.direction))]
      liveBuffer = merged.sort((a, b) => b.ts - a.ts).slice(0, 300)
      liveListeners.forEach((l) => l())
    })
    .catch(() => {})
}

// The shared SSE stream carries every category; `category` filters the feed
// client-side so casino-facing surfaces never show exchange/whale transfers,
// while a raw multi-chain explorer can still request the full feed.
export function useLiveFeed(limit = 40, category?: string): Transfer[] {
  const [, force] = useState(0)
  useEffect(() => {
    ensureStream()
    seedLive()
    const l = () => force((n) => n + 1)
    liveListeners.add(l)
    return () => {
      liveListeners.delete(l)
    }
  }, [])
  const rows =
    category && category !== 'all' ? liveBuffer.filter((t) => t.category === category) : liveBuffer
  return rows.slice(0, limit)
}

// Count-up animation for hero numbers
export function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(target)
  const prev = useRef(target)
  const raf = useRef(0)
  useEffect(() => {
    // rAF is throttled/paused in hidden tabs — jump straight to the real value
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      prev.current = target
      setVal(target)
      return
    }
    const from = prev.current
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(from + (target - from) * eased)
      if (p < 1) raf.current = requestAnimationFrame(step)
      else prev.current = target
    }
    raf.current = requestAnimationFrame(step)
    // safety net: guarantee the final value even if rAF stalls
    const safety = setTimeout(() => {
      prev.current = target
      setVal(target)
    }, duration + 120)
    return () => {
      cancelAnimationFrame(raf.current)
      clearTimeout(safety)
    }
  }, [target, duration])
  return val
}
