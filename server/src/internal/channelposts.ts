import { db } from '../db.ts'
import { generateContent, generateImage, openrouterEnabled } from '../content/openrouter.ts'
import { productByKey } from './products.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 选题 → 多渠道帖子生成。把一个选题(topic/question/angle/keyword)按各渠道的规范、内容与流量
// 要求，分别产出可直接发布的帖子 + 配图：X / Reddit / LinkedIn / 公众号 / 小红书。
// 文案一次 LLM 调用产出全部渠道；配图每渠道一张(best-effort，OpenRouter 余额不足时自动跳过)。
// 草稿存 social_channel_posts，按 (topic_id, channel) 去重；面板可复制直接发。
// ─────────────────────────────────────────────────────────────────────────────

db.pragma('busy_timeout = 30000')
db.exec(`
CREATE TABLE IF NOT EXISTS social_channel_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL,
  product TEXT,
  channel TEXT NOT NULL,
  title TEXT,
  body TEXT,
  hashtags TEXT,
  image_url TEXT,
  image_prompt TEXT,
  model TEXT,
  created_ts INTEGER NOT NULL,
  UNIQUE(topic_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_scp_topic ON social_channel_posts(topic_id);
`)

interface ChannelSpec { key: string; name: string; lang: 'en' | 'zh'; aspect: '1:1' | '16:9'; guide: string }
const CHANNELS: ChannelSpec[] = [
  { key: 'x', name: 'X', lang: 'en', aspect: '16:9',
    guide: 'X (Twitter) post: a strong hook line, 2-4 short lines of concrete value, one soft CTA, 1-2 relevant hashtags. Whole post ≤ 270 characters. Punchy, no clickbait fluff, no markdown.' },
  { key: 'reddit', name: 'Reddit', lang: 'en', aspect: '16:9',
    guide: 'Reddit text post: an honest specific TITLE (no hashtags) + a value-first BODY (2-5 short paragraphs) that reads as a knowledgeable peer sharing insight, NOT an ad — no links, no overt promotion. Put the title in "title" and the post in "body".' },
  { key: 'linkedin', name: 'LinkedIn', lang: 'en', aspect: '16:9',
    guide: 'LinkedIn post: professional thought-leadership voice — a hook line, 2-4 short paragraphs with a concrete insight or mini-story, end with a question to drive comments, 3-5 hashtags. Medium length.' },
  { key: 'wechat', name: '公众号', lang: 'zh', aspect: '16:9',
    guide: '微信公众号文章：抓人的标题(放 title) + 正文(放 body，600-1000字，用2-4个小标题分段)，专业但易读，结尾给一个明确行动点。全中文。' },
  { key: 'xiaohongshu', name: '小红书', lang: 'zh', aspect: '1:1',
    guide: '小红书笔记：标题(放 title，≤20字，带1-2个emoji、抓眼球) + 正文(放 body，200-400字，口语化、多换行、适当emoji、可分点)，结尾把5-10个话题标签放进 hashtags 数组(不带#)。全中文。' },
]

const upsert = db.prepare(`INSERT INTO social_channel_posts
  (topic_id, product, channel, title, body, hashtags, image_url, image_prompt, model, created_ts)
  VALUES (@topic_id,@product,@channel,@title,@body,@hashtags,@image_url,@image_prompt,@model,@created_ts)
  ON CONFLICT(topic_id, channel) DO UPDATE SET
    title=excluded.title, body=excluded.body, hashtags=excluded.hashtags,
    image_url=excluded.image_url, image_prompt=excluded.image_prompt, model=excluded.model, created_ts=excluded.created_ts`)

export function listChannelPosts(topicId: number): any[] {
  const rows = db.prepare('SELECT * FROM social_channel_posts WHERE topic_id=? ORDER BY id').all(topicId) as any[]
  // 按 CHANNELS 顺序返回
  const order = new Map(CHANNELS.map((c, i) => [c.key, i]))
  return rows.sort((a, b) => (order.get(a.channel) ?? 9) - (order.get(b.channel) ?? 9))
    .map((r) => ({ ...r, hashtags: r.hashtags ? JSON.parse(r.hashtags) : [], name: CHANNELS.find((c) => c.key === r.channel)?.name || r.channel }))
}

