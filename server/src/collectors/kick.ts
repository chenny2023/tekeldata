import { db, stateGet, stateSet } from '../db.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// REAL streamer monitoring via Kick's public channel API (keyless).
//
// A roster of channels (seeded with well-known casino/slots streamers, operator-
// extensible via POST /api/roster) is polled round-robin. For each channel we
// store genuine live status, viewer count, follower count and stream title from
// Kick's own API — and derive casino affiliation by matching the stream title /
// bio against watchlist labels and known casino brands. 404s deactivate the
// roster entry; nothing is fabricated.
// ─────────────────────────────────────────────────────────────────────────────

const KICK_API = 'https://kick.com/api/v2/channels/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) wcoin-analytics/1.0'

// Well-known gambling-category Kick streamers (public channels). Unknown or
// renamed slugs 404 on first poll and deactivate themselves.
const ROSTER_SEED = [
  'roshtein', 'trainwreckstv', 'classybeef', 'xposed', 'ayezee', 'deuceace',
  'xqc', 'adinross', 'cuffem', 'watchgamestv', 'bbjess', 'cheesur',
  'mvdoom', 'casinodaddy', 'slotspinner', 'letsgiveitaspin', 'fruityslots',
  // expanded iGaming roster — wrong/renamed slugs 404 and self-deactivate
  'vondy', 'spintwix', 'jackpotmike', 'nickslots', 'mrgambleslots', 'hideousslots',
  'daskino', 'slotsfighter', 'davidlabowski', 'frankietv', 'scuffedjesse', 'kingjafi',
  'bdh', 'mhmdtv', 'm0xy', 'bobbynetwork', 'eddie', 'n3on', 'stake', 'yassuo',
  'westcol', 'eliasn97', 'knossi', 'montanablack', 'rebeu', 'agente', 'gambleboyz',
  'casinotest247', 'slotmonster', 'hugequads', 'thebandit',
  // wave 2 — more gambling/slots channels
  'ohnepixel', 'jukes', 'konvy', 'billyclips', 'drinkky', 'kyzia', 'jasontheween',
  'suspendas', 'gambit', 'p2isten', 'foltyn', 'casinodaddyleon', 'casinodaddymattias',
  'slotmojo', 'craz', 'mexify', 'twpclips', 'roshtein2', 'sapioo', 'jagbir',
  'mrshmoo', 'thomas', 'rincon', 'dinoo', 'pamsmellz', 'tutkulu', 'slotrocket',
  'spingang', 'bossmanjack', 'staysolidrocky', 'kevinsfm', 'wanted', 'gabepeixe',
  'rdcworld', 'jynxzi', 'lacy', 'mando', 'amped', 'ricegum',
]

// Common casino brands for affiliation matching (extended at runtime with
// watchlist casino labels).
const CASINO_BRANDS = [
  'stake', 'gamdom', 'roobet', 'rollbit', 'duelbits', 'shuffle', 'bc.game',
  'metaspins', 'csgoempire', 'hypedrop', 'packdraw', '1xbet', 'bitsler', 'chips.gg',
]

const upsert = db.prepare(`
  INSERT INTO streamers(id, handle, platform, viewers, live, title, game, thumbnail, followers, affiliation, bio, socials, verified, updated_at)
  VALUES(@id, @handle, 'Kick', @viewers, @live, @title, @game, @thumbnail, @followers, @affiliation, @bio, @socials, @verified, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    viewers=excluded.viewers, live=excluded.live, title=excluded.title,
    game=excluded.game, thumbnail=excluded.thumbnail, followers=excluded.followers,
    affiliation=COALESCE(excluded.affiliation, streamers.affiliation),
    bio=COALESCE(excluded.bio, streamers.bio),
    socials=COALESCE(excluded.socials, streamers.socials),
    verified=excluded.verified,
    updated_at=excluded.updated_at
`)

// Build a {network: handle} JSON blob from the platform's own social fields,
// dropping empties. Returns null when nothing is set so COALESCE keeps prior data.
function socialsJson(obj: Record<string, unknown>): string | null {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s) out[k] = s
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

export function seedRoster() {
  // top-up: new seeds reach existing installs too; INSERT OR IGNORE keeps
  // operator entries and prior deactivations (404'd slugs) untouched
  //
  // Best-effort: this runs during the boot rush, when the indexers' bulk inserts and
  // litestream's checkpoint contend for the write lock, so `database is locked` here
  // is transient and expected. It must NOT propagate — on 2026-08-01 it escaped
  // startKick() and truncated the whole boot sequence (see the `boot()` helper in
  // server.ts). The roster is a top-up of a persisted table: skipping one pass costs
  // nothing, and the next boot (or a manual seed) fills it in.
  try {
    const now = Date.now()
    const ins = db.prepare(
      'INSERT OR IGNORE INTO streamer_roster(platform, slug, active, created_at) VALUES(?, ?, 1, ?)',
    )
    let added = 0
    for (const slug of ROSTER_SEED) added += ins.run('Kick', slug, now).changes
    if (added) console.log(`[kick] roster topped up with ${added} known casino streamers`)
  } catch (e) {
    console.warn('[kick] roster seed skipped:', (e as Error).message)
  }
}

