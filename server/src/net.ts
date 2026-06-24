import { fetch as undiciFetch, request as undiciRequest, ProxyAgent } from 'undici'

// ─────────────────────────────────────────────────────────────────────────────
// Proxy-aware fetch for collectors that talk to the open web (review sites,
// social, label dumps). Many of these (casino.guru/Cloudflare, archive.org)
// block datacenter IPs like Railway's, so we route each request through a RANDOM
// upstream proxy (rotation spreads load so no single IP gets rate-limited).
//
// Proxy sources, in order:
//   1. WEBSHARE_API_KEY  — pull the live list from the Webshare API (auto-updates,
//      handles rotation; only a short key to configure — no giant list to paste)
//   2. PROXY_POOL        — comma-separated proxy URLs (http://user:pass@host:port)
//   3. HTTP(S)_PROXY     — a single proxy
//   4. direct
// Chain RPCs keep using the global fetch (latency-sensitive, reachable directly).
// ─────────────────────────────────────────────────────────────────────────────

let agents: ProxyAgent[] = []

function buildAgents(urls: string[]): ProxyAgent[] {
  const out: ProxyAgent[] = []
  for (const u of urls) {
    try {
      // undici defaults to a 10s connect timeout, which Railway -> Webshare proxy
      // CONNECT tunnels routinely blow through (datacenter-to-datacenter hop under
      // a busy event loop), surfacing as an opaque "fetch failed". Give the tunnel
      // and the slow ~600KB upstream pages room so transient slowness isn't a hard
      // failure.
      out.push(
        new ProxyAgent({
          uri: u,
          connect: { timeout: 30_000 },
          headersTimeout: 35_000,
          bodyTimeout: 45_000,
        }),
      )
    } catch (e) {
      console.warn(`[net] skipping invalid proxy url: ${(e as Error).message}`)
    }
  }
  return out
}

// ── 2-3: static pool from env (synchronous, available immediately) ────────────
const poolRaw =
  process.env.PROXY_POOL ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ''
const staticUrls = poolRaw
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^https?:\/\/.+/.test(s)) // ignore junk; a malformed value must NOT crash boot
agents = buildAgents(staticUrls)
if (agents.length) console.log(`[net] ${agents.length} static prox${agents.length > 1 ? 'ies' : 'y'} configured`)

// ── 1: Webshare API (async, refreshed; overrides the static pool when present) ─
async function loadWebshare(): Promise<void> {
  const key = process.env.WEBSHARE_API_KEY
  if (!key) return
  try {
    const res = await undiciFetch(
      'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100',
      { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(20_000) },
    )
    if (!res.ok) {
      console.warn(`[net] Webshare API HTTP ${res.status} — keeping current proxies`)
      return
    }
    const j = (await res.json()) as {
      results?: { username: string; password: string; proxy_address: string; port: number; valid?: boolean }[]
    }
    const urls = (j.results ?? [])
      .filter((p) => p.valid !== false && p.proxy_address && p.port)
      .map((p) => `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`)
    const built = buildAgents(urls)
    if (built.length) {
      agents = built // live list wins
      console.log(`[net] web collectors routing via ${built.length} Webshare proxies`)
    } else {
      console.warn('[net] Webshare returned no usable proxies')
    }
  } catch (e) {
    console.warn('[net] Webshare load failed:', (e as Error).message)
  }
}
if (process.env.WEBSHARE_API_KEY) {
  loadWebshare()
  setInterval(() => void loadWebshare(), 6 * 3600_000) // refresh 4×/day
}

function pick(pool: ProxyAgent[]): ProxyAgent | undefined {
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined
}