export async function generateChannelPosts(topicId: number): Promise<{ ok: boolean; message: string; posts?: any[] }> {
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置' }
  const t = db.prepare('SELECT * FROM social_topics WHERE id=?').get(topicId) as
    | { id: number; product: string; topic: string; question: string; angle: string; keyword: string } | undefined
  if (!t) return { ok: false, message: '未找到该选题' }
  const prod = productByKey(t.product)
  if (!prod) return { ok: false, message: `未知产品 ${t.product}` }

  const specs = CHANNELS.map((c) => `- ${c.key} (${c.name}, 语言:${c.lang === 'zh' ? '中文' : 'English'}): ${c.guide}`).join('\n')
  const system =
    '你是资深多渠道内容运营。给定一个选题，为以下每个渠道分别产出【可直接发布】的帖子，严格符合各渠道的规范、内容风格与流量打法（hook/结构/长度/话题标签）。\n' +
    `渠道规范：\n${specs}\n` +
    '语言务必遵守每个渠道标注（x/reddit/linkedin 用英文，公众号/小红书 用中文）。每个渠道再给一个英文 image_prompt（描述该帖配图，画面具体、无文字/无水印、适合该平台调性）。\n' +
    '只返回 JSON：{"posts":[{"channel":"x|reddit|linkedin|wechat|xiaohongshu","title":"","body":"","hashtags":["..."],"image_prompt":"..."}]}（5 个渠道各一条）。'
  const user = `产品：${prod.name} — ${prod.pitch}\n选题：${t.topic}\n用户在问：${t.question || '(无)'}\n切入角度：${t.angle || '(无)'}\n核心关键词：${t.keyword || '(无)'}`

  const res = await generateContent(system, user)
  const posts = (res?.data?.posts ?? []) as any[]
  if (!Array.isArray(posts) || posts.length === 0) return { ok: false, message: 'AI 未返回有效帖子，请重试（或检查 OpenRouter 余额）' }

  const doImages = (process.env.SOCIAL_POST_IMAGES ?? '1') !== '0'
  const now = Date.now()
  for (const p of posts) {
    const spec = CHANNELS.find((c) => c.key === p.channel)
    if (!spec) continue
    let image = ''
    if (doImages && p.image_prompt) {
      try { image = (await generateImage(String(p.image_prompt).slice(0, 500), spec.aspect)) || '' } catch { image = '' }
    }
    upsert.run({
      topic_id: topicId, product: t.product, channel: spec.key,
      title: String(p.title || '').slice(0, 400), body: String(p.body || '').slice(0, 6000),
      hashtags: JSON.stringify(Array.isArray(p.hashtags) ? p.hashtags.slice(0, 15) : []),
      image_url: image.slice(0, 1_500_000), image_prompt: String(p.image_prompt || '').slice(0, 500),
      model: res?.model || '', created_ts: now,
    })
  }
  return { ok: true, message: '已生成多渠道帖子', posts: listChannelPosts(topicId) }
}

// 单独(重)生成某渠道配图（面板"换图"按钮）。
export async function regenChannelImage(topicId: number, channel: string): Promise<{ ok: boolean; message: string; image_url?: string }> {
  if (!openrouterEnabled()) return { ok: false, message: 'OPENROUTER_API_KEY 未配置' }
  const row = db.prepare('SELECT image_prompt FROM social_channel_posts WHERE topic_id=? AND channel=?').get(topicId, channel) as { image_prompt: string } | undefined
  if (!row) return { ok: false, message: '未找到该帖' }
  const spec = CHANNELS.find((c) => c.key === channel)
  const img = await generateImage(String(row.image_prompt || '').slice(0, 500), spec?.aspect || '1:1')
  if (!img) return { ok: false, message: '配图生成失败（可能 OpenRouter 余额不足）' }
  db.prepare('UPDATE social_channel_posts SET image_url=? WHERE topic_id=? AND channel=?').run(img.slice(0, 1_500_000), topicId, channel)
  return { ok: true, message: '已重新生成配图', image_url: img }
}
