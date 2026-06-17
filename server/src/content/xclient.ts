import crypto from 'crypto'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// X (Twitter) client — OAuth 1.0a user-context signing for posting tweets,
// threads and media. Disabled (returns null) until the four OAuth 1.0a secrets
// are set, so the pipeline runs in dry-run (generate + QA, no publish) without them.
// ─────────────────────────────────────────────────────────────────────────────

const env = process.env
const KEY = () => env.X_API_KEY ?? ''
const SECRET = () => env.X_API_SECRET ?? ''
const TOKEN = () => env.X_ACCESS_TOKEN ?? ''
const TOKEN_SECRET = () => env.X_ACCESS_TOKEN_SECRET ?? ''
export const xEnabled = () => !!(KEY() && SECRET() && TOKEN() && TOKEN_SECRET())

const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// Build the OAuth 1.0a Authorization header. `extra` holds query/form params that
// must be signed (empty for a JSON-body request — the body is not signed there).
function authHeader(method: string, url: string, extra: Record<string, string> = {}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: KEY(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: TOKEN(),
    oauth_version: '1.0',
  }
  const all = { ...oauth, ...extra }
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(all[k])}`)
    .join('&')
  const baseString = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&')
  const signingKey = `${rfc3986(SECRET())}&${rfc3986(TOKEN_SECRET())}`
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64')
  return (
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`)
      .join(', ')
  )
}

// Post a tweet (v2). Optionally reply to a tweet (threads) and/or attach media.
// Returns { id, url } or throws.
export async function postTweet(text: string, opts: { replyTo?: string; mediaIds?: string[] } = {}): Promise<{ id: string; url: string }> {
  const url = 'https://api.twitter.com/2/tweets'
  const body: any = { text }
  if (opts.replyTo) body.reply = { in_reply_to_tweet_id: opts.replyTo }
  if (opts.mediaIds?.length) body.media = { media_ids: opts.mediaIds }
  const res = await webFetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', url), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const j = (await res.json()) as any
  if (!res.ok || !j?.data?.id) throw new Error(`X post failed: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`)
  const id = j.data.id
  return { id, url: `https://x.com/${env.X_ACCOUNT_ID || 'i'}/status/${id}` }
}

// Upload an image (v1.1 media/upload, simple). Returns media_id_string.
export async function uploadMedia(bytes: Buffer, mime = 'image/png'): Promise<string> {
  const url = 'https://upload.twitter.com/1.1/media/upload.json'
  const form = new FormData()
  form.append('media', new Blob([bytes], { type: mime }))
  const res = await webFetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', url) }, // multipart body is not signed
    body: form as any,
    signal: AbortSignal.timeout(60_000),
  })
  const j = (await res.json()) as any
  if (!res.ok || !j?.media_id_string) throw new Error(`X media upload failed: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.media_id_string
}

// Publish a thread: first tweet, then each subsequent as a reply to the previous.
// Returns the root tweet URL.
export async function postThread(tweets: string[], firstMediaIds?: string[]): Promise<{ rootUrl: string; ids: string[] }> {
  const ids: string[] = []
  let replyTo: string | undefined
  let rootUrl = ''
  for (let i = 0; i < tweets.length; i++) {
    const r = await postTweet(tweets[i], { replyTo, mediaIds: i === 0 ? firstMediaIds : undefined })
    ids.push(r.id)
    replyTo = r.id
    if (i === 0) rootUrl = r.url
    await new Promise((res) => setTimeout(res, 1500)) // gentle pacing between thread tweets
  }
  return { rootUrl, ids }
}
