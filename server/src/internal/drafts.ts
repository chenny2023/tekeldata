import { db } from '../db.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'
import { productByKey } from './products.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 开场白 / 草稿生成（对齐 spec §2 的 draft_artifact）。按产品走不同逻辑：
//   wonix  → 创意疲劳点 teardown + 2-3 条定制素材角度 + 免费送样（产品即诱饵）。
//            spec：不可解(封号/支付/牌照, solvable=0)的信号不发免费样片 → 直接拒绝出销售草稿。
//   hirecx → 按不满桶(蠢/贵/接入/不懂博彩/想换)匹配的"置换证明"开场白。
//   wcoin  → 中立、有数据点的回帖，自然带出 wcoin（进内容队列，非销售）。
// 人工审核后再发；无 OPENROUTER_API_KEY 时返回提示。
// ─────────────────────────────────────────────────────────────────────────────

function systemFor(productKey: string, painType: string): string {
  const common =
    'You are NOT a spammer. Only produce a reply if it is genuinely a fit; otherwise set relevant=false. ' +
    'Sound like a real, knowledgeable peer — no hype, no emoji spam, no fake claims. Respond ONLY as JSON: ' +
    '{"relevant":true|false,"reason":"<one sentence>","comment":"<the reply draft or empty>"}'
  if (productKey === 'wonix')
    return (
      'You are a senior iGaming media-buying creative strategist for wonix.ai (an AI ad-creative workflow for ' +
      'iGaming media buyers). The poster is an affiliate / media buyer with a creative pain (pain: ' + (painType || 'unknown') + '). ' +
      'Write a short peer-to-peer reply that: (1) leads with a concrete creative teardown/insight for their exact ' +
      'pain (why creatives fatigue, an angle working right now for casino/slots offers), (2) names 2-3 specific ' +
      'creative ANGLE concepts they could test, (3) offers to send a few ready-made creatives for free — wonix is ' +
      'the bait ("made you a couple, grab them free"). Mention wonix.ai once, plainly. ' + common
    )
  if (productKey === 'hirecx')
    return (
      'You are from hirecx.ai — AI customer-service "digital employees" for online businesses, API-connected, ' +
      'iGaming-native (understands KYC / withdrawals / bonuses), priced per token at $0.008/message. The poster is ' +
      'an operator / ops or support lead who is using or choosing an AI support tool and is dissatisfied. ' +
      'Their dissatisfaction bucket = "' + (painType || 'unknown') + '". Write a short DISPLACEMENT-PROOF reply matched to it: ' +
      'dumb→offer to throw their hardest KYC/payout/bonus questions at hirecx for a side-by-side; ' +
      'expensive→a quick pricing teardown vs per-resolution pricing ($0.008/msg); ' +
      'integration→"X-day onboarding, here is the flow"; ' +
      'not_gambling_native→an iGaming-native scenario test (KYC/withdrawal/bonus); ' +
      'want_switch→a concrete migration path + risk cover. Mention hirecx.ai once. ' + common
    )
  return ( // wcoin — content queue
    'You are a knowledgeable, neutral iGaming/crypto-casino analyst. The poster asks about casino safety, ' +
    'rankings, comparisons, legitimacy or payouts. Write a genuinely neutral, helpful reply that offers a ' +
    'concrete data point or how-to and naturally mentions wcoin.casino as an on-chain solvency / data resource ' +
    '(NOT a hard sell — it should read as a useful pointer). Mention wcoin.casino once. ' + common
  )
}

export async function generateDraft(signalId: string): Promise<{ ok: boolean; message: string; draftId?: number }> {
  const sig = db.prepare('SELECT * FROM social_intel WHERE id = ?').get(signalId) as any
  if (!sig) return { ok: false, message: 'signal not found' }
  const product = productByKey(sig.product)
  if (!product) return { ok: false, message: `unknown product ${sig.product}` }
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置，无法自动生成草稿（可人工撰写）' }

  // spec：wonix 不可解信号（封号/支付/牌照）只记录，不发免费样片
  if (sig.product === 'wonix' && sig.solvable === 0) {
    db.prepare("UPDATE social_intel SET status='reviewed' WHERE id=?").run(signalId)
    return { ok: false, message: '不可解信号（封号/支付/牌照），按 spec 仅记录、不外发样片' }
  }

  const user = `Our product:
- Name: ${product.name}
- URL: ${product.url}
- What it is: ${product.pitch}

The social-media post (platform: ${sig.platform}, actor: ${sig.actor_type || '?'}, tier: ${sig.intent_tier || '?'}, pain: ${sig.pain_type || '?'}):
- Title: ${sig.title}
- Body: ${sig.body || '(none)'}
- Author: ${sig.author || '(unknown)'}
- URL: ${sig.url}`

  const res = await generateContent(systemFor(sig.product, sig.pain_type), user)
  if (!res) return { ok: false, message: 'AI 生成失败（OpenRouter 无响应）' }
  const d = res.data as { relevant?: boolean; reason?: string; comment?: string }
  const relevant = !!d.relevant
  const comment = (d.comment || '').trim()
  const reason = (d.reason || '').trim()

  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO social_drafts(signal_id, product, draft, rationale, model, status, created_ts, updated_ts)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(signalId, sig.product, relevant ? comment : '', reason, res.model, relevant ? 'pending' : 'dismissed', now, now)
  db.prepare("UPDATE social_intel SET status='reviewed' WHERE id=?").run(signalId)

  return {
    ok: true,
    draftId: Number(info.lastInsertRowid),
    message: relevant ? '已生成开场白草稿（待审核）' : `AI 判定不相关，已跳过：${reason}`,
  }
}
