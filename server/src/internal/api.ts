import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db.ts'
import { userFromRequest, isAdminEmail } from '../auth.ts'
import { generateDraft } from './drafts.ts'
import { runSocialIntelOnce } from './socialintel.ts'
import { PRODUCTS } from './products.ts'
import { PANEL_HTML } from './panel.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 内部社媒情报 — 管理员鉴权 API + 面板。所有数据接口仅 admin 可访问。
// 面板挂在 /internal/social（同源，复用 wcoin_token；也支持内置邮箱验证码登录）。
// ─────────────────────────────────────────────────────────────────────────────

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const user = userFromRequest(req)
  if (!user || !isAdminEmail(user.email)) {
    reply.code(403).send({ error: 'admin only' })
    return false
  }
  return true
}

export function registerSocialIntel(app: FastifyInstance): void {
  // 面板（HTML 外壳无需鉴权；下面的数据接口才校验 token）
  app.get('/internal/social', async (_req, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(PANEL_HTML)
  })

  // 产品/关键词配置（前端渲染过滤器用）
  app.get('/api/internal/social/products', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { products: PRODUCTS.map((p) => ({ key: p.key, name: p.name, url: p.url })) }
  })

  // 概览统计
  app.get('/api/internal/social/stats', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const byProduct = db
      .prepare(`SELECT product, kind, COUNT(*) n FROM social_intel GROUP BY product, kind`)
      .all() as { product: string; kind: string; n: number }[]
    const pending = (db.prepare("SELECT COUNT(*) n FROM social_drafts WHERE status='pending'").get() as any).n
    const last24 = (db.prepare('SELECT COUNT(*) n FROM social_intel WHERE collected_ts > ?').get(Date.now() - 86_400_000) as any).n
    const total = (db.prepare('SELECT COUNT(*) n FROM social_intel').get() as any).n
    return { byProduct, pendingDrafts: pending, collected24h: last24, total }
  })

  // 信号列表（可按产品/类别/平台/最小意图分/状态过滤）
  app.get('/api/internal/social/signals', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const where: string[] = []
    const params: any[] = []
    if (q.product) { where.push('product = ?'); params.push(q.product) }
    if (q.kind) { where.push('kind = ?'); params.push(q.kind) }
    if (q.platform) { where.push('platform = ?'); params.push(q.platform) }
    if (q.status) { where.push('status = ?'); params.push(q.status) }
    if (q.minIntent) { where.push('intent >= ?'); params.push(Number(q.minIntent)) }
    const limit = Math.min(200, Number(q.limit) || 60)
    const sort = q.sort === 'intent' ? 'intent DESC, ts DESC' : 'ts DESC'
    const rows = db
      .prepare(`SELECT * FROM social_intel ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT ?`)
      .all(...params, limit)
    return { signals: rows }
  })

  // 为某条信号生成推荐草稿
  app.post('/api/internal/social/draft', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = req.body as { signalId?: string }
    if (!b?.signalId) return reply.code(400).send({ error: 'signalId required' })
    return await generateDraft(b.signalId)
  })

  // 草稿队列（连带原贴信息）
  app.get('/api/internal/social/drafts', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const status = q.status || 'pending'
    const rows = db
      .prepare(
        `SELECT d.*, s.title AS post_title, s.url AS post_url, s.platform, s.kind, s.author, s.intent
         FROM social_drafts d JOIN social_intel s ON s.id = d.signal_id
         WHERE d.status = ? ORDER BY d.created_ts DESC LIMIT 100`,
      )
      .all(status)
    return { drafts: rows }
  })

  // 更新草稿状态：approved | posted | dismissed | pending
  app.post('/api/internal/social/draft/:id/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as any).id)
    const b = req.body as { status?: string; draft?: string }
    const allowed = ['pending', 'approved', 'posted', 'dismissed']
    if (!b?.status || !allowed.includes(b.status)) return reply.code(400).send({ error: 'invalid status' })
    // 允许审核时同时改写草稿正文
    if (typeof b.draft === 'string') {
      db.prepare('UPDATE social_drafts SET status=?, draft=?, updated_ts=? WHERE id=?').run(b.status, b.draft, Date.now(), id)
    } else {
      db.prepare('UPDATE social_drafts SET status=?, updated_ts=? WHERE id=?').run(b.status, Date.now(), id)
    }
    return { ok: true }
  })

  // 标记信号状态（忽略/已读）
  app.post('/api/internal/social/signal/:id/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = (req.params as any).id as string
    const b = req.body as { status?: string }
    const allowed = ['new', 'reviewed', 'ignored']
    if (!b?.status || !allowed.includes(b.status)) return reply.code(400).send({ error: 'invalid status' })
    db.prepare('UPDATE social_intel SET status=? WHERE id=?').run(b.status, id)
    return { ok: true }
  })

  // 手动触发一轮采集（管理员调试用）
  app.post('/api/internal/social/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    void runSocialIntelOnce()
    return { ok: true, message: '已触发一轮采集（异步）' }
  })

  console.log('[social-intel] internal panel registered at /internal/social')
}