// ── Residential pool — for hosts that block DATACENTER IPs outright ────────────
// Reddit (and a few others) 403/tarpit every datacenter IP, including the
// Webshare datacenter proxies, so the normal pool can't reach them. A residential
// proxy (e.g. Webshare's residential plan) presents a home/mobile IP that these
// sites accept. Configure REDDIT_PROXY with one or more residential proxy URLs
// (comma-separated http://user:pass@host:port); reddit.com then routes through it
// instead of the datacenter pool. Without it, reddit.com goes direct (and 403s).
// Two residential exits are configured (REDDIT_PROXY + PROXY); pool both so the
// load of all the blocked collectors is spread across both home IPs.
const residentialAgents = buildAgents(
  [process.env.REDDIT_PROXY, process.env.PROXY, process.env.RESIDENTIAL_PROXY]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/.+/.test(s)),
)
if (residentialAgents.length) console.log(`[net] ${residentialAgents.length} residential prox${residentialAgents.length > 1 ? 'ies' : 'y'} for all IP-blocked collection`)
// All the hosts that block datacenter IPs route through the residential proxy:
// Reddit, Bluesky and GDELT each maintain their OWN blocklist, so a residential
// IP that one rejects may well be fine for the others — worth trying all via the
// residential exit rather than the (failing) datacenter pool.
const residentialHosts = (process.env.RESIDENTIAL_HOSTS || 'reddit.com,bsky.app,gdeltproject.org,trustpilot.com,gql.twitch.tv,syndication.twitter.com,pullpush.io')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

// Only route the sites that actually IP-block datacenter ranges through the
// proxy pool — proxying every open-web call (Kick, Google News, label dumps…)
// just saturates the proxies and times out the calls that truly need them.
// Override the list with PROXY_HOSTS (comma-separated host substrings).
const proxyHosts = (process.env.PROXY_HOSTS || 'casino.guru,archive.org,casino.org,bitcointalk.org')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

// Every blocked host (Reddit/Bluesky/GDELT + the Cloudflare-walled review sites
// casino.guru/trustpilot/casino.org/bitcointalk/archive.org) now routes through
// the RESIDENTIAL pool — datacenter IPs get blocked, so we no longer use them for
// collection. The datacenter pool stays only as a last-resort fallback if no
// residential proxy is configured. Non-blocked hosts go direct.
function dispatcherFor(url: string): ProxyAgent | undefined {
  const u = url.toLowerCase()
  const blocked = residentialHosts.some((h) => u.includes(h)) || proxyHosts.some((h) => u.includes(h))
  if (!blocked) return undefined
  return pick(residentialAgents) ?? pick(agents)
}

type FetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>

export function webFetch(url: string, init: FetchInit = {}) {
  return undiciFetch(url, { ...init, dispatcher: dispatcherFor(url) })
}

// Force a DIRECT fetch (no proxy), ignoring the residential routing. Some public
// read APIs (e.g. Bluesky's public AppView) are reachable from datacenter and the
// residential hop only adds 403s/timeouts — try direct first, residential as fallback.
export function webFetchDirect(url: string, init: FetchInit = {}) {
  return undiciFetch(url, init)
}

// Force a proxy for ANY url (the casino-directory crawler hits thousands of
// arbitrary casino domains, many Cloudflare-walled). Routes through the
// RESIDENTIAL pool (datacenter IPs get blocked), datacenter only as a fallback.
export function webFetchProxied(url: string, init: FetchInit = {}) {
  return undiciFetch(url, { ...init, dispatcher: pick(residentialAgents) ?? pick(agents) })
}

// Paid "web unlocker" channel for sites that block even residential IPs at the
// fingerprint level (Trustpilot — 403/tarpit regardless of IP). ScraperAPI-style
// URL API: we hand it the target and it returns the unlocked HTML, doing the
// anti-bot/Cloudflare bypass + its own residential rotation + optional JS render.
// Set SCRAPER_API_KEY to enable; SCRAPER_RENDER=1 to force JS rendering. Returns
// null when unconfigured so callers fall back to the normal residential path.
// Works with any ScraperAPI-compatible endpoint via SCRAPER_API_ENDPOINT
// (default https://api.scraperapi.com/), e.g. ScrapingBee with the same shape.
// Circuit breaker: ScraperAPI replies 403 once the monthly request quota is
// exhausted, so without a breaker we'd keep firing (and burning the already-over
// quota) on every collector cycle while every call 403s. On a 403 we open the
// breaker for a cooldown and return null — callers fall back to their residential/
// Wayback path (or skip). The next call after the cooldown probes again, so it
// self-closes when the quota resets.
let unlockerOpenUntil = 0
const UNLOCKER_BACKOFF_MS = 2 * 3600_000
export function unlockerTripped(): boolean {
  return Date.now() < unlockerOpenUntil
}
export function webFetchUnlocked(targetUrl: string, init: FetchInit = {}, extra = ''): Promise<Response> | null {
  const key = process.env.SCRAPER_API_KEY
  if (!key) return null
  if (Date.now() < unlockerOpenUntil) return null // breaker open (quota exhausted) → fall back / skip
  const endpoint = process.env.SCRAPER_API_ENDPOINT || 'https://api.scraperapi.com/'
  const api = `${endpoint}?api_key=${key}&url=${encodeURIComponent(targetUrl)}${extra}`
  // direct from Railway → the unlocker API (it does the proxying); no local dispatcher
  return undiciFetch(api, init).then((res) => {
    if (res.status === 403) unlockerOpenUntil = Date.now() + UNLOCKER_BACKOFF_MS // quota exhausted
    return res
  })
}

