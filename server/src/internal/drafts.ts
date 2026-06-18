import { db } from '../db.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'
import { productByKey } from './products.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 评论推荐草稿生成（人工审核后再发，不自动发布）。
// 复用现有 OpenRouter 客户端。AI 同时做两件事：
//   1) 相关性判断 —— 这条贴是否真的适合推荐该产品（过滤误命中/牛头不对马嘴）
//   2) 若相关，写一条真实、克制、不像广告的英文评论草稿，自然带出产品价值与链接。
//
// 产出存入 social_drafts，状态 pending；团队在内部面板审核 → approved → 自己去平台发。
// 没配 OPENROUTER_API_KEY 时返回提示，流程仍可走（人工自己写）。
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `You are a community-savvy growth marketer for a software company.
You read a real social-media post and decide whether it's a genuine opportunity to
helpfully recommend ONE of our products. You are NOT a spammer: only recommend when
the product truly fits the poster's need. If it doesn't fit, say so.

When it fits, write ONE short reply (2-4 sentences) that:
- leads with genuinely useful, specific help for the poster's actual question
- mentions our product naturally as one option, never as a hard sell
- is honest about what it does; no fake claims, no hype, no emojis spam
- sounds like a real knowledgeable person, not an ad
- includes the product URL once, plainly
Respond ONLY as JSON.`

interface DraftResult {
  relevant: boolean
  reason: string
  comment: string
}

export async function generateDraft(signalId: string): Promise<{ ok: boolean; message: string; draftId?: number }> {
  const sig = db.prepare('SELECT * FROM social_intel WHERE id = ?').get(signalId) as any
  if (!sig) return { ok: false, message: 'signal not found' }
  const product = productByKey(sig.product)
  if (!product) return { ok: false, message: `unknown product ${sig.product}` }
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置，无法自动生成草稿（可人工撰写）' }

  const user = `Our product:
- Name: ${product.name}
- URL: ${product.url}
- What it is: ${product.pitch}

The social-media post (platform: ${sig.platform}, kind: ${sig.kind}):
- Title: ${sig.title}
- Body: ${sig.body || '(none)'}
- Author: ${sig.author || '(unknown)'}
- URL: ${sig.url}

Decide and respond as JSON exactly:
{"relevant": true|false, "reason": "<one sentence why it does/doesn't fit>", "comment": "<the reply draft, or empty string if not relevant>"}`

  const res = await generateContent(SYSTEM, user)
  if (!res) return { ok: false, message: 'AI 生成失败（OpenRouter 无响应）' }
  const d = res.data as Partial<DraftResult>
  const relevant = !!d.relevant
  const comment = (d.comment || '').trim()
  const reason = (d.reason || '').trim()

  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO social_drafts(signal_id, product, draft, rationale, model, status, created_ts, updated_ts)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      signalId,
      sig.product,
      relevant ? comment : '',
      reason,
      res.model,
      relevant ? 'pending' : 'dismissed',
      now,
      now,
    )
  // 已为这条信号生成过草稿就标记为 reviewed，避免列表里重复出现
  db.prepare("UPDATE social_intel SET status='reviewed' WHERE id=?").run(signalId)

  return {
    ok: true,
    draftId: Number(info.lastInsertRowid),
    message: relevant ? '已生成推荐草稿（待审核）' : `AI 判定不相关，已跳过：${reason}`,
  }
}
