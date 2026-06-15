import { FastifyInstance } from 'fastify'
import { db, stmt, stateGet } from './db.ts'
import { bus, TransferEvent } from './bus.ts'
import { aggregateEntities, aggregateBrands } from './aggregate.ts'
import { reserveSeries } from './reservehistory.ts'
import { twitchEnabled } from './collectors/twitch.ts'
import { redditEnabled } from './collectors/reddit.ts'
import { newsEnabled } from './collectors/news.ts'
import { telegramSubs } from './collectors/telegram.ts'
import { brandKey } from './casinometa.ts'
import { userFromRequest } from './auth.ts'
import { config } from './config.ts'

export async function registerApi(app: FastifyInstance) {
  // ── health / meta ───────────────────────────────────────────────────────────
  app.get('/api/health', async () => {
    // MUST stay cheap — Railway's healthcheck hits this constantly. COUNT(*) over
    // the (multi-million-row) transfers table is a full scan that blocks the event
    // loop and times out the healthcheck under indexing load; MAX(id) is instant
    // (PK btree) and gives the cumulative-indexed figure we display.
    const tx = (db.prepare('SELECT MAX(id) n FROM transfers').get() as any).n ?? 0
    const wl = (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE active=1').get() as any).n
    const oldest = (db.prepare('SELECT MIN(ts) t FROM transfers').get() as any).t ?? null
    const sv = (k: string) =>
      Number((db.prepare('SELECT value FROM sync_state WHERE key=?').get(k) as any)?.value ?? 0)
    const anchor = sv('backfill:anchor')
    // ETH backfill is split into a casino (priority) + exchange segment; report
    // the casino segment's progress as the headline (the old combined
    // backfill:cursor is deprecated and never set on current builds)
    const casCursor = sv('backfill:cas:cursor') || sv('backfill:cursor') || anchor
    const targetBlocks = Math.ceil((config.deepBackfillDays * 86_400_000) / 12_000)
    const backfillPct = anchor && casCursor < anchor ? Math.min(100, Math.round(((anchor - casCursor) / targetBlocks) * 100)) : 0
    return {
      ok: true,
      env: config.nodeEnv,
      watchlist: wl,
      transfers: tx,
      evmLastBlock: sv('evm:lastBlock'),
      historyDays: oldest ? (Date.now() - oldest) / 86_400_000 : 0,
      backfillPct,
      twitch: twitchEnabled(),
      time: Date.now(),
    }
  })

  // ── global stats (all REAL sums) ─────────────────────────────────────────────
  // COUNT(DISTINCT counterparty) is a full scan over millions of rows — cache
  // the result so polling clients don't recompute it on every request.
  let statsCache: { data: unknown; at: number } | null = null
  app.get('/api/stats', async () => {
    if (statsCache && Date.now() - statsCache.at < config.aggregateMs) return statsCache.data
    const now = Date.now()
    const d7 = now - 7 * 86_400_000
    const totals = db
      .prepare('SELECT COUNT(*) tx, SUM(usd) vol, COUNT(DISTINCT counterparty) players FROM transfers')
      .get() as any
    const vol7 = (db.prepare('SELECT SUM(usd) v FROM transfers WHERE ts>=?').get(d7) as any).v ?? 0
    const reserves = (db.prepare('SELECT SUM(usd) v FROM balances').get() as any).v ?? 0
    const wl = (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE active=1').get() as any).n
    const chains = db
      .prepare('SELECT chain, SUM(usd) v FROM transfers WHERE ts>=? GROUP BY chain')
      .all(d7) as any[]
    const liveStreamers = (db.prepare('SELECT COUNT(*) n FROM streamers WHERE live=1').get() as any).n
    // casino-only breakdown — the iGaming headline figures, with exchange &
    // whale flow excluded (transfers carry their entity's category)
    const cas = db
      .prepare(
        `SELECT COUNT(*) tx, SUM(usd) vol, COUNT(DISTINCT counterparty) players,
                SUM(CASE WHEN ts>=? THEN usd ELSE 0 END) vol7
         FROM transfers WHERE category='casino'`,
      )
      .get(d7) as any
    const casReserves = (
      db
        .prepare(
          `SELECT SUM(b.usd) v FROM balances b JOIN watchlist w ON w.id=b.watch_id WHERE w.category='casino'`,
        )
        .get() as any
    ).v ?? 0
    const casEntities = (
      db.prepare("SELECT COUNT(*) n FROM watchlist WHERE active=1 AND category='casino'").get() as any
    ).n
    const casChains = db
      .prepare("SELECT chain, SUM(usd) v FROM transfers WHERE category='casino' AND ts>=? GROUP BY chain")
      .all(d7) as any[]
    const data = {
      totalVolume: totals.vol ?? 0,
      volume7d: vol7,
      totalTransfers: totals.tx ?? 0,
      uniquePlayers: totals.players ?? 0,
      reserves,
      entities: wl,
      liveStreamers,
      chainSplit: chains.map((c) => ({ chain: c.chain, value: c.v ?? 0 })),
      casino: {
        totalVolume: cas.vol ?? 0,
        volume7d: cas.vol7 ?? 0,
        totalTransfers: cas.tx ?? 0,
        uniquePlayers: cas.players ?? 0,
        reserves: casReserves,
        entities: casEntities,
        chainSplit: casChains.map((c) => ({ chain: c.chain, value: c.v ?? 0 })),
      },
    }
    statsCache = { data, at: Date.now() }
    return data
  })

  // ── entities (a.k.a. casinos/exchanges) leaderboard ──────────────────────────
  app.get('/api/entities', async (req) => {
    const { category } = req.query as { category?: string }
    // the generic leaderboard intentionally spans every category by default
    return aggregateEntities(category ?? 'all')
  })

  // casino-centric leaderboard — defaults to iGaming only so exchanges/whales
  // never get grouped in with casinos. ?category=all|exchange|whale to override.
  app.get('/api/casinos', async (req) => {
    const { category } = req.query as { category?: string }
    return aggregateEntities(category ?? 'casino')
  })

  // brand-aggregated leaderboard — wallets clustered by known attribution.
  // Also casino-only by default (exchanges/whales excluded unless requested).
  app.get('/api/brands', async (req) => {
    const { category } = req.query as { category?: string }
    return aggregateBrands(category ?? 'casino')
  })

  // public, non-sensitive aggregate counts — landing-page social proof + a health
  // probe for the directory pipelines (contact data stays behind the gated routes)
  app.get('/api/directory/overview', async () => {
    const d = db
      .prepare(
        `SELECT COUNT(*) total, COALESCE(SUM(site_ok),0) site, COALESCE(SUM(tp_rating IS NOT NULL),0) rated,
                COALESCE(SUM(CASE WHEN last_checked>0 THEN 1 ELSE 0 END),0) checked FROM casino_directory`,
      )
      .get() as any
    let queue = { fetched: 0, pending: 0 }
    try {
      queue = db.prepare("SELECT COALESCE(SUM(done=1),0) fetched, COALESCE(SUM(done=0),0) pending FROM crawl_queue").get() as any
    } catch {
      /* table may not exist on a very old db */
    }
    let tpLast: unknown = null
    try {
      const v = stateGet('trustpilot:last')
      if (v) tpLast = JSON.parse(v)
    } catch {
      /* ignore */
    }
    return { ...d, guruFetched: queue.fetched, guruPending: queue.pending, tpLast }
  })

  // ── casino directory (login-gated — outreach/contact data) ───────────────────
  const dirWhere = (filter?: string) =>
    filter === 'withEmail' ? 'email_ok=1' : filter === 'withX' ? 'x_ok=1' : filter === 'included' ? 'site_ok=1 AND x_ok=1 AND email_ok=1' : filter === 'live' ? 'site_ok=1' : '1=1'

  app.get('/api/directory', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const { filter, q } = req.query as { filter?: string; q?: string }
    const args: any[] = []
    let sql = `SELECT domain,name,website,twitter,email,site_ok,x_ok,email_ok,source,status,tp_rating,tp_reviews,last_checked FROM casino_directory WHERE ${dirWhere(filter)}`
    if (q) {
      sql += ' AND (name LIKE ? OR domain LIKE ?)'
      args.push(`%${q}%`, `%${q}%`)
    }
    sql += ' ORDER BY site_ok DESC, email_ok DESC, x_ok DESC, COALESCE(tp_reviews,0) DESC, name LIMIT 5000'
    const rows = db.prepare(sql).all(...args)
    const stats = db
      .prepare(
        `SELECT COUNT(*) total, COALESCE(SUM(site_ok),0) site, COALESCE(SUM(x_ok),0) x, COALESCE(SUM(email_ok),0) email,
                COALESCE(SUM(CASE WHEN site_ok=1 AND x_ok=1 AND email_ok=1 THEN 1 ELSE 0 END),0) included,
                COALESCE(SUM(CASE WHEN tp_rating IS NOT NULL THEN 1 ELSE 0 END),0) rated,
                COALESCE(SUM(CASE WHEN last_checked>0 THEN 1 ELSE 0 END),0) checked FROM casino_directory`,
      )
      .get()
    return { stats, rows }
  })

  app.get('/api/directory/export.csv', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const { filter } = req.query as { filter?: string }
    const rows = db.prepare(`SELECT name,website,twitter,email,tp_rating,tp_reviews FROM casino_directory WHERE ${dirWhere(filter ?? 'live')} ORDER BY name`).all() as any[]
    const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const csv = ['name,website,x,email,trustpilot,reviews', ...rows.map((r) => [r.name, r.website, r.twitter ? `https://x.com/${r.twitter}` : '', r.email, r.tp_rating ?? '', r.tp_reviews ?? ''].map(esc).join(','))].join('\n')
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename=casino-directory.csv')
    return csv
  })

  // reserve-adequacy (solvency) trend for one casino brand — daily snapshots
  app.get('/api/reserves', async (req) => {
    const { brand, days } = req.query as { brand?: string; days?: string }
    if (!brand) return { series: [] }
    return { series: reserveSeries(brand, Math.min(180, Math.max(7, Number(days ?? 60)))) }
  })

  // ── transfer feed (REAL) with filters ────────────────────────────────────────
  app.get('/api/transfers', async (req) => {
    const q = req.query as Record<string, string>
    const limit = Math.min(Number(q.limit ?? 60), 300)
    const where: string[] = []
    const args: any[] = []
    if (q.chain && q.chain !== 'ALL') { where.push('chain = ?'); args.push(q.chain) }
    if (q.dir && q.dir !== 'ALL') { where.push('direction = ?'); args.push(q.dir === 'deposit' ? 'in' : q.dir === 'withdrawal' ? 'out' : q.dir) }
    if (q.min) { where.push('usd >= ?'); args.push(Number(q.min)) }
    if (q.watch_id) { where.push('watch_id = ?'); args.push(Number(q.watch_id)) }
    const sql = `SELECT chain, tx_hash, token, from_addr, to_addr, counterparty, amount, usd,
                        watch_id, label, category, direction, block, ts
                 FROM transfers ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY ts DESC LIMIT ?`
    return db.prepare(sql).all(...args, limit)
  })

  // ── time-series flow chart (REAL) — ?days=7|14|30, bucket scales with window ─
  app.get('/api/series', async (req) => {
    const q = req.query as { days?: string; category?: string }
    const days = Math.min(30, Math.max(1, Number(q.days ?? 7)))
    const now = Date.now()
    const from = now - days * 86_400_000
    const bucketMs = days <= 7 ? 6 * 3600_000 : 24 * 3600_000 // 6h buckets ≤7d, daily beyond
    const catFilter = q.category && q.category !== 'all' ? ' AND category = ?' : ''
    const catArg = catFilter ? [q.category] : []
    const rows = db
      .prepare(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) deposits,
                SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) withdrawals
         FROM transfers WHERE ts >= ?${catFilter} GROUP BY b ORDER BY b`,
      )
      .all(from, bucketMs, from, ...catArg) as any[]
    const map = new Map(rows.map((r) => [r.b, r]))
    const out: { t: number; deposits: number; withdrawals: number }[] = []
    const buckets = Math.ceil((now - from) / bucketMs)
    for (let i = 0; i < buckets; i++) {
      const r = map.get(i)
      out.push({ t: from + i * bucketMs, deposits: r?.deposits ?? 0, withdrawals: r?.withdrawals ?? 0 })
    }
    return out
  })

  // ── per-entity daily volume series, split by chain (REAL) ───────────────────
  // ?days=30 — daily buckets of indexed volume per chain for one watch entry.
  // An EVM entity's single watch row accrues transfers from every EVM chain,
  // so this surfaces the entity's real multi-chain history.
  app.get('/api/entity/:id/series', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { days?: string }
    const days = Math.min(90, Math.max(7, Number(q.days ?? 30)))
    const now = Date.now()
    const from = now - days * 86_400_000
    const rows = db
      .prepare(
        `SELECT chain, CAST((ts - ?) / 86400000 AS INTEGER) AS b, SUM(usd) v
         FROM transfers WHERE watch_id = ? AND ts >= ? GROUP BY chain, b`,
      )
      .all(from, Number(id), from) as { chain: string; b: number; v: number }[]
    const chains = [...new Set(rows.map((r) => r.chain))].sort()
    const byBucket = new Map<number, Record<string, number>>()
    for (const r of rows) {
      const o = byBucket.get(r.b) ?? {}
      o[r.chain] = r.v ?? 0
      byBucket.set(r.b, o)
    }
    const out: ({ t: number } & Record<string, number>)[] = []
    for (let i = 0; i < days; i++) {
      const o = byBucket.get(i) ?? {}
      out.push({ t: from + i * 86_400_000, ...Object.fromEntries(chains.map((c) => [c, o[c] ?? 0])) } as any)
    }
    return { chains, series: out }
  })

  // ── per-entity money-flow graph: sources → entity → destinations ─────────────
  // Counterparties that are themselves watched are named; the rest roll up into
  // an "Other …" bucket. Powers the Sankey on the casino detail view.
  app.get('/api/entity/:id/flow', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { days?: string }
    const days = Math.min(90, Math.max(7, Number(q.days ?? 30)))
    const since = Date.now() - days * 86_400_000
    const wid = Number(id)
    const ent = db.prepare('SELECT label FROM watchlist WHERE id=?').get(wid) as any
    if (!ent) return { entity: null, sources: [], sinks: [] }

    const side = (direction: 'in' | 'out') => {
      const rows = db
        .prepare(
          `SELECT t.counterparty AS addr, w2.label AS label, SUM(t.usd) AS usd, COUNT(*) AS n
           FROM transfers t
           LEFT JOIN watchlist w2 ON w2.address = t.counterparty AND w2.active = 1
           WHERE t.watch_id = ? AND t.direction = ? AND t.ts >= ?
           GROUP BY t.counterparty ORDER BY usd DESC`,
        )
        .all(wid, direction, since) as { addr: string; label: string | null; usd: number; n: number }[]
      const named = rows.filter((r) => r.label)
      const anon = rows.filter((r) => !r.label)
      const top = named.slice(0, 6).map((r) => ({ name: r.label as string, usd: r.usd, named: true }))
      // fold remaining named + all anonymous into buckets
      const otherNamed = named.slice(6).reduce((s, r) => s + r.usd, 0)
      const anonUsd = anon.reduce((s, r) => s + r.usd, 0)
      const out = [...top]
      if (otherNamed > 0) out.push({ name: 'Other entities', usd: otherNamed, named: false })
      if (anonUsd > 0) out.push({ name: direction === 'in' ? `Depositors (${anon.length})` : `Withdrawers (${anon.length})`, usd: anonUsd, named: false })
      return out
    }
    return { entity: ent.label, days, sources: side('in'), sinks: side('out') }
  })

  // ── flow intelligence: tx-size distribution (REAL, derived) ──────────────────
  // Casino-only by default so exchange/whale flow doesn't pollute the player
  // segmentation; ?category=all|exchange|… to widen.
  app.get('/api/flow', async (req) => {
    const { category } = req.query as { category?: string }
    const cat = category ?? 'casino'
    const d7 = Date.now() - 7 * 86_400_000
    const buckets = [
      { name: 'Whale', min: 100_000, max: Infinity, color: '#f5b100' },
      { name: 'High Roller', min: 10_000, max: 100_000, color: '#8b3df0' },
      { name: 'Regular', min: 500, max: 10_000, color: '#2ee6a6' },
      { name: 'Casual', min: 0, max: 500, color: '#5b8cff' },
    ]
    const catFilter = cat && cat !== 'all' ? ' AND category = ?' : ''
    const catArg = catFilter ? [cat] : []
    const rows = db
      .prepare(`SELECT usd, counterparty FROM transfers WHERE ts>=?${catFilter}`)
      .all(d7, ...catArg) as any[]
    const res = buckets.map((b) => {
      const inB = rows.filter((r) => r.usd >= b.min && r.usd < b.max)
      const vol = inB.reduce((s, r) => s + r.usd, 0)
      const players = new Set(inB.map((r) => r.counterparty)).size
      return { ...b, max: undefined, count: inB.length, volume: vol, players }
    })
    const totalVol = res.reduce((s, b) => s + b.volume, 0) || 1
    return res.map((b) => ({ ...b, share: (b.volume / totalVol) * 100 }))
  })

  // ── streamers (REAL: Kick keyless + Twitch when configured) ──────────────────
  app.get('/api/streamers', async () => {
    const live = db.prepare('SELECT * FROM streamers WHERE live=1 ORDER BY viewers DESC LIMIT 48').all()
    const offline = db
      .prepare('SELECT * FROM streamers WHERE live=0 ORDER BY followers DESC LIMIT 24')
      .all()
    const roster = (db.prepare('SELECT COUNT(*) n FROM streamer_roster WHERE active=1').get() as any).n
    return { enabled: true, twitch: twitchEnabled(), roster, streamers: live, offline }
  })

  // ── streamer roster management (auth required) ───────────────────────────────
  app.post('/api/roster', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const b = req.body as { platform?: string; slug?: string }
    const platform = b?.platform === 'Twitch' ? 'Twitch' : 'Kick'
    const slug = b?.slug?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!slug) return reply.code(400).send({ error: 'slug required' })
    db.prepare(
      'INSERT INTO streamer_roster(platform, slug, active, created_at) VALUES(?, ?, 1, ?) ON CONFLICT(platform, slug) DO UPDATE SET active=1',
    ).run(platform, slug, Date.now())
    return { ok: true }
  })

  // ── sentiment: blended trust + community votes + real social mentions ────────
  app.get('/api/sentiment', async (req) => {
    const user = userFromRequest(req)
    const { category } = req.query as { category?: string }
    // trust / reviews / social sentiment are casino concepts — default to
    // iGaming only so exchange & whale wallets don't pollute the sentiment board
    const entities = aggregateEntities(category ?? 'casino')
    const d7 = Date.now() - 7 * 86_400_000
    const mentionRows = db
      .prepare(
        `SELECT watch_label,
                COUNT(*) mentions,
                SUM(CASE WHEN sentiment > 0.15 THEN 1 ELSE 0 END) pos,
                SUM(CASE WHEN sentiment < -0.15 THEN 1 ELSE 0 END) neg
         FROM mentions WHERE ts >= ? GROUP BY watch_label`,
      )
      .all(d7) as { watch_label: string; mentions: number; pos: number; neg: number }[]
    const mMap = new Map(mentionRows.map((m) => [m.watch_label, m]))
    // global mention-source breakdown (news / press / telegram / reddit)
    const sourceRows = db
      .prepare('SELECT source, COUNT(*) n FROM mentions WHERE ts >= ? GROUP BY source')
      .all(d7) as { source: string; n: number }[]
    const subs = telegramSubs()
    const myVotes = user
      ? new Map(
          (db.prepare('SELECT watch_id, vote FROM votes WHERE user_id = ?').all(user.id) as any[]).map(
            (v) => [v.watch_id, v.vote],
          ),
        )
      : new Map()
    return {
      redditEnabled: redditEnabled(),
      newsEnabled: newsEnabled(),
      mentionsBySource: Object.fromEntries(sourceRows.map((r) => [r.source, r.n])),
      entities: entities.map((e) => {
        const m = mMap.get(e.label)
        return {
          ...e,
          mentions7d: m?.mentions ?? 0,
          mentionsPos: m?.pos ?? 0,
          mentionsNeg: m?.neg ?? 0,
          telegramSubs: subs.get(brandKey(e.label)) ?? 0,
          myVote: myVotes.get(e.id) ?? 0,
        }
      }),
    }
  })

  // ── watchlist CRUD ───────────────────────────────────────────────────────────
  app.get('/api/watchlist', async () =>
    db.prepare('SELECT id, chain, address, label, category, active, created_at FROM watchlist ORDER BY created_at DESC').all(),
  )
  app.post('/api/watchlist', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const b = req.body as { chain?: string; address?: string; label?: string; category?: string }
    if (!b?.chain || !b?.address || !b?.label) {
      return reply.code(400).send({ error: 'chain, address and label are required' })
    }
    const chain = b.chain.toUpperCase()
    // ETH covers every EVM chain (the indexers watch each 0x address on all of
    // them); TRON and SOL have their own collectors.
    if (!['ETH', 'TRON', 'SOL'].includes(chain)) {
      return reply.code(400).send({ error: 'chain must be ETH (covers all EVM chains), TRON or SOL' })
    }
    const address = chain === 'ETH' ? b.address.toLowerCase().trim() : b.address.trim()
    stmt.addWatch.run(chain, address, b.label.trim(), b.category ?? 'casino', Date.now())
    return { ok: true }
  })
  app.delete('/api/watchlist/:id', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const { id } = req.params as { id: string }
    db.prepare('UPDATE watchlist SET active=0 WHERE id=?').run(Number(id))
    return { ok: true }
  })

  // ── alerts: user-defined rules + fired events ────────────────────────────────
  app.get('/api/alerts/rules', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    return db.prepare('SELECT * FROM alert_rules WHERE user_id=? ORDER BY created_at DESC').all(user.id)
  })
  app.post('/api/alerts/rules', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const b = req.body as { kind?: string; scope?: string; scopeLabel?: string; threshold?: number; windowH?: number; webhook?: string }
    const kind = b?.kind ?? ''
    if (!['whale', 'netflow', 'reserve_drop'].includes(kind)) return reply.code(400).send({ error: 'invalid kind' })
    if (!(Number(b?.threshold) > 0)) return reply.code(400).send({ error: 'threshold must be > 0' })
    db.prepare(
      `INSERT INTO alert_rules(user_id, kind, scope, scope_label, threshold, window_h, webhook, active, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(user.id, kind, b.scope || 'all', b.scopeLabel ?? null, Number(b.threshold), Number(b.windowH ?? 24), b.webhook?.trim() || null, Date.now())
    return { ok: true }
  })
  app.delete('/api/alerts/rules/:id', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const { id } = req.params as { id: string }
    db.prepare('DELETE FROM alert_rules WHERE id=? AND user_id=?').run(Number(id), user.id)
    return { ok: true }
  })
  app.get('/api/alerts/events', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const q = req.query as { limit?: string }
    const limit = Math.min(100, Number(q.limit ?? 50))
    return db.prepare('SELECT * FROM alert_events WHERE user_id=? ORDER BY ts DESC LIMIT ?').all(user.id, limit)
  })

  // ── SSE live transfer stream ─────────────────────────────────────────────────
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    reply.raw.write(': connected\n\n')
    const onTx = (t: TransferEvent) => reply.raw.write(`data: ${JSON.stringify(t)}\n\n`)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    bus.on('transfer', onTx)
    req.raw.on('close', () => {
      clearInterval(ping)
      bus.off('transfer', onTx)
    })
  })
}
