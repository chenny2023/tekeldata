import { db } from '../db.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'
import { productByKey } from './products.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 信号分类器（对齐 igaming-social-signal-spec）。用 LLM 给每条信号判定 spec 的结构化字段，
// 并按各产品的「包含/排除」规则把不符合的标记清理（status='dropped'，默认视图隐藏）。
// 这一步关键词做不到——它要判断"是运营商还是玩家""是否已在用 AI 客服且不满""创意可解/不可解"。
//
// 后台批量跑：每轮取若干「未分类(classified_ts IS NULL)」信号（高 intent 优先，也会处理存量旧数据
// → 实现"对之前不符合的清理"），一次 LLM 调用分类多条，写回字段。无 OPENROUTER_API_KEY 时不跑。
// 写入带退避重试（与赌场索引器抢锁）。所有 DB 访问在函数内（懒加载），避免加载顺序问题。
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = Number(process.env.SOCIAL_CLASSIFY_BATCH) || 8
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function writeWithRetry(fn: () => void, tries = 4): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { fn(); return }
    catch (e) { if (!/locked|busy/i.test((e as Error).message) || i === tries - 1) throw e; await sleep(800 * (i + 1)) }
  }
}

// 各产品的分类规则（喂给 LLM 的 system 提示）
const COMMON_EXCLUDE =
  '通用排除(判 keep=false, actor_type="noise")：求职/招人帖、卖号卖料卖数据、机器人spam、纯营销软文/自家产品推广、与本产品完全无关。'

function rules(product: string): { actors: string; pains: string; extra: string } {
  if (product === 'wonix') return {
    actors: 'affiliate | media_buyer | operator(投放负责人) | player | industry | noise（只有前三类是 wonix 目标）',
    pains: 'creative_fatigue(创意疲劳/素材跑挂) | account_ban(封号/拒审) | cpa_roas(CPA涨/ROAS跌/跑不动) | need_creatives(求素材/找设计) | scaling(放量瓶颈) | tool_discussion(讨论工具/求推荐) | vague(泛泛抱怨) | none',
    extra: '排除：与 iGaming/gambling 无关的投放。solvable：创意生成/投放自动化相关=1；纯账户封/支付通道/牌照=0；其余=null。',
  }
  if (product === 'hirecx') return {
    actors: 'operator(运营商/客服或运营负责人) | affiliate | industry | player | noise（玩家纯吐槽 casino 本身=排除）',
    pains: 'dumb(蠢/答非所问/听不懂) | expensive(贵/收费不合理) | integration(接入难/API差) | not_gambling_native(不懂KYC/出款/bonus) | want_switch(想换/找更好的) | selecting(正在选型求推荐) | none',
    extra: 'HireCX=竞品置换：核心(hot)=已在用某 AI 客服且明确不满；温(warm)=正在选型/求推荐 iGaming AI 客服；冷(cold)=人工客服成本高还没上AI。排除：玩家单纯吐槽 casino（与 AI 客服无关）→ keep=false。',
  }
  return { // wcoin
    actors: 'player(高级玩家) | industry(行业人) | operator | affiliate | noise',
    pains: 'review(评价/靠谱吗) | ranking(排名/对比 A vs B) | legitimacy(合法性) | payout(出款) | market_data(市场数据/争议) | none',
    extra: 'wcoin=中立数据/内容导向，不进销售队列。保留玩家/行业的评价/排名/出款/合法性讨论。',
  }
}

const SCHEMA_HINT =
  '只返回 JSON：{"items":[{"i":序号,"keep":true/false,"actor_type":"...","intent_tier":"hot|warm|cold","intent_score":0-100,"pain_type":"...","solvable":true|false|null,"reco_play":"public_reply|dm|diagnostic|content|discard","confidence":0-1}]}'

interface Cls { i: number; keep: boolean; actor_type: string; intent_tier: string; intent_score: number; pain_type: string; solvable: boolean | null; reco_play: string; confidence: number }

