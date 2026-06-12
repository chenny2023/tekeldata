import { db, stateGet, stateSet } from '../db.ts'

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

// Well-known gambling-category Kick streamers (public channels).
const ROSTER_SEED = ['roshtein', 'trainwreckstv', 'classybeef', 'xposed', 'ayezee', 'deuceace']

// Common casino brands for affiliation matching (extended at runtime with
// watchlist casino labels).
const CASINO_BRANDS = [
  'stake', 'gamdom', 'roobet', 'rollbit', 'duelbits', 'shuffle', 'bc.game',
  'metaspins', 'csgoempire', 'hypedrop', 'packdraw', '1xbet', 'bitsler', 'chips.gg',
]

const upsert = db.prepare(`
  INSERT INTO streamers(id, handle, platform, viewers, live, title, game, thumbnail, followers, affiliation, updated_at)
  VALUES(@id, @handle, 'Kick', @viewers, @live, @title, @game, @thumbnail, @followers, @affiliation, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    viewers=excluded.viewers, live=excluded.live, title=excluded.title,
    game=excluded.game, thumbnail=excluded.thumbnail, followers=excluded.followers,
    affiliation=COALESCE(excluded.affiliation, streamers.affiliation),
    updated_at=excluded.updated_at
`)

export function seedRoster() {
  const count = (db.prepare("SELECT COUNT(*) n FROM streamer_roster WHERE platform='Kick'").get() as any).n
  if (count > 0) return
  const now = Date.now()
  const ins = db.prepare(
    'INSERT OR IGNORE INTO streamer_roster(platform, slug, active, created_at) VALUES(?, ?, 1, ?)',
  )
  for (const slug of ROSTER_SEED) ins.run('Kick', slug, now)
  console.log(`[kick] roster seeded with ${ROSTER_SEED.length} known casino streamers`)
}

function detectAffiliation(...texts: (string | null | undefined)[]): string | null {
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  // watchlist casino labels first (operator's own intelligence), then brands
  const labels = db
    .prepare("SELECT DISTINCT label FROM watchlist WHERE category='casino' AND active=1")
    .all() as { label: string }[]
  for (const { label } of labels) {
    const key = label.toLowerCase().replace(/\.(com|io|gg|game)$/, '')
    if (key.length >= 4 && hay.includes(key)) return label
  }
  for (const brand of CASINO_BRANDS) {
    if (hay.includes(brand)) return brand.charAt(0).toUpperCase() + brand.slice(1)
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
    const res = await fetch(KICK_API + entry.slug, {
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
    upsert.run({
      id: 'kick:' + d.slug,
      handle: d.user?.username ?? d.slug,
      viewers: ls?.viewer_count ?? 0,
      live: ls ? 1 : 0,
      title,
      game: ls?.categories?.[0]?.name ?? null,
      thumbnail: ls?.thumbnail?.url ?? d.user?.profile_pic ?? null,
      followers: d.followers_count ?? 0,
      affiliation: detectAffiliation(title, d.user?.bio),
      updated_at: Date.now(),
    })
    if (ls) console.log(`[kick] ${d.slug}: LIVE ${ls.viewer_count} viewers`)
  } catch (e) {
    console.warn(`[kick] ${entry.slug} failed:`, (e as Error).message)
  }
}

export function startKick() {
  seedRoster()
  const loop = async () => {
    await runKickOnce()
    setTimeout(loop, 8_000) // one channel per 8s — polite, full roster sweep ≈ 1 min
  }
  loop()
}
