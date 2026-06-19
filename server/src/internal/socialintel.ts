import { db } from '../db.ts'
import { webFetch, webFetchProxied, webFetchUnlocked } from '../net.ts'
import { unlockedFetch } from '../collectors/unlocker.ts'
import { score as lexScore } from '../sentiment.ts'
import { PRODUCTS } from './products.ts'
import { maybeAlert, type AlertSignal } from './alerts.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 内部社媒情报采集器（团队内部）。复用 wcoin 现有的住宅代理 (net.ts) 与无 key 采集范式。
//
//   Reddit  — search.rss 公开搜索，对每个产品的 brand/competitor/demand 关键词逐个搜，
//             命中写入 social_intel（与赌场 mentions 表完全隔离）。这是主力来源。
//   X       — syndication 时间线，监听配置的竞品/自有账号（X 已关闭无 key 全站搜索）。
//   Threads — 二期（无公开 API）。
//
// 每条信号附带：sentiment（词典情绪）+ intent（0..1 选型/求推荐意图分），
// 高 intent 的 demand 贴 = 可以评论推荐自有产品的机会。草稿生成在 drafts.ts。
// ─────────────────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// 只采近 N 个月（默认 180 天）。有真实发帖时间的源据此过滤；论坛/文章站无时间戳(ts=now)默认放行。
const RECENT_DAYS = Number(process.env.SOCIAL_RECENT_DAYS) || 180
const recentCutoff = () => Date.now() - RECENT_DAYS * 86_400_000

