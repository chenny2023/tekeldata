import { db } from '../db.ts'
import { webFetch } from '../net.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'

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
-- AI 分析按 app_id 持久化（app_watch 每 12h 快照覆盖，分析不能放里面，否则会被清掉）。
CREATE TABLE IF NOT EXISTS app_analysis (
  app_id      TEXT PRIMARY KEY,
  name        TEXT,
  summary     TEXT,   -- 这个 app 是做什么的（一句话）
  complaints  TEXT,   -- 差评主要集中在什么
  opportunity TEXT,   -- 潜在机会（尤其客服→hirecx / 投放→wonix）
  model       TEXT,
  analyzed_ts INTEGER
);
`)
try { db.exec('ALTER TABLE app_watch ADD COLUMN description TEXT') } catch { /* 列已存在 */ }
// 可复刻性（vibe coding 机会筛选）：1=逻辑不复杂、小团队+AI 编码可快速复刻；0=不适合。
for (const col of ['buildable INTEGER', 'app_type TEXT', 'build_reason TEXT', 'build_ts INTEGER']) {
  try { db.exec(`ALTER TABLE app_analysis ADD COLUMN ${col}`) } catch { /* 列已存在 */ }
}

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
  (id, store, country, chart, rank, app_id, name, publisher, genre, rating, rating_count, icon, url, description, updated_ts)
  VALUES (@id,@store,@country,@chart,@rank,@app_id,@name,@publisher,@genre,@rating,@rating_count,@icon,@url,@description,@now)`)

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
        icon: r.artworkUrl100 ?? r.artworkUrl60 ?? '', url: r.trackViewUrl ?? '',
        description: (r.description ?? '').slice(0, 1200), now,
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

// ── Google Play（ScrapingBee）────────────────────────────────────────────────
// Play 没有免费榜单接口 + 公开榜单页已下线。类目页(category/APPLICATION|GAME)默认渲染的就是
// 「Top free（下载榜）」标签页，含 app 包名 + 评分（aria "Rated X stars"），一次渲染即得排名+评分。
// 「Top grossing（畅销榜）」是标签页切换后才加载、DOM 混淆且不稳定 → Play 暂只做下载榜；畅销榜靠 App Store。
// ScrapingBee 抓 google.com 系需 custom_google=true（每次 20 credits），故国家数/频率保守、可配。
const SB_KEY = () => (process.env.scrapingbee || process.env.SCRAPINGBEE_API_KEY || '').trim()
export const playEnabled = () => !!SB_KEY()
// 与 App Store 对齐：默认用同一组目标国家（COUNTRIES()，10 国）；可用 SOCIAL_PLAY_COUNTRIES 单独覆盖。
const PLAY_COUNTRIES = () => process.env.SOCIAL_PLAY_COUNTRIES
  ? process.env.SOCIAL_PLAY_COUNTRIES.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
  : COUNTRIES()
const PLAY_CATEGORIES = () => (process.env.SOCIAL_PLAY_CATEGORIES || 'APPLICATION,GAME').split(',').map((c) => c.trim()).filter(Boolean)
const PLAY_LIMIT = () => Number(process.env.SOCIAL_PLAY_LIMIT) || 120

async function sbFetch(targetUrl: string): Promise<string | null> {
  const key = SB_KEY()
  if (!key) return null
  const u = new URL('https://app.scrapingbee.com/api/v1/')
  u.searchParams.set('api_key', key)
  u.searchParams.set('url', targetUrl)
  u.searchParams.set('custom_google', 'true') // google.com 系必须，20 credits/次
  u.searchParams.set('render_js', 'true')
  u.searchParams.set('timeout', '55000') // 让 ScrapingBee 端也多等（Play 渲染重，默认易超时）
  // Play 页重，渲染慢：重试一次，客户端超时给到 75s。
  for (let a = 0; a < 2; a++) {
    try {
      const r = await webFetch(u.toString(), { signal: AbortSignal.timeout(75_000) })
      if (r.ok) return await r.text()
      console.warn('[appwatch] scrapingbee HTTP', r.status)
      if (r.status !== 500 && r.status !== 504) return null // 非超时类错误不重试
    } catch (e) { console.warn('[appwatch] scrapingbee try', a + 1, 'failed:', (e as Error).message) }
    await sleep(1500)
  }
  return null
}

