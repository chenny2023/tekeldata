import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promises as dns } from 'node:dns'
import { db } from './db.ts'
import { webFetchProxied } from './net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Casino directory crawler. Builds a broad, vetted catalogue of casinos for
// future partnership outreach. Tiered inclusion (the chosen policy): EVERY casino
// is recorded; per site we flag whether it (1) loads, (2) exposes an X account,
// (3) has a real MX-valid email. Seeded from our roster first; the casino.guru
// full-list scraper widens it to thousands. Sites are fetched through the proxy
// pool because many Cloudflare-wall datacenter IPs. Paced — a full sweep of
// thousands takes a while, which is expected.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function domainOf(url: string): string | null {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '').toLowerCase() || null
  } catch {
    return null
  }
}

const upsertSeed = db.prepare(`
  INSERT INTO casino_directory(domain, name, website, source, created_at)
  VALUES(@domain, @name, @website, @source, @now)
  ON CONFLICT(domain) DO NOTHING
`)

export function seedDirectory(rows: { name: string; website: string; source: string }[]): number {
  const now = Date.now()
  let n = 0
  const tx = db.transaction(() => {
    for (const c of rows) {
      const domain = domainOf(c.website)
      if (!domain) continue
      n += upsertSeed.run({ domain, name: c.name || domain, website: c.website, source: c.source, now }).changes
    }
  })
  tx()
  return n
}

function seedFromRoster() {
  try {
    const path = fileURLToPath(new URL('./data/casino-roster.json', import.meta.url))
    const roster = JSON.parse(readFileSync(path, 'utf8')) as any[]
    const n = seedDirectory(
      roster
        .map((c) => ({ name: c.name as string, website: (c.website_url || c.website) as string, source: 'roster' }))
        .filter((c) => c.website),
    )
    if (n) console.log(`[directory] seeded ${n} casinos from roster`)
  } catch (e) {
    console.warn('[directory] roster seed failed:', (e as Error).message)
  }
}

// ── per-site extraction ───────────────────────────────────────────────────────
const BAD_HANDLE = new Set(['intent', 'share', 'home', 'hashtag', 'search', 'privacy', 'tos', 'about', 'login', 'explore', 'i', 'help', 'status', 'settings'])
function extractTwitter(html: string): string | null {
  for (const m of html.matchAll(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{2,15})(?=["'/?\s<])/g)) {
    const h = m[1]
    if (!BAD_HANDLE.has(h.toLowerCase())) return h
  }
  return null
}
function emailRank(e: string): number {
  return /^(support|contact|info|hello|partners?|affiliate|affiliates|business|press|media|marketing)@/.test(e) ? 2 : 1
}
function extractEmail(html: string): string | null {
  const found = new Set<string>()
  for (const m of html.matchAll(/mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) found.add(m[1].toLowerCase())
  for (const m of html.matchAll(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,8})\b/g)) found.add(m[1].toLowerCase())
  const arr = [...found].filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/example\.|sentry|wixpress|@sentry|\.png|domain\.com|email\.com|yourdomain/.test(e))
  arr.sort((a, b) => emailRank(b) - emailRank(a))
  return arr[0] ?? null
}
async function emailDeliverable(email: string): Promise<boolean> {
  const dom = email.split('@')[1]
  if (!dom) return false
  try {
    const mx = await dns.resolveMx(dom)
    return Array.isArray(mx) && mx.length > 0
  } catch {
    return false
  }
}

const pickNext = db.prepare('SELECT domain, website FROM casino_directory ORDER BY last_checked ASC LIMIT 1')
const updateRow = db.prepare(`
  UPDATE casino_directory SET twitter=@twitter, email=@email, site_ok=@site_ok, x_ok=@x_ok,
    email_ok=@email_ok, status=@status, last_checked=@now WHERE domain=@domain
`)

export async function verifyOne() {
  const row = pickNext.get() as { domain: string; website: string } | undefined
  if (!row) return
  let site_ok = 0
  let x_ok = 0
  let email_ok = 0
  let twitter: string | null = null
  let email: string | null = null
  let status = ''
  try {
    const url = row.website.startsWith('http') ? row.website : 'https://' + row.website
    const res = await webFetchProxied(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20_000) })
    status = `http ${res.status}`
    if (res.ok) {
      const html = (await res.text()).slice(0, 500_000)
      if (html.length > 600 && !/domain (is )?for sale|this domain is parked|buy this domain/i.test(html.slice(0, 4000))) {
        site_ok = 1
        status = 'ok'
        twitter = extractTwitter(html)
        x_ok = twitter ? 1 : 0
        email = extractEmail(html)
        if (email) email_ok = (await emailDeliverable(email)) ? 1 : 0
      } else {
        status = 'parked/empty'
      }
    }
  } catch (e) {
    status = (e as Error).message.replace(/\s+/g, ' ').slice(0, 50)
  }
  updateRow.run({ domain: row.domain, twitter, email, site_ok, x_ok, email_ok, status, now: Date.now() })
  if (site_ok) console.log(`[directory] ${row.domain}: site✓ ${x_ok ? 'X✓' : 'X✗'} ${email_ok ? 'email✓' : 'email✗'}${email ? ' ' + email : ''}`)
}

export function startDirectory() {
  if ((process.env.DIRECTORY_ENABLED ?? '1') === '0') return
  console.log('[directory] casino-directory crawler active')
  seedFromRoster()
  const loop = async () => {
    await verifyOne().catch((e) => console.warn('[directory]', (e as Error).message))
    setTimeout(loop, 8_000) // one site per 8s through the proxy pool — gentle, sweeps fill over time
  }
  setTimeout(loop, 60_000)
}
