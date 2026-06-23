import { db } from '../db.ts'
import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 产品观察室：监测全球主要市场 App Store 榜单里「流量/营收大但口碑差」的 app。
//   - 下载榜(topfree)  = 下载量大
//   - 畅销榜(topgrossing) = 营收高
// 对每国每榜取 top200 → 批量 lookup 评分 → 只留「评分 < 3.5」的，按榜单排名排序。
// 这类 app = 高流量却口碑差 = 机会标的（产品/客服体验差，适合 hirecx 切入 + 市场情报）。
//
// 数据源：iTunes 公开 RSS 榜单 + lookup 评分接口，全免费、无 key。Google Play 二期（无免费榜单接口）。
// 快照式刷新：每次按 (store,country,chart) 整体替换。后台定时跑（榜单变化慢，默认 12h）。
// ─────────────────────────────────────────────────────────────────────────────

db.pragma('busy_timeout = 30000') // 与部署交接锁共存（模块级建表在 main() 抬高超时前就跑）

db.exec(`
CREATE TABLE IF NOT EXISTS app_watch (
  id           TEXT PRIMARY KEY,        -- store_country_chart_appid
  store        TEXT NOT NULL,           -- appstore（二期：googleplay）
  country      TEXT NOT NULL,           -- us/gb/jp...
  chart        TEXT NOT NULL,           -- free（下载榜）| grossing（畅销榜）
  rank         INTEGER NOT NULL,        -- 榜单名次 1..200（流量/营收代理）
  app_id       TEXT NOT NULL,
  name         TEXT,
  publisher    TEXT,
  genre        TEXT,
  rating       REAL,                    -- 该国商店平均评分
  rating_count INTEGER,
  icon         TEXT,
  url          TEXT,
  updated_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aw_view ON app_watch(store, country, chart, rank);
`)

const MAX_RATING = () => Number(process.env.APPWATCH_MAX_RATING) || 3.5
const MIN_RATINGS = () => Number(process.env.APPWATCH_MIN_RATING_COUNT) || 10
const COUNTRIES = () => (process.env.APPWATCH_COUNTRIES || 'us,gb,jp,kr,de,fr,br,in,id,mx').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
const CHARTS: [string, string][] = [
  ['topfreeapplications', 'free'],
  ['topgrossingapplications', 'grossing'],
]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 拉某国某榜的 top N（appid + 名次 + 名称）
async function fetchChart(cc: string, feed: string, limit: number): Promise<{ appid: string; rank: number; name: string }[]> {
  try {
    const r = await webFetch(`https://itunes.apple.com/${cc}/rss/${feed}/limit=${limit}/json`, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return []
    const j = (await r.json()) as any
    const entry: any[] = j?.feed?.entry ?? []
    return entry
      .map((e, i) => ({ appid: String(e?.id?.attributes?.['im:id'] ?? ''), rank: i + 1, name: e?.['im:name']?.label ?? '' }))
      .filter((x) => x.appid)
  } catch {
    return []
  }
}

// 批量 lookup 评分（按国，每批 ≤100 个 id）
async function lookupRatings(ids: string[], cc: string): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const r = await webFetch(`https://itunes.apple.com/lookup?id=${chunk.join(',')}&country=${cc}`, { signal: AbortSignal.timeout(25_000) })
      if (!r.ok) continue
      const j = (await r.json()) as any
      for (const res of j?.results ?? []) out.set(String(res.trackId), res)
    } catch { /* skip chunk */ }
    await sleep(400)
  }
  return out
}

const delChart = db.prepare('DELETE FROM app_watch WHERE store=? AND country=? AND chart=?')
const insApp = db.prepare(`INSERT OR REPLACE INTO app_watch
  (id, store, country, chart, rank, app_id, name, publisher, genre, rating, rating_count, icon, url, updated_ts)
  VALUES (@id,@store,@country,@chart,@rank,@app_id,@name,@publisher,@genre,@rating,@rating_count,@icon,@url,@now)`)

