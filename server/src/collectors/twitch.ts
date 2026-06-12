import { config } from '../config.ts'
import { db } from '../db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// REAL streamer monitoring via the Twitch Helix API. This is OPTIONAL: it only
// runs if TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET are set in .env. With no
// credentials the streamers table simply stays empty and the UI says so — we do
// not fabricate viewer counts.
//
// We track the "Slots" / casino category on Twitch (the same surface circus.fyi
// monitors) and store the live top channels.
// ─────────────────────────────────────────────────────────────────────────────

export const twitchEnabled = () => !!(config.twitchClientId && config.twitchClientSecret)

let token = ''
let tokenExp = 0

async function appToken(): Promise<string> {
  if (token && Date.now() < tokenExp) return token
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.twitchClientId,
      client_secret: config.twitchClientSecret,
      grant_type: 'client_credentials',
    }),
  })
  const json = await res.json()
  token = json.access_token
  tokenExp = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000
  return token
}

async function helix(path: string): Promise<any> {
  const t = await appToken()
  const res = await fetch('https://api.twitch.tv/helix' + path, {
    headers: { 'Client-Id': config.twitchClientId, Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Twitch HTTP ${res.status}`)
  return res.json()
}

const upsert = db.prepare(`
  INSERT INTO streamers(id, handle, platform, viewers, live, title, game, thumbnail, updated_at)
  VALUES(@id, @handle, 'Twitch', @viewers, 1, @title, @game, @thumbnail, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    viewers=excluded.viewers, live=1, title=excluded.title,
    thumbnail=excluded.thumbnail, updated_at=excluded.updated_at
`)

export async function runTwitchOnce() {
  if (!twitchEnabled()) return
  try {
    // "Slots" category id on Twitch is 498566
    const streams = await helix('/streams?game_id=498566&first=40')
    const now = Date.now()
    const tx = db.transaction(() => {
      db.prepare('UPDATE streamers SET live = 0').run()
      for (const s of streams.data ?? []) {
        upsert.run({
          id: s.id,
          handle: s.user_name,
          viewers: s.viewer_count,
          title: s.title,
          game: s.game_name,
          thumbnail: (s.thumbnail_url ?? '').replace('{width}', '320').replace('{height}', '180'),
          updated_at: now,
        })
      }
    })
    tx()
    console.log(`[twitch] updated ${streams.data?.length ?? 0} live slots streamers`)
  } catch (e) {
    console.warn('[twitch] failed:', (e as Error).message)
  }
}

export function startTwitch() {
  if (!twitchEnabled()) {
    console.log('[twitch] disabled (no TWITCH_CLIENT_ID/SECRET) — streamer feed will be empty')
    return
  }
  const loop = async () => {
    await runTwitchOnce()
    setTimeout(loop, 60_000)
  }
  loop()
}