// 解析 Play 渲染后的 HTML：按出现顺序取每个 app 卡片的 包名 + 名称 + 评分（顺序=名次）。
function parsePlay(html: string): { app_id: string; name: string; rating: number; rank: number }[] {
  const ids = [...html.matchAll(/\/store\/apps\/details\?id=([\w.]+)/g)]
  const out: { app_id: string; name: string; rating: number; rank: number }[] = []
  const seen = new Set<string>()
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k][1]
    if (!id || seen.has(id)) continue
    const start = ids[k].index ?? 0
    const next = k + 1 < ids.length ? (ids[k + 1].index ?? start + 900) : start + 900
    const seg = html.slice(start, Math.min(next, start + 900))
    const rating = Number((seg.match(/Rated ([0-9.]+) star/i) || [])[1] || 0)
    const name = ((seg.match(/>([^<>]{1,60})<\/div>/) || [])[1] || '').trim()
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    seen.add(id)
    out.push({ app_id: id, name, rating, rank: seen.size })
  }
  return out
}

async function fetchPlayChart(cc: string, category: string): Promise<{ app_id: string; name: string; rating: number }[]> {
  const html = await sbFetch(`https://play.google.com/store/apps/category/${category}?hl=en&gl=${cc}`)
  if (!html) return []
  return parsePlay(html).slice(0, PLAY_LIMIT())
}

async function refreshOnePlay(cc: string): Promise<number> {
  const max = MAX_RATING()
  const all: { app_id: string; name: string; rating: number; genre: string }[] = []
  const seen = new Set<string>()
  for (const cat of PLAY_CATEGORIES()) {
    const list = await fetchPlayChart(cc, cat)
    for (const a of list) { if (seen.has(a.app_id)) continue; seen.add(a.app_id); all.push({ ...a, genre: cat === 'GAME' ? 'Game' : 'Application' }) }
    await sleep(800)
  }
  if (all.length === 0) return 0
  const now = Date.now()
  const rows = all
    .map((a, i) => ({ ...a, rank: i + 1 })) // 合并后的真实榜单位置（先 Application 后 Game，类内保序）
    .filter((a) => a.rating > 0 && a.rating < max) // 只留评分 < 3.5（Play 列表页不含评分数，故不卡 count）
    .map((a) => ({
      id: `googleplay_${cc}_free_${a.app_id}`, store: 'googleplay', country: cc, chart: 'free', rank: a.rank, app_id: a.app_id,
      name: (a.name || a.app_id).slice(0, 200), publisher: '', genre: a.genre, rating: a.rating, rating_count: 0,
      icon: '', url: `https://play.google.com/store/apps/details?id=${a.app_id}`, description: '', now,
    }))
  const tx = db.transaction(() => { delChart.run('googleplay', cc, 'free'); for (const row of rows) insApp.run(row) })
  for (let a = 0; a < 4; a++) { try { tx(); break } catch (e) { if (!/locked|busy/i.test((e as Error).message) || a === 3) throw e; await sleep(800 * (a + 1)) } }
  return rows.length
}