// ── schema：独立建表，不污染 casino 的 db.ts ──────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS social_intel (
  id           TEXT PRIMARY KEY,        -- platform_postid
  product      TEXT NOT NULL,           -- 自有产品 key（wcoin/hirecx/wonix）
  platform     TEXT NOT NULL,           -- reddit | x | threads
  kind         TEXT NOT NULL,           -- brand | competitor | demand
  query        TEXT,                    -- 命中的关键词/账号
  author       TEXT,
  title        TEXT,
  body         TEXT,
  url          TEXT,
  score        INTEGER NOT NULL DEFAULT 0,  -- 平台互动量
  sentiment    REAL NOT NULL DEFAULT 0,     -- 词典情绪 -1..1
  intent       REAL NOT NULL DEFAULT 0,     -- 选型/求推荐意图 0..1
  ts           INTEGER NOT NULL,            -- 发帖时间
  collected_ts INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new'  -- new | reviewed | ignored
);
CREATE INDEX IF NOT EXISTS idx_si_product ON social_intel(product, kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_si_intent  ON social_intel(intent DESC, ts DESC);

CREATE TABLE IF NOT EXISTS social_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   TEXT NOT NULL,
  product     TEXT NOT NULL,
  draft       TEXT NOT NULL,
  rationale   TEXT,                       -- AI 为何认为相关/如何措辞
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | posted | dismissed
  created_ts  INTEGER NOT NULL,
  updated_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sd_sig ON social_drafts(signal_id);
CREATE INDEX IF NOT EXISTS idx_sd_status ON social_drafts(status, created_ts DESC);

-- 自定义采集需求：面板里临时填写的查询(关键词/账号)，可即时跑一次，也可保存后随
-- 调度定时跑。active=1 的会被 buildJobs() 纳入轮询。product 仅作标签(可填任意自有产品)。
CREATE TABLE IF NOT EXISTS social_custom_query (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT,
  product     TEXT NOT NULL DEFAULT 'custom',
  platform    TEXT NOT NULL DEFAULT 'reddit',  -- reddit | x
  kind        TEXT NOT NULL DEFAULT 'demand',  -- brand | competitor | demand
  query       TEXT NOT NULL,
  subreddits  TEXT,                            -- csv（仅 reddit）
  active      INTEGER NOT NULL DEFAULT 1,
  last_run_ts INTEGER,
  created_ts  INTEGER NOT NULL
);

-- B. 需求聚类→选题建议：AI 把近期需求贴归纳成的内容/SEO 选题，按产品存档。
CREATE TABLE IF NOT EXISTS social_topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product     TEXT NOT NULL,
  topic       TEXT NOT NULL,         -- 选题标题
  question    TEXT,                  -- 反复出现的用户问题
  angle       TEXT,                  -- 建议的文章切入角度
  keyword     TEXT,                  -- 目标关键词
  demand_count INTEGER DEFAULT 0,    -- 支撑该选题的需求贴数
  model       TEXT,
  created_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_st_product ON social_topics(product, created_ts DESC);

-- C. 黄金一小时提醒：已发过提醒的高意图机会贴，去重用。
CREATE TABLE IF NOT EXISTS social_alert_sent (
  signal_id TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL
);
`)

// 迁移：social_intel 增补列（zh 中文解读 + spec 分类字段）。ALTER 不支持 IF NOT EXISTS，按 pragma 加。
{
  const cols = (db.prepare('PRAGMA table_info(social_intel)').all() as { name: string }[]).map((c) => c.name)
  const add = (name: string, type: string) => { if (!cols.includes(name)) db.exec(`ALTER TABLE social_intel ADD COLUMN ${name} ${type}`) }
  add('zh', 'TEXT')
  add('actor_type', 'TEXT')     // operator | affiliate | media_buyer | player | industry | noise
  add('intent_tier', 'TEXT')    // hot | warm | cold
  add('pain_type', 'TEXT')      // 按产品枚举（见 classify.ts）
  add('solvable', 'INTEGER')    // 仅 wonix：1 可解 / 0 不可解 / null 未判
  add('reco_play', 'TEXT')      // public_reply | dm | diagnostic | content | discard
  add('confidence', 'REAL')     // 分类置信度 0..1
  add('classified_ts', 'INTEGER') // 已分类时间（NULL=待分类，分类器据此挑活）
}
db.exec('CREATE INDEX IF NOT EXISTS idx_si_classified ON social_intel(classified_ts, intent DESC)')

const insertSignal = db.prepare(`
  INSERT OR IGNORE INTO social_intel
    (id, product, platform, kind, query, author, title, body, url, score, sentiment, intent, ts, collected_ts)
  VALUES
    (@id, @product, @platform, @kind, @query, @author, @title, @body, @url, @score, @sentiment, @intent, @ts, @collected_ts)
`)

// ── intent 评分：用户表达"选型/求推荐/找替代"的程度（0..1）──────────────────
// 这些短语命中越多 → 越可能是可以评论推荐自有产品的机会贴。
const INTENT_PHRASES = [
  // 英文
  'looking for', 'recommend', 'recommendation', 'suggestions', 'any suggestion',
  'alternative to', 'alternatives', 'best tool', 'best app', 'best platform',
  'which should i', 'what should i', 'anyone use', 'anyone using', 'is there a tool',
  'is there an app', 'how do i', 'need a tool', 'need help', 'worth it', ' vs ',
  'better than', 'tried any', 'what do you use', 'should i use', 'help me choose',
  // 俄语/CIS（FB-Killa、TG 等）——选型/求推荐/找替代的意图词（小写匹配）
  'посоветуйте', 'подскажите', 'ищу', 'какой лучше', 'что лучше', 'какую выбрать',
  'альтернатив', 'стоит ли', 'помогите выбрать', 'кто пользуется', 'кто-нибудь пользуется',
  'есть ли', 'нужен сервис', 'нужен инструмент', 'посоветуете', 'сравнение',
]
const QUESTION_BONUS = 0.15

export function intentScore(text: string): number {
  const t = ` ${(text || '').toLowerCase()} `
  let hits = 0
  for (const p of INTENT_PHRASES) if (t.includes(p)) hits++
  let s = Math.min(1, hits * 0.28)
  if (t.includes('?')) s = Math.min(1, s + QUESTION_BONUS)
  return Number(s.toFixed(3))
}

// ── 俄语/CIS 情绪词典 ─────────────────────────────────────────────────────────
// 共享的 sentiment.ts 是英文赌场词典，对俄语≈0。这里补一套 CIS арбитраж 语境的
// 正/负词，与英文分数相加（封装在内部工具，不动 sentiment.ts）。让 FB-Killa 等
// 俄语贴的"竞品痛点(负面)"信号能浮现。
const RU_NEG = [
  'бан', 'забан', 'заблокир', 'скам', 'развод', 'развел', 'кидал', 'кидают', 'обман', 'мошен',
  'фрод', 'не плат', 'не выплат', 'невыплат', 'задерж', 'проблем', 'дорого', 'отстой', 'ужас',
  'плохо', 'минус', 'слил', 'потерял', 'жалоб', 'шорт', 'шторм', 'апрув упал', 'не работает',
]
const RU_POS = [
  'топ', 'отлично', 'лучш', 'рекоменд', 'хорош', 'профит', 'плюс', 'окупа', 'работает', 'доволен',
  'спасибо', 'годно', 'кайф', 'выгодно', 'апрув', 'залив', 'успех',
]
function ruSentiment(text: string): number {
  const t = (text || '').toLowerCase()
  if (!/[а-яё]/.test(t)) return 0 // 没有西里尔字母就跳过
  let pos = 0, neg = 0
  for (const w of RU_POS) if (t.includes(w)) pos++
  for (const w of RU_NEG) if (t.includes(w)) neg++
  if (!pos && !neg) return 0
  return Math.max(-1, Math.min(1, (pos - neg) * 0.3))
}
// 信号统一情绪：英文词典 + 俄语词典叠加，截断到 [-1,1]
function senti(text: string): number {
  return Math.max(-1, Math.min(1, lexScore(text) + ruSentiment(text)))
}

// ── 相关性闸门 ────────────────────────────────────────────────────────────────
// 对 demand 类信号（含论坛整页吞入、广搜泛词命中）做领域词过滤，去掉无效信息。
// 品牌/竞品类精确命中不过滤。产品未配 relevance=不过滤。
const RELEVANCE = new Map<string, string[]>()
for (const p of PRODUCTS) if (p.relevance?.length) RELEVANCE.set(p.key, p.relevance.map((s) => s.toLowerCase()))
function relevant(product: string, kind: string, text: string): boolean {
  if (kind !== 'demand') return true // 品牌/竞品精确，放行
  const vocab = RELEVANCE.get(product)
  if (!vocab) return true // 未配置词表=不过滤
  const t = (text || '').toLowerCase()
  return vocab.some((w) => t.includes(w))
}

// ── Reddit Atom 解析（与 collectors/reddit.ts 同范式）─────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'").replace(/&amp;/g, '&')
}

function parseAtom(xml: string): { id: string; title: string; link: string; content: string; author: string; ts: number }[] {
  const out: { id: string; title: string; link: string; content: string; author: string; ts: number }[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]
    const id = (e.match(/<id>([^<]+)<\/id>/)?.[1] ?? '').replace(/^t3_/, '').trim()
    if (!id) continue
    const title = decodeEntities((e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim())
    const link = (e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&')
    const author = decodeEntities((e.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1] ?? '').trim())
    const contentRaw = e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ''
    const content = decodeEntities(contentRaw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
    const pub = e.match(/<(?:published|updated)>([^<]+)</)?.[1] ?? ''
    const ts = pub ? Date.parse(pub) : 0
    out.push({ id, title, link, content, author, ts: Number.isFinite(ts) ? ts : 0 })
  }
  return out
}

async function redditSearch(query: string, subreddits: string[]): Promise<string | null> {
  // 限定子版块时用 subreddit:a OR subreddit:b 收窄；否则全站。
  const subClause = subreddits.length ? ` (${subreddits.map((s) => `subreddit:${s}`).join(' OR ')})` : ''
  const q = encodeURIComponent(`${query}${subClause}`)
  const url = `https://www.reddit.com/search.rss?q=${q}&sort=new&limit=25`
  const init = { headers: { 'User-Agent': UA, Accept: 'application/atom+xml,application/xml,text/xml' }, signal: AbortSignal.timeout(70_000) }
  try {
    const res = (await unlockedFetch('reddit', url, init)) ?? (await webFetch(url, { ...init, signal: AbortSignal.timeout(20_000) }))
    if (res.ok) return await res.text()
  } catch {
    /* swallow — caller backs off */
  }
  return null
}

