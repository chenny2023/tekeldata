import { db } from '../db.ts'
import { webFetch, webFetchProxied, webFetchUnlocked } from '../net.ts'
import { unlockedFetch } from '../collectors/unlocker.ts'
import { score as lexScore } from '../sentiment.ts'
import { PRODUCTS } from './products.ts'

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
`)

const insertSignal = db.prepare(`
  INSERT OR IGNORE INTO social_intel
    (id, product, platform, kind, query, author, title, body, url, score, sentiment, intent, ts, collected_ts)
  VALUES
    (@id, @product, @platform, @kind, @query, @author, @title, @body, @url, @score, @sentiment, @intent, @ts, @collected_ts)
`)

// ── intent 评分：用户表达"选型/求推荐/找替代"的程度（0..1）──────────────────
// 这些短语命中越多 → 越可能是可以评论推荐自有产品的机会贴。
const INTENT_PHRASES = [
  'looking for', 'recommend', 'recommendation', 'suggestions', 'any suggestion',
  'alternative to', 'alternatives', 'best tool', 'best app', 'best platform',
  'which should i', 'what should i', 'anyone use', 'anyone using', 'is there a tool',
  'is there an app', 'how do i', 'need a tool', 'need help', 'worth it', ' vs ',
  'better than', 'tried any', 'what do you use', 'should i use', 'help me choose',
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

// ── 单轮采集：遍历所有产品 × 平台 × 关键词 ────────────────────────────────────
type Job =
  | { product: string; platform: 'reddit'; kind: 'brand' | 'competitor' | 'demand'; query: string; subreddits: string[] }
  | { product: string; platform: 'x'; kind: 'competitor' | 'brand'; query: string }

function buildJobs(): Job[] {
  const jobs: Job[] = []
  for (const p of PRODUCTS) {
    for (const kind of ['brand', 'competitor', 'demand'] as const) {
      for (const q of p.reddit[kind]) jobs.push({ product: p.key, platform: 'reddit', kind, query: q, subreddits: p.subreddits })
    }
    for (const h of p.x.competitorHandles) jobs.push({ product: p.key, platform: 'x', kind: 'competitor', query: h })
    for (const h of p.x.ownHandles) jobs.push({ product: p.key, platform: 'x', kind: 'brand', query: h })
  }
  return jobs
}

let jobs: Job[] = []
let cursor = 0
export let consecutiveFails = 0

async function runRedditJob(j: Extract<Job, { platform: 'reddit' }>): Promise<number> {
  const xml = await redditSearch(j.query, j.subreddits)
  if (!xml) { consecutiveFails++; return 0 }
  consecutiveFails = 0
  const now = Date.now()
  let added = 0
  const tx = db.transaction(() => {
    for (const e of parseAtom(xml)) {
      const text = `${e.title} ${e.content}`
      const r = insertSignal.run({
        id: `reddit_${e.id}_${j.product}_${j.kind}`,
        product: j.product, platform: 'reddit', kind: j.kind, query: j.query,
        author: e.author.slice(0, 120), title: e.title.slice(0, 300), body: e.content,
        url: e.link, score: 0, sentiment: lexScore(text),
        intent: j.kind === 'demand' ? intentScore(text) : intentScore(text) * 0.5,
        ts: e.ts, collected_ts: now,
      })
      added += r.changes
    }
  })
  tx()
  return added
}

async function runXJob(j: Extract<Job, { platform: 'x' }>): Promise<number> {
  const html = await fetchTimeline(j.query)
  if (!html) { consecutiveFails++; return 0 }
  consecutiveFails = 0
  const now = Date.now()
  let added = 0
  const tx = db.transaction(() => {
    for (const t of parseTweets(html)) {
      const r = insertSignal.run({
        id: `x_${t.id}_${j.product}`,
        product: j.product, platform: 'x', kind: j.kind, query: j.query,
        author: j.query, title: t.text.replace(/\s+/g, ' ').slice(0, 300), body: t.text.slice(0, 2000),
        url: `https://x.com/${j.query}/status/${t.id}`, score: t.likes + t.rts,
        sentiment: lexScore(t.text), intent: intentScore(t.text) * 0.5,
        ts: t.ts || now, collected_ts: now,
      })
      added += r.changes
    }
  })
  tx()
  return added
}

export async function runSocialIntelOnce(): Promise<void> {
  if (cursor >= jobs.length) { jobs = buildJobs(); cursor = 0 }
  if (jobs.length === 0) return
  const j = jobs[cursor++]
  try {
    const added = j.platform === 'reddit' ? await runRedditJob(j) : await runXJob(j)
    if (added) console.log(`[social-intel] ${j.product}/${j.platform}/${j.kind} "${j.query}": +${added}`)
  } catch (e) {
    consecutiveFails++
    if (consecutiveFails <= 3) console.warn(`[social-intel] ${j.platform} "${j.query}" failed:`, (e as Error).message)
  }
}

export function startSocialIntel(): void {
  if ((process.env.SOCIAL_INTEL_ENABLED ?? '1') === '0') return
  const total = buildJobs().length
  if (total === 0) { console.log('[social-intel] no keywords configured — idle'); return }
  console.log(`[social-intel] internal competitor/demand monitor active — ${total} queries (${PRODUCTS.length} products)`)
  const loop = async () => {
    await runSocialIntelOnce()
    // 礼貌节流：每条查询间隔 ~2min（解锁器/住宅代理有成本，社媒信号也是慢节奏）。
    // 持续被封时退避到 30min。可用 SOCIAL_INTEL_INTERVAL_MS 覆盖。
    const healthy = Number(process.env.SOCIAL_INTEL_INTERVAL_MS) || 120_000
    setTimeout(loop, consecutiveFails >= 5 ? 30 * 60_000 : healthy)
  }
  setTimeout(loop, 50_000)
}