let playRunning = false
export async function refreshPlayWatch(): Promise<{ ok: boolean; kept: number }> {
  if (!playEnabled()) return { ok: false, kept: 0 }
  if (playRunning) return { ok: false, kept: 0 }
  playRunning = true
  let kept = 0
  try {
    for (const cc of PLAY_COUNTRIES()) {
      try { kept += await refreshOnePlay(cc) } catch (e) { console.warn(`[appwatch] play/${cc} failed:`, (e as Error).message) }
      await sleep(1000)
    }
    db.prepare('INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('playwatch_last_ts', String(Date.now()))
    console.log(`[appwatch] Google Play 刷新完成：留存 ${kept} 个低分高流量 app`)
  } finally { playRunning = false }
  return { ok: true, kept }
}

// 一次性采集：榜单变化慢，只在「从未采过」时全量爬一次，之后不再定时重爬（省 credit）。
// 需要更新时手动点「刷新榜单」(走 refreshPlayWatch)。强制重采：删 sync_state 的 playwatch_seeded。
export function startPlayWatch(): void {
  if ((process.env.APPWATCH_ENABLED ?? '1') === '0' || !playEnabled()) return
  if (db.prepare("SELECT 1 FROM sync_state WHERE key='playwatch_seeded'").get()) {
    console.log('[appwatch] Google Play 已采集过，跳过（如需更新点"刷新榜单"）'); return
  }
  console.log('[appwatch] Google Play：首次全量采集…')
  setTimeout(async () => {
    try {
      const r = await refreshPlayWatch()
      if (r.ok) db.prepare("INSERT INTO sync_state(key,value) VALUES('playwatch_seeded',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()))
    } catch (e) { console.warn('[appwatch] play seed failed:', (e as Error).message) }
  }, 30_000)
}

export interface AppWatchFilter { store?: string; country?: string; chart?: string; sort?: string; limit?: number; buildable?: boolean }
export function listAppWatch(f: AppWatchFilter): { items: any[]; countries: string[]; lastUpdated: number } {
  const where: string[] = ['w.store = ?']
  const params: any[] = [f.store || 'appstore']
  if (f.country) { where.push('w.country = ?'); params.push(f.country) }
  if (f.chart) { where.push('w.chart = ?'); params.push(f.chart) }
  if (f.buildable) where.push('a.buildable = 1') // 仅"可 vibe coding 复刻"的（已分类且判可复刻）
  const order =
    f.sort === 'rating' ? 'w.rating ASC, w.rank ASC' // 最差评分优先
    : f.sort === 'reviews' ? 'w.rating_count DESC' // 评分数最多（影响面最大）
    : 'w.rank ASC' // 默认：榜单名次（流量/营收最大）优先
  const items = db
    .prepare(`SELECT w.*, a.summary, a.complaints, a.opportunity, a.analyzed_ts, a.buildable, a.app_type, a.build_reason
      FROM app_watch w LEFT JOIN app_analysis a ON a.app_id = w.app_id
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .all(...params, Math.min(f.limit || 200, 500))
  const countries = (db.prepare("SELECT DISTINCT country FROM app_watch WHERE store=? ORDER BY country").all(f.store || 'appstore') as { country: string }[]).map((x) => x.country)
  const lastUpdated = Number((db.prepare("SELECT value FROM sync_state WHERE key='appwatch_last_ts'").get() as any)?.value || 0)
  return { items, countries, lastUpdated }
}

// ── AI 分析：这个 app 做什么 + 差评集中点 + 潜在机会 ──────────────────────────────
// 取该 app 在其所在国商店的差评(1-3★) + 商店简介 → LLM 归纳。分析按 app_id 持久化（跨刷新保留）。
async function fetchNegReviews(appid: string, cc: string, want = 15): Promise<string[]> {
  const out: string[] = []
  for (let page = 1; page <= 2 && out.length < want; page++) {
    try {
      const r = await webFetch(`https://itunes.apple.com/${cc}/rss/customerreviews/page=${page}/id=${appid}/sortby=mostrecent/json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      if (!r.ok) break
      const entries: any[] = ((await r.json()) as any)?.feed?.entry ?? []
      for (const e of entries) {
        const text = e?.content?.label
        const rating = Number(e?.['im:rating']?.label ?? 0)
        if (!text || !rating || rating > 3) continue // 只要差评(1-3★)
        out.push(((e?.title?.label ? e.title.label + '：' : '') + text).slice(0, 280))
        if (out.length >= want) break
      }
    } catch { break }
    await sleep(300)
  }
  return out
}

export async function analyzeApp(appId: string): Promise<{ ok: boolean; message: string; analysis?: any }> {
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置' }
  const row = db.prepare('SELECT app_id, name, country, genre, rating, description, store FROM app_watch WHERE app_id=? LIMIT 1').get(appId) as
    | { app_id: string; name: string; country: string; genre: string; rating: number; description: string; store: string } | undefined
  if (!row) return { ok: false, message: '未找到该 app' }
  // 差评样本只对 App Store 有效（iTunes RSS）；Google Play 的包名不是 iTunes track id，故跳过取评论。
  const reviews = row.store === 'appstore' ? await fetchNegReviews(appId, row.country || 'us') : []
  const system =
    '你是 App 市场分析师，服务一家做 ① AI 客服(hirecx，按消息计费、游戏/电商/SaaS 场景原生) ② 效果广告 AI 创意(wonix) 的公司。\n' +
    '给你一个「高流量但低评分」的 app（商店简介 + 差评样本），输出 JSON：\n' +
    '{"summary":"这个 app 是做什么的，一句话(中文)","complaints":"差评主要集中在什么，2-4 个要点，分号分隔(中文)","opportunity":"潜在机会，1-2 句(中文)——尤其：若差评集中在客服/响应/退款/答非所问→点出这是 hirecx 切入机会；若涉及获客/广告/转化→wonix 机会；否则给中立的产品/市场空白判断"}\n' +
    '只依据材料，别编造；差评样本少时也要尽量归纳，并可注明样本有限。'
  const user = `App：${row.name}（类别：${row.genre || '?'}，评分：${row.rating}，市场：${row.country}）\n商店简介：${row.description || '(无)'}\n差评样本(${reviews.length} 条)：\n${reviews.map((r) => '- ' + r).join('\n') || '(暂无差评样本)'}`
  const res = await generateContent(system, user)
  const d = (res?.data ?? {}) as { summary?: string; complaints?: string; opportunity?: string }
  if (!d.summary && !d.complaints && !d.opportunity) return { ok: false, message: 'AI 分析失败' }
  const now = Date.now()
  db.prepare(`INSERT INTO app_analysis(app_id, name, summary, complaints, opportunity, model, analyzed_ts)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET name=excluded.name, summary=excluded.summary, complaints=excluded.complaints, opportunity=excluded.opportunity, model=excluded.model, analyzed_ts=excluded.analyzed_ts`)
    .run(appId, row.name, (d.summary || '').slice(0, 400), (d.complaints || '').slice(0, 600), (d.opportunity || '').slice(0, 600), res?.model || '', now)
  const b = db.prepare('SELECT buildable, app_type, build_reason FROM app_analysis WHERE app_id=?').get(appId) as { buildable: number; app_type: string; build_reason: string } | undefined
  return { ok: true, message: '已生成分析', analysis: { summary: d.summary, complaints: d.complaints, opportunity: d.opportunity, analyzed_ts: now, buildable: b?.buildable, app_type: b?.app_type, build_reason: b?.build_reason } }
}

// 后台批量：优先分析「榜单名次靠前 + 还没分析过」的 app（量大，慢慢补）。
export async function analyzeAppsBatch(): Promise<number> {
  if (!openrouterEnabled()) return 0
  const n = Number(process.env.APPWATCH_ANALYZE_BATCH) || 3
  const rows = db.prepare(`SELECT DISTINCT w.app_id FROM app_watch w
    LEFT JOIN app_analysis a ON a.app_id = w.app_id
    WHERE a.app_id IS NULL ORDER BY w.rank ASC LIMIT ?`).all(n) as { app_id: string }[]
  let done = 0
  for (const r of rows) {
    try { const x = await analyzeApp(r.app_id); if (x.ok) done++ } catch (e) { console.warn('[appwatch] analyze failed:', (e as Error).message) }
    await sleep(500)
  }
  if (done) console.log(`[appwatch] AI 分析 ${done} 个 app`)
  return done
}

// ── 可复刻性分类（vibe coding 机会筛选）──────────────────────────────────────────
// 只看 名称+类别+商店简介（不抓评论，快且广，覆盖全榜）。判断该 app 是否"小团队+AI 编码可快速复刻"，
// 排除政府/公共服务、重度研发(深科技/强监管基建/AAA/需大团队)。结果写 app_analysis（与差评分析共表）。
export async function classifyBuildabilityBatch(): Promise<number> {
  if (!openrouterEnabled()) return 0
  const n = Number(process.env.APPWATCH_BUILD_BATCH) || 15
  const rows = db.prepare(`SELECT DISTINCT w.app_id, w.name, w.genre, w.description FROM app_watch w
    LEFT JOIN app_analysis a ON a.app_id = w.app_id
    WHERE a.build_ts IS NULL ORDER BY w.rank ASC LIMIT ?`).all(n) as
    { app_id: string; name: string; genre: string; description: string }[]
  if (rows.length === 0) return 0
  const system =
    '你在帮一个用 AI 辅助编码(vibe coding)快速做产品的小团队筛选"可复刻"的 app 机会。\n' +
    '对每个 app 判断 buildable：\n' +
    'buildable=true：逻辑相对简单、小团队几周内 + AI 编码能做出可用版本（如：工具/效率、内容/资讯、清单/笔记、简单社交/社区、模板化电商、轻量小游戏、订阅打卡、AI 套壳应用等）。\n' +
    'buildable=false：① 政府/公共服务/政务/银行牌照/运营商类；② 重度研发——深科技(AI 训练/算法壁垒)、强监管金融基建、地图/导航大数据、AAA/大型 3D 游戏、硬件依赖、需大团队长期投入或海量内容/数据网络效应的。\n' +
    'type 用一个短词标注类别（如 工具/内容/社交/电商/游戏/金融/政府/出行/AI工具/教育/健康 等）。\n' +
    '只返回 JSON：{"items":[{"i":序号,"buildable":true/false,"type":"...","reason":"一句话中文理由"}]}'
  const user = rows.map((x, i) => `[${i}] ${x.name}（类别:${x.genre || '?'}）简介:${(x.description || '(无)').slice(0, 200)}`).join('\n').slice(0, 7000)
  const res = await generateContent(system, user)
  const items = (res?.data?.items ?? []) as { i: number; buildable: boolean; type: string; reason: string }[]
  if (!Array.isArray(items)) return 0
  const now = Date.now()
  const up = db.prepare(`INSERT INTO app_analysis(app_id, name, buildable, app_type, build_reason, build_ts)
    VALUES(?,?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET buildable=excluded.buildable, app_type=excluded.app_type, build_reason=excluded.build_reason, build_ts=excluded.build_ts`)
  let done = 0
  const seen = new Set<number>()
  const tx = db.transaction(() => {
    for (const it of items) {
      const row = rows[it.i]; if (!row) continue
      seen.add(it.i)
      up.run(row.app_id, row.name, it.buildable === true ? 1 : 0, (it.type || '').slice(0, 24), (it.reason || '').slice(0, 300), now)
      done++
    }
    // 未返回的也标记 build_ts，避免反复重试同一批（buildable 置 0/未知）
    rows.forEach((row, i) => { if (!seen.has(i)) up.run(row.app_id, row.name, 0, '', '', now) })
  })
  for (let a = 0; a < 4; a++) { try { tx(); break } catch (e) { if (!/locked|busy/i.test((e as Error).message) || a === 3) throw e; await sleep(800 * (a + 1)) } }
  if (done) console.log(`[appwatch] 可复刻性分类 ${done} 个 app`)
  return done
}

export function startBuildClassifier(): void {
  if ((process.env.APPWATCH_ENABLED ?? '1') === '0' || !openrouterEnabled()) return
  const loop = async () => {
    try { await classifyBuildabilityBatch() } catch (e) { console.warn('[appwatch] build-classify failed:', (e as Error).message) }
    setTimeout(loop, Number(process.env.APPWATCH_BUILD_MS) || 45_000)
  }
  setTimeout(loop, 150_000)
}

export function startAppAnalyzer(): void {
  if ((process.env.APPWATCH_ENABLED ?? '1') === '0' || !openrouterEnabled()) return
  const loop = async () => {
    try { await analyzeAppsBatch() } catch (e) { console.warn('[appwatch] analyzer failed:', (e as Error).message) }
    setTimeout(loop, Number(process.env.APPWATCH_ANALYZE_MS) || 90_000)
  }
  setTimeout(loop, 180_000) // 启动 3 分钟后开跑（等首刷有数据）
}

// 一次性采集：只在「从未采过」时全量爬一次 App Store，之后不再定时重爬。
// 需要更新时手动点「刷新榜单」(走 refreshAppWatch)。强制重采：删 sync_state 的 appwatch_seeded。
export function startAppWatch(): void {
  if ((process.env.APPWATCH_ENABLED ?? '1') === '0') return
  if (db.prepare("SELECT 1 FROM sync_state WHERE key='appwatch_seeded'").get()) {
    console.log('[appwatch] App Store 已采集过，跳过（如需更新点"刷新榜单"）'); return
  }
  console.log('[appwatch] 产品观察室：首次全量采集 App Store…')
  setTimeout(async () => {
    try {
      const r = await refreshAppWatch()
      if (r.ok) db.prepare("INSERT INTO sync_state(key,value) VALUES('appwatch_seeded',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()))
    } catch (e) { console.warn('[appwatch] seed failed:', (e as Error).message) }
  }, 120_000) // 启动 2 分钟后首采（让主服务先稳）
}