// Arkham Intelligence API — on-chain entity attribution (maps addresses ↔ named
// entities like "Stake.com"). Key in env `arkham`. Auth header is configurable
// (ARKHAM_AUTH_HEADER, default "API-Key") since their docs/SDKs vary. Returns null
// when unconfigured. Direct fetch (Arkham's API is reachable from Railway).
export function arkhamFetch(path: string, init: FetchInit = {}): Promise<Response> | null {
  const key = process.env.arkham || process.env.ARKHAM_API_KEY
  if (!key) return null
  const base = process.env.ARKHAM_API_BASE || 'https://api.arkhamintelligence.com'
  const header = process.env.ARKHAM_AUTH_HEADER || 'API-Key'
  const url = base + (path.startsWith('/') ? path : '/' + path)
  return undiciFetch(url, { ...init, headers: { [header]: key, Accept: 'application/json', ...((init as any).headers || {}) } })
}

// Tronscan API — keyed access (env `tronscanapi`) lifts the rate limit and unlocks
// account/transfer lookups used to classify Tron services (exchange vs casino).
// Reachable direct from Railway (outside the GFW). Returns null when unconfigured.
export function tronscanFetch(path: string, init: FetchInit = {}): Promise<Response> | null {
  const key = process.env.tronscanapi || process.env.TRONSCAN_API_KEY
  const base = 'https://apilist.tronscanapi.com'
  const url = base + (path.startsWith('/') ? path : '/' + path)
  const headers: Record<string, string> = { Accept: 'application/json', ...((init as any).headers || {}) }
  if (key) headers['TRON-PRO-API-KEY'] = key
  return undiciFetch(url, { ...init, headers })
}

// Classify a Tron address by its AUTHORITATIVE Tronscan tag (blueTag = verified).
// Tronscan reliably tags exchanges (not casinos), so this is used to EXCLUDE
// exchanges from the casino-pattern pool — never to positively name a casino.
const EXCH_TAG_RE = /binance|okx|okex|huobi|htx|bybit|kraken|coinbase|kucoin|gate|bitfinex|mexc|bitget|crypto\.com|upbit|bithumb|poloniex|whitebit|bingx|lbank|xt\.com|exchange|deposit|hot ?wallet|cold ?wallet/i
export async function tronscanAccountKind(
  address: string,
): Promise<{ kind: 'exchange' | 'tagged-other' | 'untagged'; tag: string } | null> {
  const res = tronscanFetch(`/api/accountv2?address=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15_000) })
  if (!res) return null
  try {
    const r = await res
    if (r.status !== 200) return null
    const j = (await r.json()) as any
    const tag = [j.blueTag, j.greyTag, j.name].filter(Boolean).join(' ').trim()
    if (!tag) return { kind: 'untagged', tag: '' }
    return { kind: EXCH_TAG_RE.test(tag) ? 'exchange' : 'tagged-other', tag }
  } catch {
    return null
  }
}

// Read the Location of a single redirect hop WITHOUT following it. fetch's
// redirect:'manual' yields an opaqueredirect (status 0, no headers) so the
// Location is unreadable — undici's low-level request with maxRedirections:0
// returns the 3xx headers directly. Used to recover the real casino domain from
// casino.guru's /exit?casinoId=N redirect. Routes through the same proxy policy.
export async function resolveRedirect(url: string, timeoutMs = 20_000): Promise<string | null> {
  const { headers, body } = await undiciRequest(url, {
    dispatcher: dispatcherFor(url),
    method: 'GET',
    maxRedirections: 0,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  await body.dump() // drain so the socket is released back to the pool
  const loc = headers['location']
  return typeof loc === 'string' ? loc : Array.isArray(loc) ? loc[0] : null
}
