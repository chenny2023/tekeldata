import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db.ts'
import { generateDraft } from './drafts.ts'
import { runSocialIntelOnce, runCustomQuery, twDiag, twitterApiEnabled } from './socialintel.ts'
import { PRODUCTS, productByKey } from './products.ts'
import { PANEL_HTML } from './panel.ts'
import { generateContent, openrouterEnabled } from '../content/openrouter.ts'
import { translateOne, translateBatch } from './translate.ts'
import { registerWgAuth, requireTeam } from './wgauth.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 内部社媒情报 — 管理员鉴权 API + 面板。所有数据接口仅 admin 可访问。
// 面板挂在 /internal/social（同源，复用 wcoin_token；也支持内置邮箱验证码登录）。
// ─────────────────────────────────────────────────────────────────────────────

// Whale Growth 团队会话 或 管理员账号 均可访问（团队门禁见 wgauth.ts）
function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  return requireTeam(req, reply)
}

export function registerSocialIntel(app: FastifyInstance): void {
  registerWgAuth(app) // Whale Growth 团队验证码登录（/api/internal/auth/*）

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
    // 采集健康诊断：每平台 总数/近24h/dropped/最后采集时间，+ 待分类积压
    const health = db.prepare(
      `SELECT platform,
         COUNT(*) total,
         SUM(CASE WHEN status='dropped' THEN 1 ELSE 0 END) dropped,
         SUM(CASE WHEN collected_ts > ? THEN 1 ELSE 0 END) last24h,
         MAX(collected_ts) last_ts
       FROM social_intel GROUP BY platform ORDER BY total DESC`,
    ).all(Date.now() - 86_400_000)
    const unclassified = (db.prepare('SELECT COUNT(*) n FROM social_intel WHERE classified_ts IS NULL').get() as any).n
    return { byProduct, pendingDrafts: pending, collected24h: last24, total, health, unclassified, twDiag, xEnabled: twitterApiEnabled() }
  })

  // 分析概览：跨平台/产品/类别的聚合，供「概览」页可视化
  app.get('/api/internal/social/analytics', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const days = Math.min(30, Math.max(1, Number(q.days) || 7))
    const since = Date.now() - days * 86_400_000
    const sinceClause = 'collected_ts > ?'
    const byPlatform = db.prepare(`SELECT platform, COUNT(*) n FROM social_intel WHERE ${sinceClause} GROUP BY platform ORDER BY n DESC`).all(since)
    const byKind = db.prepare(`SELECT kind, COUNT(*) n FROM social_intel WHERE ${sinceClause} GROUP BY kind ORDER BY n DESC`).all(since)
    const byProduct = db.prepare(`SELECT product, COUNT(*) n, AVG(sentiment) avg_sent, AVG(intent) avg_intent FROM social_intel WHERE ${sinceClause} GROUP BY product ORDER BY n DESC`).all(since)
    // 情绪三档分布
    const sentiment = db.prepare(`
      SELECT SUM(CASE WHEN sentiment > 0.15 THEN 1 ELSE 0 END) pos,
             SUM(CASE WHEN sentiment < -0.15 THEN 1 ELSE 0 END) neg,
             SUM(CASE WHEN sentiment >= -0.15 AND sentiment <= 0.15 THEN 1 ELSE 0 END) neu
      FROM social_intel WHERE ${sinceClause}`).get(since)
    // 高意图需求关键词排行（机会词）
    const topDemand = db.prepare(`
      SELECT query, COUNT(*) n, AVG(intent) avg_intent, AVG(sentiment) avg_sent
      FROM social_intel WHERE ${sinceClause} AND kind='demand'
      GROUP BY query ORDER BY avg_intent DESC, n DESC LIMIT 15`).all(since)
    // 竞品讨论热度（按命中关键词）+ 环比上一同期窗口（涨跌箭头）
    const topCompetitorRaw = db.prepare(`
      SELECT query, COUNT(*) n, AVG(sentiment) avg_sent
      FROM social_intel WHERE ${sinceClause} AND kind='competitor'
      GROUP BY query ORDER BY n DESC LIMIT 15`).all(since) as { query: string; n: number; avg_sent: number }[]
    const prevSince = since - days * 86_400_000
    const prevRows = db.prepare(`
      SELECT query, COUNT(*) n FROM social_intel
      WHERE collected_ts > ? AND collected_ts <= ? AND kind='competitor'
      GROUP BY query`).all(prevSince, since) as { query: string; n: number }[]
    const prevMap = new Map(prevRows.map((r) => [r.query, r.n]))
    const topCompetitor = topCompetitorRaw.map((r) => {
      const prev = prevMap.get(r.query) || 0
      return { ...r, prev, delta: r.n - prev }
    })
    // 按天趋势
    const trend = db.prepare(`
      SELECT strftime('%Y-%m-%d', collected_ts/1000, 'unixepoch') d, COUNT(*) n
      FROM social_intel WHERE ${sinceClause} GROUP BY d ORDER BY d`).all(since)
    // 最高意图的待处理机会贴
    const topOpportunities = db.prepare(`
      SELECT id, product, platform, query, title, url, intent, sentiment, ts
      FROM social_intel WHERE ${sinceClause} AND kind='demand' AND status='new'
      ORDER BY intent DESC, ts DESC LIMIT 10`).all(since)
    return { days, byPlatform, byKind, byProduct, sentiment, topDemand, topCompetitor, trend, topOpportunities }
  })

  // A. 竞品痛点雷达：竞品相关贴里"高意图 + 负面情绪"的人 = 准备换供应商的潜在客户。
  // painScore = intent + max(0,-sentiment)，越高越值得主动接触（用我们产品做替代方案）。
  app.get('/api/internal/social/painradar', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const where = ["kind='competitor'", "status NOT IN ('ignored','mismatch')"]
    const params: any[] = []
    if (q.product) { where.push('product = ?'); params.push(q.product) }
    const limit = Math.min(100, Number(q.limit) || 50)
    const rows = db
      .prepare(
        `SELECT *, (intent + CASE WHEN sentiment < 0 THEN -sentiment ELSE 0 END) AS pain
         FROM social_intel WHERE ${where.join(' AND ')}
         ORDER BY pain DESC, ts DESC LIMIT ?`,
      )
      .all(...params, limit)
    return { signals: rows }
  })

  // 竞品洞察分析：痛点类型分布 + 各竞品排行 + 原始证据（只读，供产品改进参考）
  app.get('/api/internal/social/painanalysis', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const w = ["kind='competitor'", "status NOT IN ('dropped','ignored','mismatch')"]
    const p: any[] = []
    if (q.product) { w.push('product = ?'); p.push(q.product) }
    const W = w.join(' AND ')
    const byPain = db.prepare(`SELECT COALESCE(NULLIF(pain_type,''),'(未分类)') pain, COUNT(*) n, AVG(sentiment) avg_sent FROM social_intel WHERE ${W} GROUP BY pain ORDER BY n DESC LIMIT 15`).all(...p)
    const byCompetitor = db.prepare(`SELECT query, platform, COUNT(*) n, AVG(sentiment) avg_sent FROM social_intel WHERE ${W} GROUP BY query, platform ORDER BY n DESC LIMIT 20`).all(...p)
    const complaints = db.prepare(`SELECT id, product, platform, query, title, url, sentiment, pain_type, zh, ts FROM social_intel WHERE ${W} ORDER BY (CASE WHEN sentiment<0 THEN -sentiment ELSE 0 END) DESC, ts DESC LIMIT 60`).all(...p)
    return { byPain, byCompetitor, complaints }
  })

  // 竞品洞察：列出已生成的产品改进洞察
  app.get('/api/internal/social/insights', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const rows = q.product
      ? db.prepare('SELECT * FROM social_insights WHERE product=? ORDER BY created_ts DESC LIMIT 40').all(q.product)
      : db.prepare('SELECT * FROM social_insights ORDER BY created_ts DESC LIMIT 40').all()
    return { insights: rows }
  })

  // 竞品洞察：用近期竞品吐槽 → AI 综合成"竞品短板→对我们产品/服务的启示"
  app.post('/api/internal/social/insights', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = (req.body || {}) as { product?: string }
    const prod = productByKey(String(b.product || ''))
    if (!prod) return reply.code(400).send({ error: '请选择一个有效产品' })
    if (!openrouterEnabled()) return reply.code(400).send({ error: 'OPENROUTER_API_KEY 未配置' })
    const rows = db.prepare(
      `SELECT query, pain_type, title FROM social_intel WHERE kind='competitor' AND product=? AND status NOT IN ('dropped','ignored','mismatch')
       ORDER BY (CASE WHEN sentiment<0 THEN -sentiment ELSE 0 END) DESC, ts DESC LIMIT 60`,
    ).all(prod.key) as { query: string; pain_type: string; title: string }[]
    if (rows.length < 3) return reply.code(400).send({ error: '竞品吐槽样本太少（<3），多采集些再生成' })
    const sample = rows.map((r, i) => `${i + 1}. [竞品:${r.query}|${r.pain_type || '?'}] ${r.title}`).join('\n').slice(0, 6500)
    const system =
      `你是产品策略分析师。下面是用户对【${prod.name} 的竞品】的真实吐槽/差评（${prod.pitch}）。` +
      `请综合成给我们「产品和服务改进」的洞察——不是用来回复，而是反哺我们做得更好。` +
      `归纳 5-8 条，每条：theme(痛点主题) / gap(竞品在这块的具体短板) / implication(对我们产品或服务的启示或机会) / severity(high|med|low)。` +
      `只返回 JSON：{"insights":[{"theme":"...","gap":"...","implication":"...","severity":"high|med|low"}]}`
    const res = await generateContent(system, `竞品吐槽样本：\n${sample}`)
    const ins = (res?.data?.insights ?? []) as any[]
    if (!Array.isArray(ins) || ins.length === 0) return reply.code(502).send({ error: 'AI 未返回有效洞察，请重试' })
    const now = Date.now()
    const stmt = db.prepare('INSERT INTO social_insights(product, theme, gap, implication, severity, evidence_count, model, created_ts) VALUES(?,?,?,?,?,?,?,?)')
    db.transaction(() => { for (const x of ins.slice(0, 8)) stmt.run(prod.key, String(x.theme || '').slice(0, 200), String(x.gap || '').slice(0, 500), String(x.implication || '').slice(0, 500), String(x.severity || 'med').slice(0, 8), rows.length, res?.model || '', now) })()
    return { ok: true, added: Math.min(8, ins.length) }
  })

  // B. 选题建议：列出已存档选题
  app.get('/api/internal/social/topics', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const where = q.product ? 'WHERE product = ?' : ''
    const rows = q.product
      ? db.prepare(`SELECT * FROM social_topics ${where} ORDER BY created_ts DESC LIMIT 60`).all(q.product)
      : db.prepare('SELECT * FROM social_topics ORDER BY created_ts DESC LIMIT 60').all()
    return { topics: rows }
  })

  // B. 选题建议：用近期 demand 贴让 AI 归纳成 SEO/内容选题，存档并返回
  app.post('/api/internal/social/topics', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = (req.body || {}) as { product?: string }
    const product = String(b.product || '').trim()
    const prod = productByKey(product)
    if (!prod) return reply.code(400).send({ error: '请选择一个有效产品' })
    if (!openrouterEnabled()) return reply.code(400).send({ error: 'OPENROUTER_API_KEY 未配置，无法生成选题' })
    const rows = db
      .prepare(
        `SELECT title, body FROM social_intel WHERE product=? AND kind='demand'
         ORDER BY intent DESC, ts DESC LIMIT 60`,
      )
      .all(product) as { title: string; body: string }[]
    if (rows.length < 3) return reply.code(400).send({ error: '该产品的需求贴样本太少（<3），先多采集一些再生成' })

    const sample = rows.map((r, i) => `${i + 1}. ${r.title}${r.body ? ' — ' + r.body.slice(0, 160) : ''}`).join('\n').slice(0, 6000)
    const system =
      'You are an SEO content strategist. Given real social-media posts where people express a need, ' +
      'cluster them into distinct, high-intent CONTENT TOPICS our product could rank for and convert from. ' +
      'Return ONLY JSON: {"topics":[{"topic":"...","question":"the recurring user question","angle":"how the article should be framed to convert","keyword":"primary search keyword"}]} (5-8 topics).'
    const user = `Our product: ${prod.name} — ${prod.pitch}\n\nReal demand posts:\n${sample}`
    const res = await generateContent(system, user)
    const topics = (res?.data?.topics ?? []) as any[]
    if (!Array.isArray(topics) || topics.length === 0) return reply.code(502).send({ error: 'AI 未返回有效选题，请重试' })

    const now = Date.now()
    const ins = db.prepare(
      `INSERT INTO social_topics(product, topic, question, angle, keyword, demand_count, model, created_ts)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    const tx = db.transaction(() => {
      for (const t of topics.slice(0, 8)) {
        ins.run(product, String(t.topic || '').slice(0, 200), String(t.question || '').slice(0, 300),
          String(t.angle || '').slice(0, 500), String(t.keyword || '').slice(0, 120), rows.length, res?.model || '', now)
      }
    })
    tx()
    return { ok: true, added: Math.min(8, topics.length) }
  })

  // 信号列表（可按产品/类别/平台/最小意图分/状态/关键词过滤）
  app.get('/api/internal/social/signals', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as Record<string, string>
    const where: string[] = []
    const params: any[] = []
    if (q.product) { where.push('product = ?'); params.push(q.product) }
    if (q.kind) { where.push('kind = ?'); params.push(q.kind) }
    if (q.platform) { where.push('platform = ?'); params.push(q.platform) }
    else { where.push("platform NOT IN ('shopify','appstore')") } // 评论源默认只进「竞品痛点」，不进信号流（不可回复）；按平台筛选仍可查看
    if (q.status) { where.push('status = ?'); params.push(q.status) }
    else { where.push("status NOT IN ('dropped','ignored','reviewed','mismatch')") } // 默认隐藏：被清理/忽略(跳过)/已起草或批准/信号不符（避免重复；'reviewed' 可在状态筛选里回看）
    if (q.tier) { where.push('intent_tier = ?'); params.push(q.tier) } // 热/温/冷
    if (q.minIntent) { where.push('intent >= ?'); params.push(Number(q.minIntent)) }
    if (q.q && q.q.trim()) { where.push('(title LIKE ? OR body LIKE ? OR author LIKE ?)'); const w = `%${q.q.trim()}%`; params.push(w, w, w) }
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
        `SELECT d.*, s.title AS post_title, s.url AS post_url, s.platform, s.kind, s.author, s.intent, s.zh AS post_zh,
              s.actor_type, s.intent_tier, s.pain_type, s.solvable, s.reco_play
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
    // 批准/已发后，确保对应信号移出信号流（不再重复出现）
    if (b.status === 'approved' || b.status === 'posted') {
      const d = db.prepare('SELECT signal_id FROM social_drafts WHERE id=?').get(id) as { signal_id: string } | undefined
      if (d?.signal_id) db.prepare("UPDATE social_intel SET status='reviewed' WHERE id=? AND status NOT IN ('ignored','mismatch')").run(d.signal_id)
    }
    return { ok: true }
  })

  // 标记信号状态（忽略/已读）
  app.post('/api/internal/social/signal/:id/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = (req.params as any).id as string
    const b = req.body as { status?: string }
    const allowed = ['new', 'reviewed', 'ignored', 'mismatch']
    if (!b?.status || !allowed.includes(b.status)) return reply.code(400).send({ error: 'invalid status' })
    // 「信号不符」= 学习：记录作者为抑制候选（同作者≥2次→以后自动丢），标题留作分类器反例。
    // 「忽略」= 纯跳过，不记录任何学习信号（保持输入干净）。
    if (b.status === 'mismatch') {
      const sig = db.prepare('SELECT product, author FROM social_intel WHERE id=?').get(id) as { product: string; author: string } | undefined
      if (sig?.author && sig.author.trim()) {
        db.prepare(
          `INSERT INTO social_suppress(product, kind, value, hits, created_ts) VALUES(?, 'author', ?, 1, ?)
           ON CONFLICT(product, kind, value) DO UPDATE SET hits = hits + 1`,
        ).run(sig.product, sig.author.trim(), Date.now())
      }
    }
    db.prepare('UPDATE social_intel SET status=? WHERE id=?').run(b.status, id)
    return { ok: true }
  })

  // 抑制规则：列出
  app.get('/api/internal/social/suppress', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const items = db.prepare('SELECT * FROM social_suppress ORDER BY hits DESC, created_ts DESC LIMIT 200').all()
    return { items }
  })
  // 抑制规则：解除
  app.delete('/api/internal/social/suppress/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    db.prepare('DELETE FROM social_suppress WHERE id=?').run(Number((req.params as any).id))
    return { ok: true }
  })

  // 中文解读：为单条信号即时生成（面板"中文解读"按钮）
  app.post('/api/internal/social/translate', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = req.body as { signalId?: string }
    if (!b?.signalId) return reply.code(400).send({ error: 'signalId required' })
    if (!openrouterEnabled()) return reply.code(400).send({ error: 'OPENROUTER_API_KEY 未配置' })
    const zh = await translateOne(b.signalId)
    return zh ? { ok: true, zh } : { ok: false, error: '生成失败' }
  })

  // 中文解读：手动触发一批回填
  app.post('/api/internal/social/translate-batch', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const n = await translateBatch()
    return { ok: true, translated: n }
  })

  // 清空某产品的所有信号/草稿（重对齐后做一轮"全新采集"用）
  app.post('/api/internal/social/purge', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = (req.body || {}) as { product?: string }
    const product = String(b.product || '').trim()
    if (!product) return reply.code(400).send({ error: 'product required' })
    const drafts = db
      .prepare('DELETE FROM social_drafts WHERE signal_id IN (SELECT id FROM social_intel WHERE product=?)')
      .run(product).changes
    const topics = db.prepare('DELETE FROM social_topics WHERE product=?').run(product).changes
    const signals = db.prepare('DELETE FROM social_intel WHERE product=?').run(product).changes
    return { ok: true, deleted: { signals, drafts, topics } }
  })

  // 手动触发一轮采集（管理员调试用）
  app.post('/api/internal/social/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    void runSocialIntelOnce()
    return { ok: true, message: '已触发一轮采集（异步）' }
  })

  // ── 自定义采集需求 ───────────────────────────────────────────────────────
  // 立即采集一条自定义查询；save=true 时同时保存为可定时轮询的需求。
  app.post('/api/internal/social/custom', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = (req.body || {}) as {
      label?: string; product?: string; platform?: string; kind?: string
      query?: string; subreddits?: string; save?: boolean
    }
    const query = String(b.query || '').trim()
    if (query.length < 2) return reply.code(400).send({ error: 'query 至少 2 个字符' })
    const platform = b.platform === 'x' ? 'x' : 'reddit'
    const kind = ['brand', 'competitor', 'demand'].includes(String(b.kind)) ? String(b.kind) : 'demand'
    const product = (String(b.product || 'custom').trim() || 'custom').slice(0, 40)
    const subreddits = String(b.subreddits || '').split(',').map((s) => s.trim()).filter(Boolean)

    let savedId: number | undefined
    if (b.save) {
      const info = db
        .prepare(
          `INSERT INTO social_custom_query(label, product, platform, kind, query, subreddits, active, created_ts)
           VALUES(?,?,?,?,?,?,1,?)`,
        )
        .run(String(b.label || query).slice(0, 120), product, platform, kind, query, subreddits.join(','), Date.now())
      savedId = Number(info.lastInsertRowid)
    }
    let added = 0
    let error: string | undefined
    try {
      added = await runCustomQuery({ product, platform, kind, query, subreddits })
    } catch (e) {
      error = (e as Error).message
    }
    if (savedId) db.prepare('UPDATE social_custom_query SET last_run_ts=? WHERE id=?').run(Date.now(), savedId)
    return { ok: !error, added, savedId, error }
  })

  // 已保存的自定义需求列表
  app.get('/api/internal/social/custom', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const items = db.prepare('SELECT * FROM social_custom_query ORDER BY created_ts DESC LIMIT 200').all()
    return { items }
  })

  // 启用/停用一条已保存需求
  app.post('/api/internal/social/custom/:id/toggle', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as any).id)
    db.prepare('UPDATE social_custom_query SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(id)
    return { ok: true }
  })

  // 立即重跑一条已保存需求
  app.post('/api/internal/social/custom/:id/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as any).id)
    const row = db.prepare('SELECT * FROM social_custom_query WHERE id=?').get(id) as any
    if (!row) return reply.code(404).send({ error: 'not found' })
    let added = 0
    let error: string | undefined
    try {
      added = await runCustomQuery({
        product: row.product, platform: row.platform, kind: row.kind,
        query: row.query, subreddits: String(row.subreddits || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      })
    } catch (e) { error = (e as Error).message }
    db.prepare('UPDATE social_custom_query SET last_run_ts=? WHERE id=?').run(Date.now(), id)
    return { ok: !error, added, error }
  })

  // 删除一条已保存需求
  app.delete('/api/internal/social/custom/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    db.prepare('DELETE FROM social_custom_query WHERE id=?').run(Number((req.params as any).id))
    return { ok: true }
  })

  console.log('[social-intel] internal panel registered at /internal/social')
}
