import { db } from '../db.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'
import { productByKey, PRODUCTS } from './products.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 潜在合作对象（KOL 库）。从 X/Threads 采集中沉淀「粉丝够大、靠谱、领域相关」的作者，
// 形成一份可外联(DM 合作/推广/销售)的推荐名单。
//
// 数据来源：X 关键词搜索(twitterapi.io)随结果内联返回完整作者档案(粉丝/认证/简介/账号年龄/
//   能否私信…)，零额外调用 → runXSearchJob 里 upsertKol。Threads 同理(ScrapeCreators，credits 够时)。
// 两道筛选：
//   ① cred_score(0-100) 启发式——衡量「受众质量」：粉丝量(对数)、粉丝/关注比、账号年龄、认证、活跃度、互动。
//   ② LLM fit——衡量「领域相关 + 是否靠谱」：判断此人是否我们目标圈层的真 KOL(投手/赌场博主/运营/CX)，
//      并标记 giveaway/airdrop/机器人/割韭菜 类账号(is_scam=1) 排除。
// 推荐列表默认只显示 cred_score≥SOCIAL_KOL_MIN_CRED 且 fit_score≥0.5 且非 scam，按综合分排序。
// 被「信号不符」抑制的作者不会进推荐(JOIN social_suppress)。
// 团队可标记外联状态：candidate→shortlisted→contacted→rejected，并一键生成个性化合作 DM。
// ─────────────────────────────────────────────────────────────────────────────

db.pragma('busy_timeout = 30000') // 与部署交接锁共存（模块级建表在 main() 抬高超时前就跑）

db.exec(`
CREATE TABLE IF NOT EXISTS social_kol (
  id            TEXT PRIMARY KEY,            -- platform_handle(小写)
  platform      TEXT NOT NULL,              -- x | threads
  handle        TEXT NOT NULL,
  name          TEXT,
  bio           TEXT,
  followers     INTEGER NOT NULL DEFAULT 0,
  following     INTEGER NOT NULL DEFAULT 0,
  verified      INTEGER NOT NULL DEFAULT 0,  -- isVerified || isBlueVerified
  can_dm        INTEGER NOT NULL DEFAULT 0,
  statuses      INTEGER NOT NULL DEFAULT 0,
  acct_created_ts INTEGER NOT NULL DEFAULT 0,
  location      TEXT,
  profile_url   TEXT,
  products      TEXT,                        -- 逗号分隔：在哪些产品的查询下被发现
  posts_seen    INTEGER NOT NULL DEFAULT 0,
  sample_text   TEXT,
  sample_url    TEXT,
  best_engage   INTEGER NOT NULL DEFAULT 0,  -- 见过的最高单帖互动(代表作)
  cred_score    INTEGER NOT NULL DEFAULT 0,  -- 启发式 0-100（受众质量）
  fit_product   TEXT,                        -- LLM 选定的最佳匹配产品 key
  fit_score     REAL NOT NULL DEFAULT 0,     -- LLM 领域契合度 0-1
  fit_role      TEXT,                        -- media_buyer | casino_influencer | operator | cx | crypto | other
  fit_reason    TEXT,
  is_scam       INTEGER NOT NULL DEFAULT 0,  -- LLM：giveaway/airdrop/bot/割韭菜
  dm_draft      TEXT,                        -- 生成的合作 DM 草稿
  status        TEXT NOT NULL DEFAULT 'candidate', -- candidate | shortlisted | contacted | rejected
  scored_ts     INTEGER,
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kol_followers ON social_kol(followers DESC);
CREATE INDEX IF NOT EXISTS idx_kol_scored ON social_kol(scored_ts);
CREATE INDEX IF NOT EXISTS idx_kol_status ON social_kol(status);
`)

const MIN_FOLLOWERS = () => Number(process.env.SOCIAL_KOL_MIN_FOLLOWERS) || 1000
const MIN_CRED = () => Number(process.env.SOCIAL_KOL_MIN_CRED) || 40
const YEAR = 365.25 * 86_400_000

export interface KolProfile {
  platform: string
  handle: string
  name?: string
  bio?: string
  followers: number
  following: number
  verified?: boolean
  canDm?: boolean
  statuses?: number
  createdTs?: number
  location?: string
  profileUrl?: string
}