async function refreshOne(cc: string, feed: string, chart: string): Promise<number> {
  const list = await fetchChart(cc, feed, 200)
  if (list.length === 0) return 0
  const ratings = await lookupRatings(list.map((x) => x.appid), cc)
  const now = Date.now()
  const max = MAX_RATING()
  const minN = MIN_RATINGS()
  const rows = list
    .map((x) => {
      const r = ratings.get(x.appid)
      if (!r) return null
      const rating = Number(r.averageUserRating ?? 0)
      const count = Number(r.userRatingCount ?? 0)
      if (!(rating > 0 && rating < max && count >= minN)) return null // 只留：有评分 且 <3.5 且 评分数够
      return {
        id: `appstore_${cc}_${chart}_${x.appid}`, store: 'appstore', country: cc, chart, rank: x.rank, app_id: x.appid,
        name: (r.trackName ?? x.name ?? '').slice(0, 200), publisher: (r.artistName ?? '').slice(0, 160),
        genre: r.primaryGenreName ?? '', rating, rating_count: count,
        icon: r.artworkUrl100 ?? r.artworkUrl60 ?? '', url: r.trackViewUrl ?? '', now,
      }
    })
    .filter(Boolean) as any[]
  const tx = db.transaction(() => {
    delChart.run('appstore', cc, chart)
    for (const row of rows) insApp.run(row)
  })
  for (let a = 0; a < 4; a++) { try { tx(); break } catch (e) { if (!/locked|busy/i.test((e as Error).message) || a === 3) throw e; await sleep(800 * (a + 1)) } }
  return rows.length
}

let running = false
export async function refreshAppWatch(): Promise<{ ok: boolean; kept: number }> {
  if (running) return { ok: false, kept: 0 }
  running = true
  let kept = 0
  try {
    for (const cc of COUNTRIES()) {
      for (const [feed, chart] of CHARTS) {
        try { kept += await refreshOne(cc, feed, chart) } catch (e) { console.warn(`[appwatch] ${cc}/${chart} failed:`, (e as Error).message) }
        await sleep(600)
      }
    }
    db.prepare('INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('appwatch_last_ts', String(Date.now()))
    console.log(`[appwatch] 刷新完成：留存 ${kept} 个低分高流量 app`)
  } finally {
    running = false
  }
  return { ok: true, kept }
}

export interface AppWatchFilter { store?: string; country?: string; chart?: string; sort?: string; limit?: number }
export function listAppWatch(f: AppWatchFilter): { items: any[]; countries: string[]; lastUpdated: number } {
  const where: string[] = []
  const params: any[] = []
  where.push('store = ?'); params.push(f.store || 'appstore')
  if (f.country) { where.push('country = ?'); params.push(f.country) }
  if (f.chart) { where.push('chart = ?'); params.push(f.chart) }
  const order =
    f.sort === 'rating' ? 'rating ASC, rank ASC' // 最差评分优先
    : f.sort === 'reviews' ? 'rating_count DESC' // 评分数最多（影响面最大）
    : 'rank ASC' // 默认：榜单名次（流量/营收最大）优先
  const items = db
    .prepare(`SELECT * FROM app_watch WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .all(...params, Math.min(f.limit || 200, 500))
  const countries = (db.prepare("SELECT DISTINCT country FROM app_watch WHERE store=? ORDER BY country").all(f.store || 'appstore') as { country: string }[]).map((x) => x.country)
  const lastUpdated = Number((db.prepare("SELECT value FROM sync_state WHERE key='appwatch_last_ts'").get() as any)?.value || 0)
  return { items, countries, lastUpdated }
}

export function startAppWatch(): void {
  if ((process.env.APPWATCH_ENABLED ?? '1') === '0') return
  console.log('[appwatch] 产品观察室已启动（App Store 低分高流量榜，10 大市场）')
  const loop = async () => {
    try { await refreshAppWatch() } catch (e) { console.warn('[appwatch] refresh failed:', (e as Error).message) }
    setTimeout(loop, Number(process.env.APPWATCH_REFRESH_MS) || 12 * 3600_000)
  }
  setTimeout(loop, 120_000) // 启动 2 分钟后首刷（让主服务先稳）
}
