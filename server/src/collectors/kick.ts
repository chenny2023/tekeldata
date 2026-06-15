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
  INSERT INTO streamers(id, handle, platform, viewers, live, title, game, thumbnail, followers, affiliation, updated_at)
  VALUES(@id, @handle, 'Kick', @viewers, @live, @title, @game, @thumbnail, @followers, @affiliation, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    viewers=excluded.viewers, live=excluded.live, title=excluded.title,
    game=excluded.game, thumbnail=excluded.thumbnail, followers=excluded.followers,
    affiliation=COALESCE(excluded.affiliation, streamers.affiliation),
    updated_at=excluded.updated_at
`)

export function seedRoster() {
  // top-up: new seeds reach existing installs too; INSERT OR IGNORE keeps
  // operator entries and prior deactivations (404'd slugs) untouched
  const now = Date.now()
  const ins = db.prepare(
    'INSERT OR IGNORE INTO streamer_roster(platform, slug, active, created_at) VALUES(?, ?, 1, ?)',
  )
  let added = 0
  for (const slug of ROSTER_SEED) added += ins.run('Kick', slug, now).changes
  if (added) console.log(`[kick] roster topped up with ${added} known casino streamers`)
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