// ── X/Twitter：监听指定账号时间线（与 collectors/twitter.ts 同范式）──────────
async function fetchTimeline(handle: string): Promise<string | null> {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`
  const headers = { 'User-Agent': UA, Accept: 'text/html' }
  const attempts: (Promise<Response> | null)[] = [
    webFetchUnlocked(url, { headers, signal: AbortSignal.timeout(40_000) }),
    webFetchProxied(url, { headers, signal: AbortSignal.timeout(20_000) }),
    webFetch(url, { headers, signal: AbortSignal.timeout(20_000) }),
  ]
  for (const p of attempts) {
    if (!p) continue
    try {
      const r = await p
      if (r.status === 200) {
        const html = await r.text()
        if (html.includes('__NEXT_DATA__')) return html
      }
    } catch {
      /* next transport */
    }
  }
  return null
}

function parseTweets(html: string): { id: string; text: string; likes: number; rts: number; ts: number }[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/)
  if (!m) return []
  let entries: any[]
  try {
    entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries ?? []
  } catch {
    return []
  }
  const out: { id: string; text: string; likes: number; rts: number; ts: number }[] = []
  for (const e of entries) {
    const tw = e?.content?.tweet
    if (!tw) continue
    const text: string = tw.full_text ?? tw.text ?? ''
    const id: string = String(tw.id_str ?? tw.id ?? '')
    if (!text || !id) continue
    out.push({
      id, text,
      likes: Number(tw.favorite_count ?? 0),
      rts: Number(tw.retweet_count ?? 0),
      ts: Date.parse(tw.created_at ?? '') || 0,
    })
  }
  return out
}

// ── Telegram 公开频道：抓 t.me/s/<channel> 预览页的近期消息（与 collectors/telegram.ts 同范式）
async function fetchTgChannel(channel: string): Promise<string | null> {
  const url = `https://t.me/s/${encodeURIComponent(channel)}`
  const init = { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(25_000) }
  try {
    const unlocked = webFetchUnlocked(url, init) // null when no SCRAPER_API_KEY
    const res = unlocked ? await unlocked : await webFetch(url, init)
    if (res.ok) return await res.text()
  } catch {
    /* swallow */
  }
  return null
}

function parseTgMessages(html: string): { id: string; text: string; ts: number }[] {
  const out: { id: string; text: string; ts: number }[] = []
  // 每条消息块带 data-post="channel/123"，正文在 tgme_widget_message_text，时间在 <time datetime>
  for (const m of html.matchAll(/data-post="([^"]+)"[\s\S]*?(?=data-post="|$)/g)) {
    const block = m[0]
    const id = m[1]
    const textM = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)
    if (!textM) continue
    const text = textM[1].replace(/<br\s*\/?>(?=)/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
    if (text.length < 8) continue
    const tM = block.match(/datetime="([^"]+)"/)
    const ts = tM ? Date.parse(tM[1]) || 0 : 0
    out.push({ id, text: text.slice(0, 2000), ts })
  }
  return out
}

// ── 论坛帖子列表抓取（通用：XenForo /threads/slug.123/ + vBulletin showthread.php?t=123）
async function fetchForum(url: string): Promise<string | null> {
  const init = { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(40_000) }
  const unlocked = webFetchUnlocked(url, init) // 过 Cloudflare（BHW 等）
  try {
    const res = unlocked ? await unlocked : await webFetchProxied(url, init)
    if (res.ok) return await res.text()
  } catch {
    /* fall through to direct */
  }
  try {
    const r = await webFetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    if (r.ok) return await r.text()
  } catch {
    /* swallow */
  }
  return null
}

