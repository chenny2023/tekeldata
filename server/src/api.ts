import { FastifyInstance } from 'fastify'
import { db, stmt, stateGet } from './db.ts'
import { bus, TransferEvent } from './bus.ts'
import { aggregateEntities, aggregateBrands } from './aggregate.ts'
import { reserveSeries } from './reservehistory.ts'
import { twitchEnabled } from './collectors/twitch.ts'
import { redditEnabled } from './collectors/reddit.ts'
import { probeTier } from './collectors/unlocker.ts'
import { arkhamFetch } from './net.ts'
import { getProfile } from './streamerprofiles.ts'
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

  // ── aggregate cache ──────────────────────────────────────────────────────────
  // aggregateEntities/aggregateBrands are heavy synchronous scans; better-sqlite3
  // is single-threaded, so recomputing them on EVERY polling request blocks the
  // event loop and makes the whole API slow/unresponsive. Cache per (fn,category)
  // and refresh at most once per aggregateMs; a background warmer keeps the hot
  // keys fresh so no user request ever pays the full compute cost.
  // Stale-while-revalidate cache. The aggregates are heavy synchronous scans and
  // better-sqlite3 is single-threaded, so the OLD behaviour — recompute on the
  // request that finds the entry expired — meant whichever unlucky user hit a cold
  // key paid the full 10–40s compute AND blocked the event loop for everyone. Now a
  // request NEVER blocks on a recompute: if a cached value exists we return it
  // immediately (seconds-stale is fine for leaderboards) and refresh in the
  // background. Only the very first call for a key (cold, no value at all) computes
  // synchronously — and the warmer below pre-populates the hot keys so even that is
  // paid off the request path.
  const aggCache = new Map<string, { data: unknown; at: number; refreshing: boolean }>()
  function aggCached<T>(key: string, fn: () => T, ttl = config.aggregateMs): T {
    const now = Date.now()
    const c = aggCache.get(key)
    if (c) {
      if (now - c.at >= ttl && !c.refreshing) {
        c.refreshing = true
        setImmediate(() => {
          try {
            aggCache.set(key, { data: fn(), at: Date.now(), refreshing: false })
          } catch {
            c.refreshing = false // let the next request retry the refresh
          }
        })
      }
      return c.data as T
    }
    const data = fn() // cold: unavoidable one-time compute for this key
    aggCache.set(key, { data, at: now, refreshing: false })
    return data
  }
  // Proactively warm the keys the dashboard hits on load so no user request ever
  // pays the cold compute. Each task runs on its own setImmediate so the warmer
  // never freezes the loop in one long synchronous block. statsCache/countsCache
  // get primed here too (computeStats is defined below; warm runs async after
  // registerApi finishes, so the reference is safe).
  const warmTasks: (() => void)[] = [
    () => aggCache.set('ent:casino', { data: aggregateEntities('casino'), at: Date.now(), refreshing: false }),
    () => aggCache.set('ent:all', { data: aggregateEntities('all'), at: Date.now(), refreshing: false }),
    () => aggCache.set('brand:casino', { data: aggregateBrands('casino'), at: Date.now(), refreshing: false }),
    () => aggCache.set('coverage', { data: computeCoverage(), at: Date.now(), refreshing: false }),
    () => aggCache.set('flow:casino', { data: computeFlow('casino'), at: Date.now(), refreshing: false }),
    () => aggCache.set('series:7:all', { data: computeSeries(7, 'all'), at: Date.now(), refreshing: false }),
    () => aggCache.set('series:30:all', { data: computeSeries(30, 'all'), at: Date.now(), refreshing: false }),
    () => void computeStats(), // primes statsCache + the expensive COUNT(DISTINCT) cache
  ]
  const warm = () => {
    for (const task of warmTasks) {
      setImmediate(() => {
        try {
          task()
        } catch {
          /* a transient DB error shouldn't kill the warmer */
        }
      })
    }
  }
  setTimeout(warm, 8_000)
  setInterval(warm, Math.max(15_000, config.aggregateMs))

  // Let browsers and the CDN serve the public, non-user-specific leaderboards from
  // cache. The data moves slowly (rolling 7d/30d aggregates), so a short fresh
  // window plus a LONG stale-while-revalidate window means users are served from
  // the edge almost always and the origin is revalidated in the background — they
  // effectively never wait on a cold origin. Gated/auth and per-user endpoints
  // (sentiment carries per-user votes) are excluded.
  const PUBLIC_CACHEABLE = /^\/api\/(stats|casinos|brands|entities|coverage|protocols|predictions|sponsorships|streamers|flow|series|transfers|notifications|arkham\/reserves|directory\/overview)$/
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' && !reply.getHeader('Cache-Control') && PUBLIC_CACHEABLE.test(req.url.split('?')[0])) {
      reply.header('Cache-Control', 'public, max-age=45, stale-while-revalidate=600')
    }
    return payload
  })

  // ── global stats (all REAL sums) ─────────────────────────────────────────────
  // COUNT(DISTINCT counterparty) is a full scan over millions of rows — cache
  // the result so polling clients don't recompute it on every request.
  let statsCache: { data: unknown; at: number } | null = null
  // The two COUNT(DISTINCT counterparty) scans over 24M rows are by far the
  // costliest queries on the site; at the 30s stats TTL they could run longer than
  // the TTL itself → permanent recompute that monopolises the single thread and
  // slows the WHOLE API. They move slowly, so cache them for 10 min separately.
  let countsCache: { at: number; totals: any; cas: any } | null = null
  const expensiveCounts = (d7: number) => {
    if (countsCache && Date.now() - countsCache.at < 3600_000) return countsCache
    const totals = db.prepare('SELECT COUNT(*) tx, SUM(usd) vol, COUNT(DISTINCT counterparty) players FROM transfers').get() as any
    const cas = db
      .prepare(
        `SELECT COUNT(*) tx, SUM(usd) vol, COUNT(DISTINCT counterparty) players,
                SUM(CASE WHEN ts>=? THEN usd ELSE 0 END) vol7
         FROM transfers WHERE category='casino'`,
      )
      .get(d7) as any
    countsCache = { at: Date.now(), totals, cas }
    return countsCache
  }
  let statsRefreshing = false
  const computeStats = () => {
    const now = Date.now()
    const d7 = now - 7 * 86_400_000
    const { totals, cas } = expensiveCounts(d7)
    const vol7 = (db.prepare('SELECT SUM(usd) v FROM transfers WHERE ts>=?').get(d7) as any).v ?? 0
    const reserves = (db.prepare('SELECT SUM(usd) v FROM balances').get() as any).v ?? 0
    const wl = (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE active=1').get() as any).n
    const chains = db
      .prepare('SELECT chain, SUM(usd) v FROM transfers WHERE ts>=? GROUP BY chain')
      .all(d7) as any[]
    const liveStreamers = (db.prepare('SELECT COUNT(*) n FROM streamers WHERE live=1').get() as any).n
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
  }
  app.get('/api/stats', async () => {
    // stale-while-revalidate: never block the request on the (COUNT-DISTINCT-heavy)
    // recompute. Serve the last value instantly; refresh in the background when stale.
    if (statsCache) {
      if (Date.now() - statsCache.at >= config.aggregateMs && !statsRefreshing) {
        statsRefreshing = true
        setImmediate(() => {
          try {
            computeStats()
          } finally {
            statsRefreshing = false
          }
        })
      }
      return statsCache.data
    }
    return computeStats() // cold: first call only
  })

  // ── entities (a.k.a. casinos/exchanges) leaderboard ──────────────────────────
  app.get('/api/entities', async (req) => {
    const { category } = req.query as { category?: string }
    // the generic leaderboard intentionally spans every category by default
    const cat = category ?? 'all'
    return aggCached('ent:' + cat, () => aggregateEntities(cat))
  })

  // casino-centric leaderboard — defaults to iGaming only so exchanges/whales
  // never get grouped in with casinos. ?category=all|exchange|whale to override.
  app.get('/api/casinos', async (req) => {
    const { category } = req.query as { category?: string }
    const cat = category ?? 'casino'
    return aggCached('ent:' + cat, () => aggregateEntities(cat))
  })

  // brand-aggregated leaderboard — wallets clustered by known attribution.
  // Also casino-only by default (exchanges/whales excluded unless requested).
  app.get('/api/brands', async (req) => {
    const { category } = req.query as { category?: string }
    const cat = category ?? 'casino'
    return aggCached('brand:' + cat, () => aggregateBrands(cat))
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
    const parse = (k: string) => {
      try {
        const v = stateGet(k)
        return v ? JSON.parse(v) : null
      } catch {
        return null
      }
    }
    let arkham: any = { seeded: 0, resolved: 0, withReserves: 0 }
    try {
      arkham = db
        .prepare(
          `SELECT COUNT(*) seeded, COALESCE(SUM(CASE WHEN entity_id != '' THEN 1 ELSE 0 END),0) resolved,
                  COALESCE(SUM(CASE WHEN reserves_usd IS NOT NULL THEN 1 ELSE 0 END),0) withReserves,
                  COALESCE(SUM(CASE WHEN resolved_at>0 THEN 1 ELSE 0 END),0) searched FROM arkham_casino`,
        )
        .get()
    } catch {
      /* table may not exist yet */
    }
    return {
      ...d,
      guruFetched: queue.fetched,
      guruPending: queue.pending,
      guruLast: parse('guru:last'),
      tpLast: parse('trustpilot:last'),
      arkham,
    }
  })

  // one-off unlocker diagnostic: probe a known-good Trustpilot + Reddit URL at
  // each ScraperAPI tier so we can see which tier actually unlocks them (and what
  // it costs) instead of guessing. Costs a few credits per call — use sparingly.
  app.get('/api/directory/unlockertest', async (req) => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    const { url, tier, timeout } = req.query as { url?: string; tier?: string; timeout?: string }
    const init = { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(Number(timeout) || 90_000) }
    // flexible single probe: ?url=...&tier=premium|ultra|premium_us|... (no redeploy needed to try ideas)
    if (url) return await probeTier(url, tier || 'ultra', init)
    // default battery
    const tp = await probeTier('https://www.trustpilot.com/review/stake.com', 'ultra', init)
    const rd = []
    for (const t of ['premium', 'premium_us', 'ultra_us']) rd.push(await probeTier('https://old.reddit.com/search.json?q=stake&limit=5', t, init))
    return { trustpilot: tp, reddit: rd }
  })

  // flexible Arkham API explorer: ?path=/intelligence/address/0x... — returns the
  // raw status + body snippet so we can learn the API shape before building on it.
  app.get('/api/directory/arkhamtest', async (req) => {
    const { path } = req.query as { path?: string }
    const p = arkhamFetch(path || '/intelligence/address/0x28c6c06298d514db089934071355e5743bf21d60', { signal: AbortSignal.timeout(30_000) })
    if (!p) return { error: 'no arkham key configured' }
    try {
      const r = await p
      const body = await r.text()
      return { status: r.status, len: body.length, body: body.slice(0, 5000) }
    } catch (e) {
      return { error: (e as Error).message.slice(0, 80) }
    }
  })

  // public — headline data-coverage counts for the landing page (one cheap call)
  // The distinct-chain count is the one genuinely expensive piece: GROUP BY over
  // the 24M-row transfers table is a 30-40s full index scan when disk/loop is
  // contended (right after a deploy, or while the multi-day backfill hammers I/O).
  // It's effectively constant, so we refresh it at most hourly and keep it OUT of
  // the per-request / per-30s-warmer path — this was the sole cause of the
  // occasional ~40s coverage stalls. Seeded with the current known network count
  // so the landing page is accurate immediately. Seeding `at` to now means the
  // first (expensive) refresh runs an hour into uptime — by when the boot backfill
  // has calmed and the disk cache is hot — never during the post-deploy window.
  let chainsCache = { at: Date.now(), n: 11 }
  const computeCoverage = () => {
    const one = (sql: string): any => {
      try {
        return db.prepare(sql).get()
      } catch {
        return {}
      }
    }
    const dir = one('SELECT COUNT(*) total, COALESCE(SUM(site_ok),0) live, COALESCE(SUM(tp_rating IS NOT NULL),0) rated FROM casino_directory')
    const ark = one("SELECT COUNT(*) n, COALESCE(SUM(reserves_usd),0) usd FROM arkham_casino WHERE entity_id!='' AND reserves_usd IS NOT NULL")
    const pm = one('SELECT COUNT(*) n, COALESCE(SUM(volume),0) usd FROM prediction_market')
    const pr = one('SELECT COUNT(*) n, COALESCE(SUM(tvl),0) usd FROM onchain_protocol WHERE tvl IS NOT NULL')
    const me = one('SELECT COUNT(*) n FROM mentions')
    const str = one('SELECT COUNT(*) n FROM streamers')
    const tr = one("SELECT COUNT(DISTINCT brand_key) n FROM reviews WHERE score>0")
    if (Date.now() - chainsCache.at > 3600_000) {
      const c = one('SELECT COUNT(*) n FROM (SELECT chain FROM transfers GROUP BY chain)')
      if (c && typeof c.n === 'number' && c.n > 0) chainsCache = { at: Date.now(), n: c.n }
    }
    const chains = { n: chainsCache.n }
    return {
      casinos: dir.total ?? 0,
      sitesLive: dir.live ?? 0,
      trustpilotRated: dir.rated ?? 0,
      reservesCount: ark.n ?? 0,
      reservesUsd: ark.usd ?? 0,
      predictionMarkets: pm.n ?? 0,
      predictionVolume: pm.usd ?? 0,
      protocols: pr.n ?? 0,
      protocolTvl: pr.usd ?? 0,
      mentions: me.n ?? 0,
      streamers: str.n ?? 0,
      trustRated: tr.n ?? 0,
      chains: chains.n ?? 0,
    }
  }
  app.get('/api/coverage', async () => aggCached('coverage', computeCoverage, 300_000))

  // public — global search across tracked casinos, directory, streamers, wallets
  app.get('/api/search', async (req) => {
    const term = ((req.query as { q?: string }).q ?? '').trim()
    if (term.length < 2) return { casinos: [], directory: [], streamers: [], wallets: [] }
    const like = `%${term}%`
    const casinos = (db.prepare("SELECT DISTINCT label FROM watchlist WHERE category='casino' AND active=1 AND label LIKE ? ORDER BY label LIMIT 8").all(like) as any[]).map((c) => ({ name: c.label }))
    const directory = (db.prepare('SELECT name, domain, tp_rating FROM casino_directory WHERE name LIKE ? ORDER BY site_ok DESC, COALESCE(tp_reviews,0) DESC LIMIT 6').all(like) as any[]).map((d) => ({ name: d.name, domain: d.domain, rating: d.tp_rating }))
    const streamers = (db.prepare('SELECT DISTINCT handle, platform, followers FROM streamers WHERE handle LIKE ? ORDER BY followers DESC LIMIT 8').all(like) as any[]).map((s) => ({ handle: s.handle, platform: s.platform }))
    const wallets = (db.prepare('SELECT label, chain, address FROM watchlist WHERE active=1 AND address LIKE ? LIMIT 5').all(like) as any[]).map((w) => ({ label: w.label, chain: w.chain, address: w.address }))
    return { casinos, directory, streamers, wallets }
  })

  // public — recent noteworthy on-chain activity (whale deposits/withdrawals),
  // surfaced as the header notification feed. Real transfers, cached 1 min.
  app.get('/api/notifications', async () =>
    aggCached(
      'notifications',
      () => {
        const since = Date.now() - 48 * 3600_000
        const rows = db
          .prepare(
            `SELECT label, chain, direction, usd, ts FROM transfers
             WHERE ts >= ? AND category='casino' AND usd >= 50000
             ORDER BY ts DESC LIMIT 25`,
          )
          .all(since) as any[]
        return {
          items: rows.map((r) => ({
            type: r.direction === 'in' ? 'deposit' : 'withdrawal',
            title: `${r.direction === 'in' ? 'Large deposit' : 'Large withdrawal'} · ${r.label}`,
            detail: `$${Math.round(r.usd).toLocaleString()} on ${r.chain}`,
            ts: r.ts,
            href: '/app/blockchain',
          })),
        }
      },
      60_000,
    ),
  )

  // public — on-chain iGaming protocol landscape (prediction markets, lotteries…)
  app.get('/api/protocols', async (req) => {
    const { category } = req.query as { category?: string }
    let sql = 'SELECT slug, name, category, chains, tvl, change_1d, change_7d, mcap, url, twitter, logo FROM onchain_protocol WHERE tvl IS NOT NULL'
    const args: any[] = []
    if (category) {
      sql += ' AND category = ?'
      args.push(category)
    }
    sql += ' ORDER BY tvl DESC LIMIT 200'
    const rows = db.prepare(sql).all(...args) as any[]
    const totalTvl = rows.reduce((s, r) => s + (r.tvl || 0), 0)
    const byCategory: Record<string, number> = {}
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] || 0) + 1
    return { count: rows.length, totalTvl, byCategory, protocols: rows }
  })

  // public — top prediction markets (Polymarket): live odds + traded volume
  app.get('/api/predictions', async () => {
    const rows = db.prepare('SELECT id, question, volume, liquidity, outcomes, prices, end_date, category, url FROM prediction_market ORDER BY volume DESC LIMIT 60').all() as any[]
    const parse = (s: any) => {
      try {
        return s ? JSON.parse(s) : null
      } catch {
        return null
      }
    }
    return {
      count: rows.length,
      totalVolume: rows.reduce((s, r) => s + (r.volume || 0), 0),
      markets: rows.map((r) => ({ ...r, outcomes: parse(r.outcomes), prices: parse(r.prices) })),
    }
  })

  // public all-chain proof-of-reserves, sourced from Arkham entity portfolios.
  // On-chain balances are public data — and a strong "we cover every chain" signal.
  app.get('/api/arkham/reserves', async () => {
    const wk = Date.now() - 7 * 86400_000
    const rows = db
      .prepare(
        `SELECT a.key, a.name, a.domain, a.entity_id, a.reserves_usd, a.volume7d_usd,
           (SELECT h.reserves_usd FROM arkham_reserve_history h WHERE h.key=a.key AND h.ts <= ? ORDER BY h.ts DESC LIMIT 1) AS prev7d
         FROM arkham_casino a
         WHERE a.entity_id != '' AND a.reserves_usd IS NOT NULL
         ORDER BY a.reserves_usd DESC LIMIT 500`,
      )
      .all(wk) as { key: string; name: string; domain: string | null; entity_id: string; reserves_usd: number; volume7d_usd: number | null; prev7d: number | null }[]
    const total = rows.reduce((s, r) => s + (r.reserves_usd || 0), 0)
    const totalVol = rows.reduce((s, r) => s + (r.volume7d_usd || 0), 0)
    return {
      count: rows.length,
      totalUsd: total,
      totalVolume7d: totalVol, // Arkham-attributed cross-chain 7d throughput (a floor for the largest)
      casinos: rows.map((r) => {
        const change7d = r.prev7d && r.prev7d > 0 ? (r.reserves_usd - r.prev7d) / r.prev7d : null
        return {
          name: r.name,
          domain: r.domain,
          entityId: r.entity_id,
          reservesUsd: r.reserves_usd,
          volume7dUsd: r.volume7d_usd ?? null, // cross-chain on-chain volume (Arkham), trailing 7d
          change7d, // fraction; fills in once a week of history accrues
          solvencyAlert: change7d != null && change7d <= -0.3, // ≥30% weekly drawdown
        }
      }),
    }
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
  const computeSeries = (days: number, cat: string) => {
    const now = Date.now()
    const from = now - days * 86_400_000
    const bucketMs = days <= 7 ? 6 * 3600_000 : 24 * 3600_000 // 6h buckets ≤7d, daily beyond
    const catFilter = cat !== 'all' ? ' AND category = ?' : ''
    const catArg = catFilter ? [cat] : []
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
  }
  app.get('/api/series', async (req) => {
    const q = req.query as { days?: string; category?: string }
    const days = Math.min(30, Math.max(1, Number(q.days ?? 7)))
    const cat = q.category ?? 'all'
    return aggCached(`series:${days}:${cat}`, () => computeSeries(days, cat), 120_000)
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
  const computeFlow = (cat: string) => {
    const d7 = Date.now() - 7 * 86_400_000
    const meta = [
      { name: 'Whale', color: '#f5b100' },
      { name: 'High Roller', color: '#8b3df0' },
      { name: 'Regular', color: '#2ee6a6' },
      { name: 'Casual', color: '#5b8cff' },
    ]
    const catFilter = cat && cat !== 'all' ? ' AND category = ?' : ''
    const catArg = catFilter ? [cat] : []
    // bucket + aggregate in SQL — never pull millions of rows into JS (that
    // synchronous load froze the event loop for ~10s and ran on every request)
    const rows = db
      .prepare(
        `SELECT CASE WHEN usd >= 100000 THEN 0 WHEN usd >= 10000 THEN 1 WHEN usd >= 500 THEN 2 ELSE 3 END AS b,
                COUNT(*) cnt, SUM(usd) vol, COUNT(DISTINCT counterparty) players
         FROM transfers WHERE ts >= ?${catFilter} GROUP BY b`,
      )
      .all(d7, ...catArg) as any[]
    const byB = new Map(rows.map((r) => [r.b, r]))
    const res = meta.map((m, i) => {
      const r = byB.get(i)
      return { name: m.name, color: m.color, count: r?.cnt ?? 0, volume: r?.vol ?? 0, players: r?.players ?? 0 }
    })
    const totalVol = res.reduce((s, b) => s + b.volume, 0) || 1
    return res.map((b) => ({ ...b, share: (b.volume / totalVol) * 100 }))
  }
  app.get('/api/flow', async (req) => {
    const { category } = req.query as { category?: string }
    const cat = category ?? 'casino'
    return aggCached('flow:' + cat, () => computeFlow(cat), 120_000)
  })

  // public — streamer↔casino sponsorship graph: which casino each streamer reps,
  // aggregated into reach per brand. A unique marketing-intelligence angle.
  app.get('/api/sponsorships', async () => {
    const rows = db
      .prepare(
        `SELECT affiliation AS casino, COUNT(*) AS streamers,
                COALESCE(SUM(followers),0) AS reach, COALESCE(SUM(live),0) AS liveNow,
                COALESCE(SUM(CASE WHEN live=1 THEN viewers ELSE 0 END),0) AS liveViewers
         FROM streamers WHERE affiliation IS NOT NULL AND affiliation != ''
         GROUP BY affiliation ORDER BY reach DESC LIMIT 60`,
      )
      .all() as any[]
    const members = db
      .prepare("SELECT affiliation AS casino, handle, platform, followers, live, viewers FROM streamers WHERE affiliation IS NOT NULL AND affiliation != '' ORDER BY followers DESC")
      .all() as any[]
    const byCasino: Record<string, any[]> = {}
    for (const m of members) (byCasino[m.casino] ??= []).push(m)
    return { count: rows.length, sponsorships: rows.map((r) => ({ ...r, streamersList: (byCasino[r.casino] ?? []).slice(0, 12) })) }
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

  // ── streamer detail: curated profile (bio + socials) + live status ───────────
  app.get('/api/streamer', async (req) => {
    const { platform, slug } = req.query as { platform?: string; slug?: string }
    if (!platform || !slug) return { profile: null, live: null }
    const live = db.prepare('SELECT * FROM streamers WHERE id=?').get(`${platform.toLowerCase()}:${slug.toLowerCase()}`)
    return { profile: getProfile(platform, slug), live: live ?? null }
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
    const cat = category ?? 'casino'
    const entities = aggCached('ent:' + cat, () => aggregateEntities(cat))
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
