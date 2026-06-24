import { webFetch, webFetchUnlocked } from '../net.ts'
import { db } from '../db.ts'
import { seedRoster, detectAffiliation } from './streamerutil.ts'

// ─────────────────────────────────────────────────────────────────────────────
// YouTube iGaming channel monitoring — KEYLESS (no Data API). We fetch each
// roster channel's public page and parse subscriber count, live status, name and
// avatar out of the embedded data. YouTube serves channel pages to everyone, so
// we fetch direct; if that ever gets blocked we fall back to the unlocker.
// Unknown handles (no og:title) deactivate themselves. Nothing fabricated.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// casino/slots YouTube channels (handles, no leading @)
const ROSTER_SEED = [
  'Roshtein', 'CasinoDaddy', 'LetsGiveItASpin', 'NickSlots', 'MrGambleSlots', 'HideousSlots',
  'TheBanditSlots', 'SpinTwix', 'Jarttu84', 'StopandStep', 'ClassyBeef', 'FruitySlots',
  'SlotSpinner', 'Vondy', 'JackpotMike', 'Daskino', 'CasinoGrounds', 'OnlineGamblingChannel',
  'SlotLady', 'BrianChristopherSlots', 'TheBigPayback', 'Slotsfighter',
  // wave 2
  'NGSlots', 'KimSlots', 'RawSlots', 'CasinoNinja', 'SlotHunters', 'BigwinBoard',
  'MrBigSpin', 'TheReelStory', 'SlotMojo', 'DeuceAce', 'Xposed', 'CasinoGuru',
  'AskGamblers', 'SlotLadyVegas', 'TheSlotCats', 'AllSlotsTV', 'GamblingRomania',
  'CasinoTest247', 'OnlineCasinoGuide', 'SDGuy1234', 'VegasLowRoller', 'NgSlotsTooMuch',
  'Watchgamestv', 'KingJafi', 'SpinGang', 'TheBigJackpot',
]

const upsert = db.prepare(`
  INSERT INTO streamers(id, handle, platform, viewers, live, title, game, thumbnail, followers, affiliation, updated_at)
  VALUES(@id, @handle, 'YouTube', @viewers, @live, @title, @game, @thumbnail, @followers, @affiliation, @now)
  ON CONFLICT(id) DO UPDATE SET
    viewers=excluded.viewers, live=excluded.live, title=excluded.title,
    thumbnail=excluded.thumbnail, followers=excluded.followers,
    affiliation=COALESCE(excluded.affiliation, streamers.affiliation), updated_at=excluded.updated_at
`)

function parseSubs(html: string): number | null {
  // older layout renders the count as visible text ("1.2M subscribers"); newer
  // layouts only embed it in ytInitialData JSON (subscriberCountText.simpleText or
  // metadataParts content) — try the text form first, then the JSON form, so
  // channels that stopped exposing the visible string don't fall to "? subs".
  const m =
    html.match(/([\d.,]+)\s*([KMB]?)\s*subscribers/i) ??
    html.match(/"(?:simpleText|content)":"([\d.,]+)\s*([KMB]?)\s*subscribers"/i)
  if (!m) return null
  let n = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const mult = m[2].toUpperCase()
  if (mult === 'K') n *= 1e3
  else if (mult === 'M') n *= 1e6
  else if (mult === 'B') n *= 1e9
  return Math.round(n)
}
function meta(html: string, prop: string): string | null {
  return html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1] ?? null
}

let rr = 0

export async function runYouTubeOnce(): Promise<void> {
  const roster = db.prepare("SELECT id, slug FROM streamer_roster WHERE platform='YouTube' AND active=1").all() as { id: number; slug: string }[]
  if (roster.length === 0) return
  const entry = roster[rr++ % roster.length]
  const url = `https://www.youtube.com/@${entry.slug}`
  try {
    const init = { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(30_000) }
    let res = await webFetch(url, init)
    if (res.status === 403 || res.status === 429) {
      const un = webFetchUnlocked(url, init) // blocked direct → try the paid unlocker
      if (un) res = await un
    }
    if (res.status === 404) {
      db.prepare('UPDATE streamer_roster SET active=0 WHERE id=?').run(entry.id)
      console.warn(`[youtube] @${entry.slug}: 404 — deactivated`)
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const name = meta(html, 'og:title')
    if (!name) {
      db.prepare('UPDATE streamer_roster SET active=0 WHERE id=?').run(entry.id)
      console.warn(`[youtube] @${entry.slug}: no channel data — deactivated`)
      return
    }
    const live = /BADGE_STYLE_TYPE_LIVE_NOW|"text":"LIVE"|"label":"LIVE"/.test(html) ? 1 : 0
    const subs = parseSubs(html)
    upsert.run({
      id: 'youtube:' + entry.slug,
      handle: name,
      viewers: 0, // channel page doesn't reliably expose live viewer count
      live,
      title: live ? meta(html, 'og:description')?.slice(0, 200) ?? null : null,
      game: null,
      thumbnail: meta(html, 'og:image'),
      followers: subs ?? 0,
      affiliation: detectAffiliation(name, meta(html, 'og:description')),
      now: Date.now(),
    })
    console.log(`[youtube] @${entry.slug}: ${subs ? (subs / 1e6).toFixed(2) + 'M' : '?'} subs${live ? ' · LIVE' : ''}`)
  } catch (e) {
    console.warn(`[youtube] @${entry.slug} failed:`, (e as Error).message)
  }
}

export function startYouTube() {
  if ((process.env.YOUTUBE_ENABLED ?? '1') === '0') return
  seedRoster('YouTube', ROSTER_SEED)
  console.log('[youtube] iGaming channel collector active')
  const loop = async () => {
    await runYouTubeOnce()
    setTimeout(loop, 20_000) // one channel per 20s — subs change slowly, no rush
  }
  setTimeout(loop, 50_000)
}