function parseForumThreads(html: string, pageUrl: string): { id: string; title: string; url: string }[] {
  let origin = ''
  try { origin = new URL(pageUrl).origin } catch { origin = '' }
  const host = origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '').slice(0, 12)
  const out: { id: string; title: string; url: string }[] = []
  const seen = new Set<string>()
  const push = (rawId: string, href: string, inner: string) => {
    const title = inner.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
    if (title.length < 8 || seen.has(rawId)) return
    seen.add(rawId)
    const full = /^https?:\/\//.test(href) ? href : origin + '/' + href.replace(/^\//, '')
    out.push({ id: `${host}_${rawId}`, title: title.slice(0, 300), url: full })
  }
  // XenForo（AffiliateFix / AGD）
  for (const m of html.matchAll(/<a href="([^"]*\/threads\/[^"]*?\.(\d+)\/?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) push(m[2], m[1], m[3])
  // vBulletin（showthread.php?t=）
  for (const m of html.matchAll(/<a href="([^"]*showthread\.php\?[^"]*t=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) push('vb' + m[2], m[1], m[3])
  // 通用兜底：非论坛结构的"文章站"(vc.ru/CPALENTA/TraffHub/GPWA 等)——抓同站长标题链接。
  if (out.length === 0) {
    const pageHost = (() => { try { return new URL(pageUrl).host } catch { return '' } })()
    for (const m of html.matchAll(/<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const href = m[1]
      if (/\.(css|js|png|jpe?g|svg|gif|ico|webp|woff2?|mp4|pdf)(\?|$)/i.test(href)) continue
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
      if (title.length < 25 || title.length > 300 || !/[a-zа-яё]/i.test(title)) continue
      const full = /^https?:\/\//.test(href) ? href : origin + '/' + href.replace(/^\//, '')
      try { if (pageHost && !full.includes(pageHost)) continue } catch { continue } // 仅同站
      const id = `${host}_${strHash(full)}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, title: title.slice(0, 300), url: full })
      if (out.length >= 40) break
    }
  }
  return out
}
function strHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ── Bluesky 公开关键词搜索（无 key，app.bsky.feed.searchPosts，与 collectors/bluesky.ts 同范式）
async function fetchBluesky(query: string): Promise<any[] | null> {
  const q = encodeURIComponent(query)
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${q}&limit=100&sort=latest`
  try {
    const res = await webFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const j = (await res.json()) as { posts?: any[] }
    return j.posts ?? []
  } catch {
    return null
  }
}

// ── Hacker News 全文搜索（无 key，Algolia；对 SaaS/技术选型人群最对口，利好 hirecx）
async function fetchHN(query: string): Promise<any[] | null> {
  const q = encodeURIComponent(`"${query}"`)
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=(story,comment)&hitsPerPage=50`
  try {
    const res = await webFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const j = (await res.json()) as { hits?: any[] }
    return j.hits ?? []
  } catch {
    return null
  }
}

// ── ScrapeCreators 付费源（X 账号推文 + Threads 关键词搜索）────────────────────
// key 在 Railway 环境变量 `scrapecreators`（小写）。无 key 时相关 job 返回 null 跳过。
const SC_KEY = () => process.env.scrapecreators || process.env.SCRAPECREATORS_API_KEY || ''
export const scEnabled = () => !!SC_KEY()
async function scFetch(path: string, params: Record<string, string>): Promise<any | null> {
  const key = SC_KEY()
  if (!key) return null
  const qs = new URLSearchParams(params).toString()
  try {
    const res = await webFetch(`https://api.scrapecreators.com${path}?${qs}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// X 账号近期推文（ScrapeCreators，比 syndication 稳）。返回归一化数组或 null。
async function scTweets(handle: string): Promise<{ id: string; text: string; likes: number; rts: number; ts: number }[] | null> {
  const j = await scFetch('/v1/twitter/user-tweets', { handle })
  if (!j) return null
  const arr: any[] = j.tweets ?? j.data ?? []
  // SC 返回原始 Twitter GraphQL Tweet 对象：id 在 rest_id，正文/计数/时间在 legacy
  return arr
    .map((t) => {
      const lg = t.legacy ?? t
      return {
        id: String(t.rest_id ?? t.id_str ?? t.id ?? ''),
        text: lg.full_text ?? lg.text ?? '',
        likes: Number(lg.favorite_count ?? 0),
        rts: Number(lg.retweet_count ?? 0),
        ts: Date.parse(lg.created_at ?? '') || 0,
      }
    })
    .filter((t) => t.id && t.text)
}

// Threads 关键词搜索（ScrapeCreators）。返回归一化数组或 null。
async function scThreads(query: string): Promise<{ id: string; text: string; user: string; likes: number; ts: number; url: string }[] | null> {
  const j = await scFetch('/v1/threads/search', { query })
  if (!j) return null
  const arr: any[] = j.posts ?? j.results ?? j.searchResults ?? j.data ?? (Array.isArray(j) ? j : [])
  return arr
    .map((p) => {
      const post = p?.thread?.thread_items?.[0]?.post ?? p?.post ?? p?.node ?? p // 防御多种嵌套
      const text = post?.caption?.text ?? post?.text ?? ''
      const user = post?.user?.username ?? ''
      const code = post?.code ?? ''
      const id = String(post?.id ?? post?.pk ?? code ?? '')
      const likes = Number(post?.like_count ?? 0)
      const ts = Number(post?.taken_at ?? 0) * 1000
      const url = post?.url ?? post?.canonical_url ?? (user && code ? `https://www.threads.net/@${user}/post/${code}` : '')
      return { id, text, user, likes, ts, url }
    })
    .filter((p) => p.id && p.text)
}

// ── 单轮采集：遍历所有产品 × 平台 × 关键词 ────────────────────────────────────
type Kind = 'brand' | 'competitor' | 'demand'
type Job =
  | { product: string; platform: 'reddit'; kind: Kind; query: string; subreddits: string[] }
  | { product: string; platform: 'x'; kind: 'competitor' | 'brand'; query: string }
  | { product: string; platform: 'telegram'; kind: 'demand'; query: string }
  | { product: string; platform: 'forum'; kind: 'demand'; query: string; url: string }
  | { product: string; platform: 'bluesky'; kind: Kind; query: string }
  | { product: string; platform: 'hn'; kind: Kind; query: string }
  | { product: string; platform: 'threads'; kind: Kind; query: string }

function buildJobs(): Job[] {
  const jobs: Job[] = []
  for (const p of PRODUCTS) {
    for (const kind of ['brand', 'competitor', 'demand'] as const) {
      for (const q of p.reddit[kind]) {
        jobs.push({ product: p.key, platform: 'reddit', kind, query: q, subreddits: p.subreddits })
        jobs.push({ product: p.key, platform: 'bluesky', kind, query: q }) // 同关键词也搜 Bluesky（无 key 广搜）
        if (kind !== 'brand') jobs.push({ product: p.key, platform: 'hn', kind, query: q }) // HN：需求/竞品词（技术/SaaS 人群）
        if (scEnabled()) jobs.push({ product: p.key, platform: 'threads', kind, query: q }) // Threads 关键词搜索（ScrapeCreators 付费源）
      }
    }
    for (const h of p.x.competitorHandles) jobs.push({ product: p.key, platform: 'x', kind: 'competitor', query: h })
    for (const h of p.x.ownHandles) jobs.push({ product: p.key, platform: 'x', kind: 'brand', query: h })
    for (const ch of p.telegram ?? []) jobs.push({ product: p.key, platform: 'telegram', kind: 'demand', query: ch })
    for (const f of p.forums ?? []) jobs.push({ product: p.key, platform: 'forum', kind: 'demand', query: f.name, url: f.url })
  }
  // 已保存且启用的「自定义采集需求」——随同主调度一起轮询
  for (const c of activeCustomQueries()) jobs.push(c)
  return interleave(jobs)
}

// 各平台轮流交错：避免"先把 Reddit 全跑完才轮到论坛/X/TG"——开机几分钟内即遍历所有源，
// 且每次重启(游标归零)也能立刻覆盖到每个平台。
function interleave(jobs: Job[]): Job[] {
  const buckets = new Map<string, Job[]>()
  for (const j of jobs) {
    const k = j.platform
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(j)
  }
  const lists = [...buckets.values()]
  const max = Math.max(0, ...lists.map((l) => l.length))
  const out: Job[] = []
  for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i])
  return out
}

// ── 自定义采集需求（面板手填）────────────────────────────────────────────────
type CustomKind = 'brand' | 'competitor' | 'demand'
const KINDS: CustomKind[] = ['brand', 'competitor', 'demand']

/** 把一行 social_custom_query 规范化为一个 Job（X 平台只支持 brand/competitor）。 */
function customRowToJob(r: { product: string; platform: string; kind: string; query: string; subreddits: string | null }): Job {
  const product = (r.product || 'custom').slice(0, 40)
  const kind = (KINDS.includes(r.kind as CustomKind) ? r.kind : 'demand') as CustomKind
  if (r.platform === 'x') return { product, platform: 'x', kind: kind === 'demand' ? 'competitor' : kind, query: r.query }
  const subreddits = (r.subreddits || '').split(',').map((s) => s.trim()).filter(Boolean)
  return { product, platform: 'reddit', kind, query: r.query, subreddits }
}

function activeCustomQueries(): Job[] {
  const rows = db
    .prepare('SELECT product, platform, kind, query, subreddits FROM social_custom_query WHERE active = 1')
    .all() as any[]
  return rows.map(customRowToJob)
}

/** 即时跑一条自定义需求（不一定已保存），返回新增信号数。 */
export async function runCustomQuery(input: {
  product?: string; platform?: string; kind?: string; query: string; subreddits?: string[]
}): Promise<number> {
  const job = customRowToJob({
    product: input.product || 'custom',
    platform: input.platform === 'x' ? 'x' : 'reddit',
    kind: input.kind || 'demand',
    query: input.query,
    subreddits: (input.subreddits || []).join(','),
  })
  return job.platform === 'reddit' ? runRedditJob(job) : runXJob(job)
}

let jobs: Job[] = []
let cursor = 0

// ── 按平台隔离的失败退避 ──────────────────────────────────────────────────────
// 某个平台（如 Reddit 解锁器超时、Bluesky 从 Railway 被 403）连续失败时，只让该平台
// 退避 30 分钟，不拖累其他平台（尤其 ScrapeCreators 这种可靠付费源）。
const platFails = new Map<string, number>()
const platUntil = new Map<string, number>()
function inBackoff(p: string): boolean { return (platUntil.get(p) || 0) > Date.now() }
function markFail(p: string): void {
  const n = (platFails.get(p) || 0) + 1
  platFails.set(p, n)
  if (n >= 5) { platUntil.set(p, Date.now() + 30 * 60_000); platFails.set(p, 0); console.warn(`[social-intel] ${p} 连续失败，退避 30m`) }
}
function markOk(p: string): void { platFails.set(p, 0); platUntil.delete(p) }

// PullPush.io — 免费 keyless Reddit 全文搜索（Pushshift 继任者），原生 since 时间过滤，
// 帖子+评论都能搜，比 search.rss 全且稳。api.pullpush.io 走直连（不在代理 host 列表）。
async function pullpush(kind: 'submission' | 'comment', q: string, since: number): Promise<any[] | null> {
  const url = `https://api.pullpush.io/reddit/search/${kind}/?q=${encodeURIComponent(q)}&size=100&since=${since}&sort=desc`
  try {
    const r = await webFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25_000) })
    if (!r.ok) return null
    return ((await r.json()) as any).data ?? []
  } catch {
    return null
  }
}

async function runRedditJob(j: Extract<Job, { platform: 'reddit' }>): Promise<number> {
  const since = Math.floor(recentCutoff() / 1000)
  const cutoff = recentCutoff()
  const subs = await pullpush('submission', j.query, since)
  const coms = await pullpush('comment', j.query, since)
  const fresh: AlertSignal[] = []
  let added = 0
  const now = Date.now()

  if (subs === null && coms === null) {
    // PullPush 不可用 → 回退到 search.rss
    const xml = await redditSearch(j.query, j.subreddits)
    if (!xml) { markFail(j.platform); return 0 }
    markOk(j.platform)
    const tx = db.transaction(() => {
      for (const e of parseAtom(xml)) {
        if (e.ts && e.ts < cutoff) continue
        const text = `${e.title} ${e.content}`
        const intent = j.kind === 'demand' ? intentScore(text) : intentScore(text) * 0.5
        const id = `reddit_${e.id}_${j.product}_${j.kind}`
        const r = insertSignal.run({ id, product: j.product, platform: 'reddit', kind: j.kind, query: j.query, author: e.author.slice(0, 120), title: e.title.slice(0, 300), body: e.content, url: e.link, score: 0, sentiment: senti(text), intent, ts: e.ts, collected_ts: now })
        added += r.changes
        if (r.changes) fresh.push({ id, product: j.product, platform: 'reddit', kind: j.kind, title: e.title, url: e.link, intent })
      }
    })
    tx()
    void maybeAlert(fresh)
    return added
  }

  markOk(j.platform)
  const tx = db.transaction(() => {
    const ingest = (rows: any[], isComment: boolean) => {
      for (const p of rows) {
        const ts = (Number(p.created_utc) || 0) * 1000
        if (ts && ts < cutoff) continue
        const permalink = p.permalink ? `https://www.reddit.com${p.permalink}` : ''
        const title = isComment ? (p.body || '') : (p.title || '')
        const body = isComment ? (p.body || '') : (p.selftext || '')
        const text = `${title} ${body}`.trim()
        if (!text || !permalink) continue
        const intent = j.kind === 'demand' ? intentScore(text) : intentScore(text) * 0.5
        const id = `reddit_${strHash(permalink)}_${j.product}_${j.kind}`
        const r = insertSignal.run({
          id, product: j.product, platform: 'reddit', kind: j.kind, query: j.query,
          author: String(p.author || '').slice(0, 120), title: title.replace(/\s+/g, ' ').slice(0, 300), body: body.slice(0, 2000),
          url: permalink, score: Number(p.score || 0), sentiment: senti(text), intent, ts: ts || now, collected_ts: now,
        })
        added += r.changes
        if (r.changes && j.kind === 'demand') fresh.push({ id, product: j.product, platform: 'reddit', kind: j.kind, title: title.slice(0, 200), url: permalink, intent })
      }
    }
    ingest(subs || [], false)
    ingest(coms || [], true)
  })
  tx()
  void maybeAlert(fresh)
  return added
}

async function runTelegramJob(j: Extract<Job, { platform: 'telegram' }>): Promise<number> {
  const html = await fetchTgChannel(j.query)
  if (!html) { markFail(j.platform); return 0 }
  markOk(j.platform)
  const now = Date.now()
  let added = 0
  const fresh: AlertSignal[] = []
  const tx = db.transaction(() => {
    for (const m of parseTgMessages(html)) {
      if (m.ts && m.ts < recentCutoff()) continue
      if (!relevant(j.product, 'demand', m.text)) continue
      const intent = intentScore(m.text)
      const id = `tg_${m.id}_${j.product}`
      const url = `https://t.me/${m.id}`
      const r = insertSignal.run({
        id, product: j.product, platform: 'telegram', kind: 'demand', query: j.query,
        author: j.query, title: m.text.slice(0, 300), body: m.text,
        url, score: 0, sentiment: senti(m.text), intent, ts: m.ts || now, collected_ts: now,
      })
      added += r.changes
      if (r.changes) fresh.push({ id, product: j.product, platform: 'telegram', kind: 'demand', title: m.text.slice(0, 200), url, intent })
    }
  })
  tx()
  void maybeAlert(fresh)
  return added
}

async function runXJob(j: Extract<Job, { platform: 'x' }>): Promise<number> {
  // 优先 ScrapeCreators（稳）；无 key/失败时回退到公开 syndication 时间线
  let tweets = await scTweets(j.query)
  if (!tweets) {
    const html = await fetchTimeline(j.query)
    tweets = html ? parseTweets(html) : null
  }
  if (!tweets) { markFail(j.platform); return 0 }
  markOk(j.platform)
  const now = Date.now()
  let added = 0
  const tx = db.transaction(() => {
    for (const t of tweets!) {
      if (t.ts && t.ts < recentCutoff()) continue
      const r = insertSignal.run({
        id: `x_${t.id}_${j.product}`,
        product: j.product, platform: 'x', kind: j.kind, query: j.query,
        author: j.query, title: t.text.replace(/\s+/g, ' ').slice(0, 300), body: t.text.slice(0, 2000),
        url: `https://x.com/${j.query}/status/${t.id}`, score: t.likes + t.rts,
        sentiment: senti(t.text), intent: intentScore(t.text) * 0.5,
        ts: t.ts || now, collected_ts: now,
      })
      added += r.changes
    }
  })
  tx()
  return added
}

async function runForumJob(j: Extract<Job, { platform: 'forum' }>): Promise<number> {
  const html = await fetchForum(j.url)
  if (!html) { markFail(j.platform); return 0 }
  markOk(j.platform)
  const now = Date.now()
  let added = 0
  const fresh: AlertSignal[] = []
  const tx = db.transaction(() => {
    for (const t of parseForumThreads(html, j.url)) {
      if (!relevant(j.product, 'demand', t.title)) continue
      const intent = intentScore(t.title)
      const id = `forum_${t.id}_${j.product}`
      const r = insertSignal.run({
        id, product: j.product, platform: 'forum', kind: 'demand', query: j.query,
        author: j.query, title: t.title, body: '',
        url: t.url, score: 0, sentiment: senti(t.title), intent, ts: now, collected_ts: now,
      })
      added += r.changes
      if (r.changes) fresh.push({ id, product: j.product, platform: 'forum', kind: 'demand', title: t.title, url: t.url, intent })
    }
  })
  tx()
  void maybeAlert(fresh)
  return added
}

async function runBlueskyJob(j: Extract<Job, { platform: 'bluesky' }>): Promise<number> {
  const posts = await fetchBluesky(j.query)
  if (posts === null) { markFail(j.platform); return 0 }
  markOk(j.platform)
  const now = Date.now()
  let added = 0
  const fresh: AlertSignal[] = []
  const tx = db.transaction(() => {
    for (const p of posts) {
      const text: string = p?.record?.text ?? ''
      const rkey = String(p?.uri ?? '').split('/').pop() ?? ''
      if (!text || !rkey) continue
      const bts = Date.parse(p?.record?.createdAt ?? p?.indexedAt ?? '') || 0
      if (bts && bts < recentCutoff()) continue
      const handle: string = p?.author?.handle ?? ''
      const intent = j.kind === 'demand' ? intentScore(text) : intentScore(text) * 0.5
      const id = `bs_${rkey}_${j.product}_${j.kind}`
      const url = handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : ''
      const r = insertSignal.run({
        id, product: j.product, platform: 'bluesky', kind: j.kind, query: j.query,
        author: handle.slice(0, 120), title: text.replace(/\s+/g, ' ').slice(0, 300), body: text.slice(0, 2000),
        url, score: Number(p?.likeCount ?? 0), sentiment: senti(text), intent,
        ts: bts || now, collected_ts: now,
      })
      added += r.changes
      if (r.changes && j.kind === 'demand') fresh.push({ id, product: j.product, platform: 'bluesky', kind: j.kind, title: text.slice(0, 200), url, intent })
    }
  })
  tx()
  void maybeAlert(fresh)
  return added
}

async function runHnJob(j: Extract<Job, { platform: 'hn' }>): Promise<number> {
  const hits = await fetchHN(j.query)
  if (hits === null) { markFail(j.platform); return 0 }
  markOk(j.platform)
  const now = Date.now()
  let added = 0
  const fresh: AlertSignal[] = []
  const tx = db.transaction(() => {
    for (const h of hits) {
      const text: string = h?.title ?? h?.story_title ?? h?.comment_text ?? h?.story_text ?? ''
      const oid = String(h?.objectID ?? '')
      if (!text || !oid) continue
      const hts = (Number(h?.created_at_i) || 0) * 1000
      if (hts && hts < recentCutoff()) continue
      const clean = text.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
      const intent = j.kind === 'demand' ? intentScore(clean) : intentScore(clean) * 0.5
      const id = `hn_${oid}_${j.product}_${j.kind}`
      const url = `https://news.ycombinator.com/item?id=${oid}`
      const r = insertSignal.run({
        id, product: j.product, platform: 'hn', kind: j.kind, query: j.query,
        author: String(h?.author ?? '').slice(0, 120), title: clean.slice(0, 300), body: clean.slice(0, 2000),
        url, score: Number(h?.points ?? 0), sentiment: senti(clean), intent,
        ts: hts || now, collected_ts: now,
      })
      added += r.changes
      if (r.changes && j.kind === 'demand') fresh.push({ id, product: j.product, platform: 'hn', kind: j.kind, title: clean.slice(0, 200), url, intent })
    }
  })
  tx()
  void maybeAlert(fresh)
  return added
}

async function runThreadsJob(j: Extract<Job, { platform: 'threads' }>): Promise<number> {
  const posts = await scThreads(j.query)
  if (posts === null) { markFail(j.platform); return 0 }
  markOk(j.platform)
  const now = Date.now()
  let added = 0
  const fresh: AlertSignal[] = []
  const tx = db.transaction(() => {
    for (const p of posts) {
      if (p.ts && p.ts < recentCutoff()) continue
      const intent = j.kind === 'demand' ? intentScore(p.text) : intentScore(p.text) * 0.5
      const id = `th_${p.id}_${j.product}_${j.kind}`
      const url = p.url
      const r = insertSignal.run({
        id, product: j.product, platform: 'threads', kind: j.kind, query: j.query,
        author: p.user.slice(0, 120), title: p.text.replace(/\s+/g, ' ').slice(0, 300), body: p.text.slice(0, 2000),
        url, score: p.likes, sentiment: senti(p.text), intent, ts: p.ts || now, collected_ts: now,
      })
      added += r.changes
      if (r.changes && j.kind === 'demand') fresh.push({ id, product: j.product, platform: 'threads', kind: j.kind, title: p.text.slice(0, 200), url, intent })
    }
  })
  tx()
  void maybeAlert(fresh)
  return added
}

export async function runSocialIntelOnce(): Promise<void> {
  if (cursor >= jobs.length) { jobs = buildJobs(); cursor = 0 }
  if (jobs.length === 0) return
  // 跳过当前处于退避中的平台（避免反复撞死的平台浪费这一轮）
  let scanned = 0
  while (scanned < jobs.length && inBackoff(jobs[cursor % jobs.length].platform)) { cursor++; scanned++ }
  if (scanned >= jobs.length) return // 全部平台都在退避
  const j = jobs[cursor++ % jobs.length]
  try {
    const added =
      j.platform === 'reddit' ? await runRedditJob(j)
      : j.platform === 'telegram' ? await runTelegramJob(j)
      : j.platform === 'forum' ? await runForumJob(j)
      : j.platform === 'bluesky' ? await runBlueskyJob(j)
      : j.platform === 'hn' ? await runHnJob(j)
      : j.platform === 'threads' ? await runThreadsJob(j)
      : await runXJob(j)
    if (added) console.log(`[social-intel] ${j.product}/${j.platform}/${j.kind} "${j.query}": +${added}`)
  } catch (e) {
    markFail(j.platform)
    if ((platFails.get(j.platform) || 0) <= 3) console.warn(`[social-intel] ${j.platform} "${j.query}" failed:`, (e as Error).message)
  }
}

// 清理超出时间窗(默认 6 个月)的旧信号 + 其草稿。有真实发帖时间(ts>0)且过旧的才删；
// 论坛/文章站 ts=now 不受影响。
function pruneOld(): void {
  try {
    const cutoff = recentCutoff()
    const ids = db.prepare('SELECT id FROM social_intel WHERE ts > 0 AND ts < ?').all(cutoff) as { id: string }[]
    if (!ids.length) return
    const delD = db.prepare('DELETE FROM social_drafts WHERE signal_id = ?')
    const delS = db.prepare('DELETE FROM social_intel WHERE id = ?')
    const tx = db.transaction(() => { for (const { id } of ids) { delD.run(id); delS.run(id) } })
    tx()
    console.log(`[social-intel] 清理超过 ${RECENT_DAYS} 天的旧信号 ${ids.length} 条`)
  } catch (e) {
    console.warn('[social-intel] prune failed:', (e as Error).message)
  }
}

export function startSocialIntel(): void {
  if ((process.env.SOCIAL_INTEL_ENABLED ?? '1') === '0') return
  const total = buildJobs().length
  if (total === 0) { console.log('[social-intel] no keywords configured — idle'); return }
  console.log(`[social-intel] internal competitor/demand monitor active — ${total} queries (${PRODUCTS.length} products)`)
  const loop = async () => {
    await runSocialIntelOnce()
    // 固定节奏轮询；失败退避已按平台隔离处理（不再全局停摆）。可用 SOCIAL_INTEL_INTERVAL_MS 覆盖。
    setTimeout(loop, Number(process.env.SOCIAL_INTEL_INTERVAL_MS) || 120_000)
  }
  setTimeout(loop, 50_000)
  setTimeout(pruneOld, 120_000) // 启动后清一次旧数据
  setInterval(pruneOld, 6 * 3600_000) // 每 6 小时清一次
}