function detectAffiliation(...texts: (string | null | undefined)[]): string | null {
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  // watchlist casino labels first (operator's own intelligence), then brands
  const labels = db
    .prepare("SELECT DISTINCT label FROM watchlist WHERE category='casino' AND active=1")
    .all() as { label: string }[]
  // word-boundary match so a brand like "stake" doesn't false-match "mistake"
  const wb = (s: string) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)
  for (const { label } of labels) {
    const key = label.toLowerCase().replace(/\.(com|io|gg|game)$/, '')
    if (key.length >= 4 && wb(key)) return label
  }
  for (const brand of CASINO_BRANDS) {
    if (wb(brand)) return brand.charAt(0).toUpperCase() + brand.slice(1)
  }
  return null
}

let rr = 0
export async function runKickOnce(): Promise<void> {
  const roster = db
    .prepare("SELECT id, slug FROM streamer_roster WHERE platform='Kick' AND active=1")
    .all() as { id: number; slug: string }[]
  if (roster.length === 0) return
  const entry = roster[rr % roster.length]
  rr++

  try {
    const res = await webFetch(KICK_API + entry.slug, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404) {
      db.prepare('UPDATE streamer_roster SET active=0 WHERE id=?').run(entry.id)
      console.warn(`[kick] ${entry.slug}: 404 — deactivated`)
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const ls = d.livestream
    const title: string | null = ls?.session_title ?? null
    const u = d.user ?? {}
    const bio: string | null = typeof u.bio === 'string' && u.bio.trim() ? u.bio.trim().slice(0, 400) : null
    const socials = socialsJson({
      twitter: u.twitter,
      instagram: u.instagram,
      youtube: u.youtube,
      tiktok: u.tiktok,
      discord: u.discord,
      facebook: u.facebook,
    })
    upsert.run({
      id: 'kick:' + d.slug,
      handle: u.username ?? d.slug,
      viewers: ls?.viewer_count ?? 0,
      live: ls ? 1 : 0,
      title,
      game: ls?.categories?.[0]?.name ?? null,
      thumbnail: ls?.thumbnail?.url ?? u.profile_pic ?? null,
      followers: d.followers_count ?? 0,
      affiliation: detectAffiliation(title, bio),
      bio,
      socials,
      verified: d.verified ? 1 : 0,
      updated_at: Date.now(),
    })
    if (ls) console.log(`[kick] ${d.slug}: LIVE ${ls.viewer_count} viewers`)
  } catch (e) {
    console.warn(`[kick] ${entry.slug} failed:`, (e as Error).message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kick discovery — auto-grow the Kick roster with live gambling channels.
//
// Kick's own category-filtered livestreams endpoint is no longer publicly
// reachable (the legacy /stream/livestreams/<cat> path ignores the category and
// the v2 category paths 404). circus.fyi exposes a working "Slots & Casino"
// (category id 28) livestreams feed, so we use it as a DISCOVERY SEED only: we
// take the channel slugs and poll each one against Kick's OWN public API in
// runKickOnce — the live status, viewers, followers and affiliation we store are
// all re-fetched and verified from Kick directly, never copied from circus. Bad
// slugs 404 and self-deactivate. Override the source via KICK_DISCOVER_URL; set
// to '0' to disable.
// ─────────────────────────────────────────────────────────────────────────────
const KICK_DISCOVER_URL = process.env.KICK_DISCOVER_URL ?? 'https://www.circus.fyi/api/kick/livestreams'

export async function runKickDiscovery(): Promise<void> {
  if (KICK_DISCOVER_URL === '0') return
  try {
    const res = await webFetch(KICK_DISCOVER_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.circus.fyi/streamers' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return
    const rows = ((await res.json()) as any)?.data ?? []
    const slugs = (rows as any[]).map((r) => String(r?.slug ?? '').trim().toLowerCase()).filter((s) => /^[a-z0-9_]{2,32}$/.test(s))
    if (slugs.length) {
      const now = Date.now()
      const ins = db.prepare('INSERT OR IGNORE INTO streamer_roster(platform, slug, active, created_at) VALUES(?, ?, 1, ?)')
      let added = 0
      const tx = db.transaction(() => {
        for (const s of slugs) added += ins.run('Kick', s, now).changes
      })
      tx()
      if (added) console.log(`[kick] discovered ${added} new live gambling channels (of ${slugs.length} seen)`)
    }
  } catch {
    /* transient — Kick data is still re-verified per-channel in runKickOnce */
  }
}

export function startKick() {
  seedRoster()
  const loop = async () => {
    await runKickOnce()
    setTimeout(loop, 8_000) // one channel per 8s — polite, full roster sweep ≈ 1 min
  }
  loop()
  // discovery: seed the roster from the live gambling category, then refresh every
  // 5 min so newly-live casino streamers get picked up continuously
  setTimeout(() => {
    runKickDiscovery()
    setInterval(runKickDiscovery, 300_000)
  }, 30_000)
}