// 启发式可信分（受众质量），透明可解释，0-100。
export function credScore(p: { followers: number; following: number; verified?: boolean; statuses?: number; createdTs?: number; bestEngage?: number }): number {
  const f = Math.max(0, p.followers || 0)
  const fl = Math.max(1, p.following || 0)
  let s = 0
  // 粉丝量(对数)：1k≈13, 1万≈26, 10万≈39, 上限 40
  s += Math.max(0, Math.min(40, (Math.log10(Math.max(f, 1)) - 2) * 13))
  // 粉丝/关注比：真影响力(非互粉农场)。比 2→6, 4→12, 8→18
  const ratio = f / fl
  s += Math.max(0, Math.min(18, Math.log2(Math.max(ratio, 0.1)) * 6))
  // 账号年龄：越老越稳。每年 +4，上限 16
  if (p.createdTs && p.createdTs > 0) s += Math.min(16, ((Date.now() - p.createdTs) / YEAR) * 4)
  // 认证
  if (p.verified) s += 10
  // 活跃度：发帖数处于健康区间(非僵尸非刷屏)
  const st = p.statuses || 0
  if (st >= 50 && st <= 200_000) s += 8
  // 互动(代表作)
  s += Math.max(0, Math.min(8, Math.log10((p.bestEngage || 0) + 1) * 4))
  return Math.round(Math.max(0, Math.min(100, s)))
}

const selKol = db.prepare('SELECT products, posts_seen, best_engage, sample_text FROM social_kol WHERE id=?')
const insKol = db.prepare(`INSERT INTO social_kol
  (id, platform, handle, name, bio, followers, following, verified, can_dm, statuses, acct_created_ts, location, profile_url, products, posts_seen, sample_text, sample_url, best_engage, cred_score, first_seen_ts, last_seen_ts)
  VALUES (@id,@platform,@handle,@name,@bio,@followers,@following,@verified,@can_dm,@statuses,@acct_created_ts,@location,@profile_url,@products,1,@sample_text,@sample_url,@best_engage,@cred_score,@now,@now)`)
const updKol = db.prepare(`UPDATE social_kol SET
  name=@name, bio=@bio, followers=@followers, following=@following, verified=@verified, can_dm=@can_dm,
  statuses=@statuses, acct_created_ts=@acct_created_ts, location=@location, profile_url=@profile_url,
  products=@products, posts_seen=posts_seen+1, sample_text=@sample_text, sample_url=@sample_url,
  best_engage=@best_engage, cred_score=@cred_score, last_seen_ts=@now,
  scored_ts=CASE WHEN followers>@followers_prev*1.5 THEN NULL ELSE scored_ts END
  WHERE id=@id`)

/** 采集 X/Threads 帖子时调用：粉丝≥阈值则把作者沉淀进 KOL 库。post 用于留代表作 + 互动量。 */
export function upsertKol(p: KolProfile, product: string, post?: { text?: string; url?: string; engage?: number }): void {
  try {
    const handle = (p.handle || '').trim()
    if (!handle) return
    const followers = Math.max(0, p.followers || 0)
    if (followers < MIN_FOLLOWERS()) return
    const id = `${p.platform}_${handle.toLowerCase()}`
    const now = Date.now()
    const engage = Math.max(0, post?.engage || 0)
    const prev = selKol.get(id) as { products: string; posts_seen: number; best_engage: number; sample_text: string } | undefined
    // 产品集合并
    const prods = new Set((prev?.products || '').split(',').filter(Boolean))
    prods.add(product)
    const products = [...prods].join(',')
    // 代表作：留互动更高的那条
    const keepNewSample = !prev || engage >= (prev.best_engage || 0) || !prev.sample_text
    const best_engage = Math.max(prev?.best_engage || 0, engage)
    const cred = credScore({ followers, following: p.following, verified: p.verified, statuses: p.statuses, createdTs: p.createdTs, bestEngage: best_engage })
    const row = {
      id, platform: p.platform, handle,
      name: (p.name || '').slice(0, 120), bio: (p.bio || '').slice(0, 600),
      followers, following: Math.max(0, p.following || 0),
      verified: p.verified ? 1 : 0, can_dm: p.canDm ? 1 : 0,
      statuses: Math.max(0, p.statuses || 0), acct_created_ts: p.createdTs || 0,
      location: (p.location || '').slice(0, 120), profile_url: p.profileUrl || `https://x.com/${handle}`,
      products,
      sample_text: keepNewSample ? (post?.text || '').slice(0, 400) : prev!.sample_text,
      sample_url: keepNewSample ? (post?.url || '') : undefined,
      best_engage, cred_score: cred, now,
    }
    if (prev) updKol.run({ ...row, sample_url: keepNewSample ? (post?.url || '') : '', followers_prev: 0 } as any)
    else insKol.run(row as any)
  } catch (e) {
    console.warn('[kol] upsert failed:', (e as Error).message)
  }
}

