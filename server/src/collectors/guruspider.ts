import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db } from '../db.ts'
import { webFetch } from '../net.ts'
import { seedDirectory } from '../directory.ts'

// ─────────────────────────────────────────────────────────────────────────────
// casino.guru spider — the scale engine behind the Casino Directory.
// casino.guru has no reachable master list (Cloudflare 404s our probes), so we
// crawl organically: seed the queue with roster slugs, fetch each review page
// through the proxy pool, pull the casino's real website out of the page's
// JSON-LD, and harvest every other "*-casino-review" slug on the page into the
// queue. That fans out to thousands of casinos with no master list needed.
// One page per tick, paced — it shares casino.guru with the reviews collector.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const enqueue = db.prepare('INSERT INTO crawl_queue(slug, found_at) VALUES(?, ?) ON CONFLICT(slug) DO NOTHING')
const pickPending = db.prepare('SELECT slug FROM crawl_queue WHERE done=0 ORDER BY found_at ASC LIMIT 1')
const markDone = db.prepare('UPDATE crawl_queue SET done=? WHERE slug=?')
const queueStats = db.prepare(
  'SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN done=0 THEN 1 ELSE 0 END),0) pending, COALESCE(SUM(CASE WHEN done=1 THEN 1 ELSE 0 END),0) fetched FROM crawl_queue',
)

function slugCandidates(name: string): string[] {
  const base = name.toLowerCase().trim()
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const plain = base.replace(/[^a-z0-9]+/g, '')
  return [...new Set([hyphen, plain])].filter(Boolean)
}

// Domains that are never a casino's own site (socials, casino.guru itself, CDNs).
const NON_SITE = /(casino\.guru|googletagmanager|google|gstatic|facebook|twitter|x\.com|instagram|youtube|linkedin|telegram|t\.me|cloudflare|gravatar|w3\.org|schema\.org|jsdelivr|cookiebot|trustpilot|sentry)/i

// Pull the casino's real website out of the review page's JSON-LD. The Review's
// itemReviewed (the casino as an Organization) carries the official url / sameAs.
function extractFromJsonLd(html: string): { name: string; website: string | null } | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j: any
    try {
      j = JSON.parse(m[1])
    } catch {
      continue
    }
    const nodes = Array.isArray(j) ? j : j['@graph'] && Array.isArray(j['@graph']) ? j['@graph'] : [j]
    for (const node of nodes) {
      const reviewed = node?.itemReviewed ?? (node?.['@type'] === 'Organization' ? node : null)
      if (!reviewed) continue
      const name = String(reviewed.name ?? node.name ?? '').trim()
      if (!name) continue
      const cands: string[] = []
      if (typeof reviewed.url === 'string') cands.push(reviewed.url)
      if (typeof reviewed.sameAs === 'string') cands.push(reviewed.sameAs)
      if (Array.isArray(reviewed.sameAs)) cands.push(...reviewed.sameAs)
      const website = cands.find((u) => typeof u === 'string' && /^https?:\/\//.test(u) && !NON_SITE.test(u)) ?? null
      return { name, website }
    }
  }
  return null
}

// Fallback: casino.guru shows the casino's domain as visible text near the top
// ("Casino website" / "Visit STAKE.COM"). Grab the first plausible external host.
function extractDomainFallback(html: string, name: string): string | null {
  const head = html.slice(0, 60_000).replace(/<[^>]+>/g, ' ')
  const tokens = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
  for (const m of head.matchAll(/\b([a-z0-9-]{2,30}\.(?:com|net|io|bet|casino|games?|app|co|vip|win|club|cc|ag|eu|me|life))\b/gi)) {
    const host = m[1].toLowerCase()
    if (NON_SITE.test(host)) continue
    const core = host.split('.')[0].replace(/[^a-z0-9]+/g, '')
    // accept when the domain core overlaps the casino name (avoids picking a stray domain)
    if (tokens.length >= 3 && (core.includes(tokens.slice(0, 4)) || tokens.includes(core.slice(0, 4)))) return 'https://' + host
  }
  return null
}

const RELATED = /\/([a-z0-9][a-z0-9-]{1,40})-casino-review\b/g

async function crawlOne(): Promise<void> {
  const row = pickPending.get() as { slug: string } | undefined
  if (!row) return
  const slug = row.slug
  let html = ''
  try {
    const res = await webFetch(`https://casino.guru/${slug}-casino-review`, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) {
      markDone.run(2, slug)
      return
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } catch (e) {
    // transient (slow/dead proxy) — leave pending for a later tick on a fresh proxy
    console.warn(`[guru-spider] ${slug}: ${(e as Error).message.slice(0, 40)} (retry later)`)
    return
  }

  // harvest related slugs first — discovery must continue even if this one yields no site
  let fresh = 0
  const now = Date.now()
  const seen = new Set<string>()
  for (const m of html.matchAll(RELATED)) {
    const s = m[1]
    if (s === slug || seen.has(s)) continue
    seen.add(s)
    fresh += enqueue.run(s, now).changes
  }

  const info = extractFromJsonLd(html)
  let recorded = false
  if (info) {
    const website = info.website ?? extractDomainFallback(html, info.name)
    if (website) {
      seedDirectory([{ name: info.name, website, source: 'casino.guru' }])
      recorded = true
    }
  }
  markDone.run(info || html.length > 1000 ? 1 : 2, slug)
  console.log(`[guru-spider] ${slug}: ${recorded ? `✓ ${info!.name}` : 'no-site'} · +${fresh} slugs queued`)
}

function seedQueue() {
  try {
    const path = fileURLToPath(new URL('../data/casino-roster.json', import.meta.url))
    const roster = JSON.parse(readFileSync(path, 'utf8')) as any[]
    const now = Date.now()
    let n = 0
    const tx = db.transaction(() => {
      for (const c of roster) for (const s of slugCandidates(String(c.name ?? ''))) n += enqueue.run(s, now).changes
    })
    tx()
    if (n) console.log(`[guru-spider] seeded ${n} slugs from roster`)
  } catch (e) {
    console.warn('[guru-spider] queue seed failed:', (e as Error).message)
  }
}

export function startGuruSpider() {
  if ((process.env.GURU_SPIDER ?? '1') === '0') return
  console.log('[guru-spider] casino.guru directory spider active')
  seedQueue()
  let iter = 0
  const loop = async () => {
    await crawlOne().catch((e) => console.warn('[guru-spider]', (e as Error).message))
    if (++iter % 10 === 0) {
      const s = queueStats.get() as any
      console.log(`[guru-spider] queue: ${s.fetched} fetched · ${s.pending} pending · ${s.total} total`)
    }
    setTimeout(loop, 25_000) // gentle — shares casino.guru + the proxy pool with the reviews collector
  }
  setTimeout(loop, 120_000) // start well after boot, behind the reviews collector
}
