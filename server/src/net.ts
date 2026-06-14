import { fetch as undiciFetch, ProxyAgent } from 'undici'

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

function pickAgent(): ProxyAgent | undefined {
  return agents.length ? agents[Math.floor(Math.random() * agents.length)] : undefined
}

// Only route the sites that actually IP-block datacenter ranges through the
// proxy pool — proxying every open-web call (Kick, Google News, label dumps…)
// just saturates the proxies and times out the calls that truly need them.
// Override the list with PROXY_HOSTS (comma-separated host substrings).
const proxyHosts = (process.env.PROXY_HOSTS || 'casino.guru,archive.org,trustpilot.com,casino.org,reddit.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
function needsProxy(url: string): boolean {
  if (agents.length === 0) return false
  const u = url.toLowerCase()
  return proxyHosts.some((h) => u.includes(h))
}

type FetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>

export function webFetch(url: string, init: FetchInit = {}) {
  return undiciFetch(url, { ...init, dispatcher: needsProxy(url) ? pickAgent() : undefined })
}