// ── LLM 评分：领域契合 + 是否靠谱（排除 scam）。每轮取若干未评分 KOL 批量判定。 ───────────
const SCORE_BATCH = Number(process.env.SOCIAL_KOL_SCORE_BATCH) || 8
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface KolCls { i: number; fit_product: string; fit_score: number; fit_role: string; is_scam: boolean; reason: string }

export async function scoreKolsBatch(): Promise<number> {
  if (!openrouterEnabled()) return 0
  const rows = db
    .prepare('SELECT id, handle, name, bio, followers, following, location, products, sample_text FROM social_kol WHERE scored_ts IS NULL AND followers>=? ORDER BY followers DESC LIMIT ?')
    .all(MIN_FOLLOWERS(), SCORE_BATCH) as { id: string; handle: string; name: string; bio: string; followers: number; following: number; location: string; products: string; sample_text: string }[]
  if (rows.length === 0) return 0

  const prodLines = PRODUCTS.map((p) => `- ${p.key}: ${p.name} — ${p.pitch}`).join('\n')
  const system =
    `你在为 iGaming 团队筛选「可合作的 KOL/达人」。我们有三款产品：\n${prodLines}\n` +
    `目标受众：wcoin=加密赌场玩家(适合赌场博主/crypto/degen 类达人做推广)；hirecx=赌场运营商/客服负责人(适合运营/CX/iGaming B2B 声音做销售合作)；wonix=效果广告投手/联盟(适合投放/UA/affiliate 达人做销售合作)。\n` +
    `对每个账号判定：fit_product=三者中最匹配的一个 key；fit_score=0-1 该账号受众与该产品的契合度(其粉丝里有多少是我们的潜在用户)；` +
    `fit_role= media_buyer|affiliate|casino_influencer|operator|cx|crypto|industry|other；` +
    `is_scam=true 当账号像 giveaway/airdrop/薅羊毛/机器人/卖粉/纯币圈喊单/与我们三个领域完全无关。reason=一句话中文理由。\n` +
    `宁缺毋滥：与三领域都不沾边的给 fit_score<0.3。只返回 JSON：{"items":[{"i":序号,"fit_product":"...","fit_score":0-1,"fit_role":"...","is_scam":true|false,"reason":"..."}]}`
  const user = rows
    .map((x, i) => `[${i}] @${x.handle}${x.name ? ' (' + x.name + ')' : ''} · 粉丝${x.followers} · 发现于[${x.products}]\nbio: ${(x.bio || '(无)').slice(0, 200)}\n代表帖: ${(x.sample_text || '(无)').slice(0, 160)}`)
    .join('\n---\n')
    .slice(0, 7000)

  const res = await generateContent(system, user)
  const items = (res?.data?.items ?? []) as KolCls[]
  if (!Array.isArray(items)) return 0
  const now = Date.now()
  const upd = db.prepare('UPDATE social_kol SET fit_product=?, fit_score=?, fit_role=?, is_scam=?, fit_reason=?, scored_ts=? WHERE id=?')
  let n = 0
  const seen = new Set<number>()
  const tx = db.transaction(() => {
    for (const it of items) {
      const row = rows[it.i]
      if (!row) continue
      seen.add(it.i)
      upd.run(
        (it.fit_product || '').slice(0, 16),
        Math.max(0, Math.min(1, Number(it.fit_score) || 0)),
        (it.fit_role || '').slice(0, 24),
        it.is_scam === true ? 1 : 0,
        (it.reason || '').slice(0, 300),
        now, row.id,
      )
      n++
    }
    // 未返回的也标记已评分，避免反复重试
    rows.forEach((row, i) => { if (!seen.has(i)) db.prepare('UPDATE social_kol SET scored_ts=?, fit_score=0 WHERE id=?').run(now, row.id) })
  })
  for (let a = 0; a < 4; a++) { try { tx(); break } catch (e) { if (!/locked|busy/i.test((e as Error).message) || a === 3) throw e; await sleep(800 * (a + 1)) } }
  if (n) console.log(`[kol] 评分 ${n} 个潜在合作 KOL`)
  return n
}

export function startKolScorer(): void {
  if ((process.env.SOCIAL_INTEL_ENABLED ?? '1') === '0') return
  if (!openrouterEnabled()) return
  const loop = async () => {
    try { await scoreKolsBatch() } catch (e) { console.warn('[kol] score failed:', (e as Error).message) }
    setTimeout(loop, Number(process.env.SOCIAL_KOL_SCORE_MS) || 60_000)
  }
  setTimeout(loop, 95_000)
}

