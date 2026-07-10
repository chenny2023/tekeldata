import { FastifyInstance } from 'fastify'
import { db, stateGet, stateSet } from './db.ts'

// IndexNow — instantly notify Bing, Yandex, Seznam (and, increasingly, Google) when
// our public pages change, so the now-open data gets discovered in hours instead of
// waiting for an organic crawl. Key is a PUBLIC verification token (not a secret),
// hosted at /<key>.txt; override via INDEXNOW_KEY if rotating.
const KEY =
  (process.env.INDEXNOW_KEY || 'a3f1c9e7b2d84f60a1e5c3b7d9f2a6e4').toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 64) ||
  'a3f1c9e7b2d84f60a1e5c3b7d9f2a6e4'
const HOST = 'tekeldata.com'
const SITE = 'https://' + HOST
const PING_INTERVAL = 6 * 3600_000 // re-submit the full indexable set at most every 6h

export function registerIndexNow(app: FastifyInstance) {
  // ownership-proof key file the search engines fetch to verify submissions
  app.get(`/${KEY}.txt`, async (_req, reply) => reply.type('text/plain; charset=utf-8').send(KEY))
}

// Submit every indexable page to IndexNow. Throttled so a 30-min SEO rebuild doesn't
// spam the endpoint; new pages are still picked up within the interval.
export async function pingIndexNow(): Promise<void> {
  try {
    const last = Number(stateGet('indexnow:lastPing') ?? 0)
    if (Date.now() - last < PING_INTERVAL) return
    const rows = db
      .prepare("SELECT path FROM seo_page WHERE lifecycle IN ('public_indexable','featured_core')")
      .all() as { path: string }[]
    const urlList = ['/', '/daily', ...rows.map((r) => r.path)].map((p) => SITE + p)
    if (urlList.length < 2) return
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList }),
      signal: AbortSignal.timeout(20_000),
    })
    stateSet('indexnow:lastPing', Date.now())
    console.log(`[indexnow] submitted ${urlList.length} URLs → HTTP ${res.status}`)
  } catch (e) {
    console.warn('[indexnow] ping failed:', (e as Error).message)
  }
}
