import { FastifyInstance } from 'fastify'
import { db, stmt } from './db.ts'
import { bus, TransferEvent } from './bus.ts'
import { aggregateEntities } from './aggregate.ts'
import { twitchEnabled } from './collectors/twitch.ts'
import { redditEnabled } from './collectors/reddit.ts'
import { userFromRequest } from './auth.ts'
import { config } from './config.ts'

export async function registerApi(app: FastifyInstance) {
  // ── health / meta ───────────────────────────────────────────────────────────
  app.get('/api/health', async () => {
    const tx = (db.prepare('SELECT COUNT(*) n FROM transfers').get() as any).n
    const wl = (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE active=1').get() as any).n
    const oldest = (db.prepare('SELECT MIN(ts) t FROM transfers').get() as any).t ?? null
    const sv = (k: string) =>
      Number((db.prepare('SELECT value FROM sync_state WHERE key=?').get(k) as any)?.value ?? 0)
    const anchor = sv('backfill:anchor')
    const cursor = sv('backfill:cursor') || anchor
    const targetBlocks = Math.ceil((config.deepBackfillDays * 86_400_000) / 12_000)
    const backfillPct = anchor ? Math.min(100, Math.round(((anchor - cursor) / targetBlocks) * 100)) : 0
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
    const data = {
      totalVolume: totals.vol ?? 0,
      volume7d: vol7,
      totalTransfers: totals.tx ?? 0,
      uniquePlayers: totals.players ?? 0,
      reserves,
      entities: wl,
      liveStreamers,
      chainSplit: chains.map((c) => ({ chain: c.chain, value: c.v ?? 0 })),
    }
    statsCache = { data, at: Date.now() }
    return data
  })

  // ── entities (a.k.a. casinos/exchanges) leaderboard ──────────────────────────
  app.get('/api/entities', async (req) => {
    const { category } = req.query as { category?: string }
    let list = aggregateEntities()
    if (category && category !== 'all') list = list.filter((e) => e.category === category)
    return list
  })

  // alias kept for the casino-centric UI
  app.get('/api/casinos', async () => aggregateEntities())

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
    const q = req.query as { days?: string }
    const days = Math.min(30, Math.max(1, Number(q.days ?? 7)))
    const now = Date.now()
    const from = now - days * 86_400_000
    const bucketMs = days <= 7 ? 6 * 3600_000 : 24 * 3600_000 // 6h buckets ≤7d, daily beyond
    const rows = db
      .prepare(
        `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
                SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) deposits,
                SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) withdrawals
         FROM transfers WHERE ts >= ? GROUP BY b ORDER BY b`,
      )
      .all(from, bucketMs, from) as any[]
    const map = new Map(rows.map((r) => [r.b, r]))
    const out: { t: number; deposits: number; withdrawals: number }[] = []
    const buckets = Math.ceil((now - from) / bucketMs)
    for (let i = 0; i < buckets; i++) {
      const r = map.get(i)
      out.push({ t: from + i * bucketMs, deposits: r?.deposits ?? 0, withdrawals: r?.withdrawals ?? 0 })
    }
    return out
  })

  // ── flow intelligence: tx-size distribution (REAL, derived) ──────────────────
  app.get('/api/flow', async () => {
    const d7 = Date.now() - 7 * 86_400_000
    const buckets = [
      { name: 'Whale', min: 100_000, max: Infinity, color: '#f5b100' },
      { name: 'High Roller', min: 10_000, max: 100_000, color: '#8b3df0' },
      { name: 'Regular', min: 500, max: 10_000, color: '#2ee6a6' },
      { name: 'Casual', min: 0, max: 500, color: '#5b8cff' },
    ]
    const rows = db.prepare('SELECT usd, counterparty FROM transfers WHERE ts>=?').all(d7) as any[]
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
    const entities = aggregateEntities()
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
    const myVotes = user
      ? new Map(
          (db.prepare('SELECT watch_id, vote FROM votes WHERE user_id = ?').all(user.id) as any[]).map(
            (v) => [v.watch_id, v.vote],
          ),
        )
      : new Map()
    return {
      redditEnabled: redditEnabled(),
      entities: entities.map((e) => {
        const m = mMap.get(e.label)
        return {
          ...e,
          mentions7d: m?.mentions ?? 0,
          mentionsPos: m?.pos ?? 0,
          mentionsNeg: m?.neg ?? 0,
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
    if (chain !== 'ETH' && chain !== 'TRON') return reply.code(400).send({ error: 'chain must be ETH or TRON' })
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