async function classifyProductBatch(product: string): Promise<number> {
  const prod = productByKey(product)
  if (!prod) return 0
  const rows = db
    .prepare(`SELECT id, platform, kind, title, body FROM social_intel WHERE product=? AND classified_ts IS NULL ORDER BY intent DESC, collected_ts DESC LIMIT ?`)
    .all(product, BATCH) as { id: string; platform: string; kind: string; title: string; body: string }[]
  if (rows.length === 0) return 0

  const r = rules(product)
  const system =
    `你是 iGaming 社交信号分类器，产品=${prod.name}（${prod.pitch}）。\n` +
    `对每条帖子按规则分类。\nactor_type 取值: ${r.actors}\npain_type 取值: ${r.pains}\n${r.extra}\n${COMMON_EXCLUDE}\n` +
    `intent_tier: hot=主动表达痛点/明确不满/高购买信号; warm=讨论选型求推荐; cold=泛泛相关。reco_play: 销售类高意向→dm 或 public_reply；wcoin→content；噪音/不可触达→discard。\n${SCHEMA_HINT}`
  const user = rows.map((x, i) => `[${i}] (${x.platform}) ${x.title}${x.body ? ' — ' + x.body.slice(0, 200) : ''}`).join('\n').slice(0, 7000)

  const res = await generateContent(system, user)
  const items = (res?.data?.items ?? []) as Cls[]
  if (!Array.isArray(items)) return 0

  const now = Date.now()
  const upd = db.prepare(
    `UPDATE social_intel SET actor_type=?, intent_tier=?, intent=?, pain_type=?, solvable=?, reco_play=?, confidence=?, status=?, classified_ts=? WHERE id=?`,
  )
  // 没被 LLM 返回到的行也标记已分类（intent 极低/解析失败），避免反复重试同一批
  const seen = new Set<number>()
  let kept = 0, dropped = 0
  await writeWithRetry(() => {
    const tx = db.transaction(() => {
      for (const it of items) {
        const row = rows[it.i]
        if (!row) continue
        seen.add(it.i)
        const keep = it.keep !== false && it.actor_type !== 'noise'
        const status = keep ? 'new' : 'dropped'
        upd.run(
          (it.actor_type || '').slice(0, 24), (it.intent_tier || '').slice(0, 8),
          Math.max(0, Math.min(1, (Number(it.intent_score) || 0) / 100)),
          (it.pain_type || '').slice(0, 32),
          it.solvable === true ? 1 : it.solvable === false ? 0 : null,
          (it.reco_play || '').slice(0, 16), Math.max(0, Math.min(1, Number(it.confidence) || 0)),
          status, now, row.id,
        )
        keep ? kept++ : dropped++
      }
      // 未返回的：标记已分类、低分，不丢（保守）
      rows.forEach((row, i) => { if (!seen.has(i)) db.prepare('UPDATE social_intel SET classified_ts=? WHERE id=?').run(now, row.id) })
    })
    tx()
  })
  if (kept || dropped) console.log(`[social-intel] 分类 ${product}: 留 ${kept} / 清 ${dropped}`)
  return kept + dropped
}

export async function classifyBatch(): Promise<number> {
  if (!openrouterEnabled()) return 0
  let total = 0
  for (const p of ['hirecx', 'wonix', 'wcoin']) total += await classifyProductBatch(p)
  return total
}

export function startClassifier(): void {
  if ((process.env.SOCIAL_INTEL_ENABLED ?? '1') === '0') return
  if (!openrouterEnabled()) { console.log('[social-intel] 分类器未启用（无 OPENROUTER_API_KEY）'); return }
  console.log('[social-intel] 信号分类器已启动（对齐 spec + 清理不符合）')
  const loop = async () => {
    try { await classifyBatch() } catch (e) { console.warn('[social-intel] classify failed:', (e as Error).message) }
    setTimeout(loop, Number(process.env.SOCIAL_CLASSIFY_MS) || 50_000)
  }
  setTimeout(loop, 80_000)
}