// ── 列表查询（供面板）。默认只出「靠谱推荐」：cred 达标 + fit≥0.5 + 非 scam + 未被抑制。 ──────
export interface KolFilter { product?: string; platform?: string; status?: string; minFollowers?: number; all?: boolean }
export function listKols(f: KolFilter): any[] {
  const where: string[] = ['k.followers >= ?']
  const params: any[] = [Math.max(f.minFollowers || 0, 0)]
  if (f.product) { where.push('k.products LIKE ?'); params.push(`%${f.product}%`) }
  if (f.platform) { where.push('k.platform = ?'); params.push(f.platform) }
  if (f.status) { where.push('k.status = ?'); params.push(f.status) }
  if (!f.all) {
    // 推荐档：已评分、契合、靠谱、未被「信号不符」抑制
    where.push('k.scored_ts IS NOT NULL', 'k.is_scam = 0', 'k.fit_score >= 0.5', 'k.cred_score >= ?', "k.status != 'rejected'")
    params.push(MIN_CRED())
    where.push("NOT EXISTS (SELECT 1 FROM social_suppress s WHERE s.kind='author' AND s.hits>=2 AND lower(s.value)=lower(k.handle))")
  }
  return db
    .prepare(`SELECT k.* FROM social_kol k WHERE ${where.join(' AND ')}
      ORDER BY (k.cred_score * (0.5 + k.fit_score)) DESC, k.followers DESC LIMIT 200`)
    .all(...params)
}

export function kolStats(): { total: number; recommended: number; contacted: number } {
  const total = (db.prepare('SELECT COUNT(*) n FROM social_kol WHERE followers>=?').get(MIN_FOLLOWERS()) as any).n
  const recommended = (db.prepare('SELECT COUNT(*) n FROM social_kol WHERE scored_ts IS NOT NULL AND is_scam=0 AND fit_score>=0.5 AND cred_score>=?').get(MIN_CRED()) as any).n
  const contacted = (db.prepare("SELECT COUNT(*) n FROM social_kol WHERE status='contacted'").get() as any).n
  return { total, recommended, contacted }
}

export function setKolStatus(id: string, status: string): boolean {
  if (!['candidate', 'shortlisted', 'contacted', 'rejected'].includes(status)) return false
  return db.prepare('UPDATE social_kol SET status=? WHERE id=?').run(status, id).changes > 0
}

// ── 合作 DM 生成：按最匹配产品 + 该 KOL 的简介/代表作，写一条个性化、1:1 的外联私信。 ──────
export async function generateKolDm(id: string): Promise<{ ok: boolean; message: string; draft?: string }> {
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置' }
  const k = db.prepare('SELECT * FROM social_kol WHERE id=?').get(id) as any
  if (!k) return { ok: false, message: '未找到该 KOL' }
  const product = productByKey(k.fit_product) || productByKey((k.products || '').split(',')[0]) || productByKey('wcoin')!
  const collab =
    product.key === 'wcoin'
      ? '推广合作：邀请其向自己的加密赌场玩家受众介绍 wcoin.casino(链上偿付能力/赌场安全数据)，可谈付费推广/联盟分成。'
      : product.key === 'hirecx'
        ? '销售/渠道合作：其受众里有赌场运营商/客服负责人，邀请其推荐或转介 hirecx(AI 客服团队)，可谈联盟/返佣/联合内容。'
        : '销售/渠道合作：其受众里有投手/联盟，邀请其推荐或共创关于 wonix(AI 广告创意伙伴)的内容，可谈联盟/返佣。'
  const system =
    `你为 ${product.name} 写一条发给 KOL 的「合作邀约」私信(DM)。产品：${product.pitch}\n合作类型：${collab}\n` +
    `要求：用对方主页语言(英文账号→英文)；开头点名其具体领域/代表内容，证明你真的看过 ta(不是群发模板)；` +
    `一句话说清我们是谁 + 为什么 ta 的受众契合 + 提出一个具体、低门槛的合作切入(如先寄样/试用/给一版定制内容/聊聊分成)；` +
    `真诚、简短(<90 词)、不浮夸、不画大饼、不堆 emoji。只返回 JSON：{"dm":"<私信正文>"}`
  const user = `KOL：@${k.handle}${k.name ? ' (' + k.name + ')' : ''}\n平台：${k.platform} · 粉丝：${k.followers} · 角色判定：${k.fit_role || '?'}\nbio：${k.bio || '(无)'}\n代表帖：${k.sample_text || '(无)'}`
  const res = await generateContent(system, user)
  const dm = (res?.data?.dm || '').trim()
  if (!dm) return { ok: false, message: 'AI 生成失败' }
  db.prepare('UPDATE social_kol SET dm_draft=? WHERE id=?').run(dm.slice(0, 1200), id)
  return { ok: true, message: '已生成合作 DM 草稿', draft: dm }
}
