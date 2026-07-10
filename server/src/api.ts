import { FastifyInstance } from 'fastify'
import { db, stmt, stateGet, stateSet, externalFlowClause, attributedClause, INFRA_DENYLIST } from './db.ts'
import { bus, TransferEvent } from './bus.ts'
import { aggregateEntities, aggregateBrands, maintainedPlayers, isUnattributed } from './aggregate.ts'
import { runDataQualityChecks, lastDataQuality } from './dataquality.ts'
import { brandHistory } from './brandstore.ts'
import { renderDailyShareCard } from './content/card.ts'
import { reserveSeries } from './reservehistory.ts'
import { twitchEnabled } from './collectors/twitch.ts'
import { redditEnabled } from './collectors/reddit.ts'
import { probeTier } from './collectors/unlocker.ts'
import { arkhamFetch } from './net.ts'
import { arkhamProbe, arkhamAddressProbe } from './collectors/arkham.ts'
import { getProfile } from './streamerprofiles.ts'
import { newsEnabled } from './collectors/news.ts'
import { telegramSubs } from './collectors/telegram.ts'
import { brandKey } from './casinometa.ts'
import { userFromRequest, isAdminEmail } from './auth.ts'
import { readWorkerEnabled, workerGet, workerAll } from './readpool.ts'
import { latestMarketSnapshot } from './snapshot.ts'
import { config } from './config.ts'

export async function registerApi(app: FastifyInstance) {
  // ── health / meta ───────────────────────────────────────────────────────────
  // /api/health MUST respond instantly — Railway's healthcheck gates every deploy on
  // it. The DB-querying version blocked behind the collectors' synchronous write
  // chunks during a cold-boot catch-up storm, so /api/health couldn't return 200
  // within the window → the deploy FAILED and the site went down (this bit us hard).
  // Now it's PURE IN-MEMORY: a background timer refreshes the values off the request
  // path, and the handler just returns the last snapshot — so it answers the instant
  // the event loop has a free tick, even mid-storm. If the timer is itself delayed by
  // a freeze, we serve a slightly-stale snapshot, which is fine for a liveness probe.
  let healthSnap: Record<string, unknown> = { ok: true, env: config.nodeEnv, booting: true, time: Date.now() }
  const refreshHealth = () => {
    try {
      const tx = (db.prepare('SELECT MAX(id) n FROM transfers').get() as any).n ?? 0
      const wl = (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE active=1').get() as any).n
      const oldest = (db.prepare('SELECT MIN(ts) t FROM transfers').get() as any).t ?? null
      const sv = (k: string) =>
        Number((db.prepare('SELECT value FROM sync_state WHERE key=?').get(k) as any)?.value ?? 0)
      const anchor = sv('backfill:anchor')
      const casCursor = sv('backfill:cas:cursor') || sv('backfill:cursor') || anchor
      const targetBlocks = Math.ceil((config.deepBackfillDays * 86_400_000) / 12_000)
      const backfillPct = anchor && casCursor < anchor ? Math.min(100, Math.round(((anchor - casCursor) / targetBlocks) * 100)) : 0
      healthSnap = {
        ok: true,
        env: config.nodeEnv,
        watchlist: wl,
        transfers: tx,
        evmLastBlock: sv('evm:lastBlock'),
        historyDays: oldest ? (Date.now() - oldest) / 86_400_000 : 0,
        backfillPct,
        twitch: twitchEnabled(),
        readWorker: readWorkerEnabled(),
        time: Date.now(),
      }
    } catch {
      /* keep the last good snapshot */
    }
  }
  refreshHealth()
  setInterval(refreshHealth, 10_000).unref?.()
  app.get('/api/health', async () => healthSnap)

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
  // Async sibling of aggCached for computes that now run in the read worker
  // (aggregateEntities/aggregateBrands). Same SWR semantics + same cache map: serve
  // the cached value instantly, refresh in the background; only the cold first call
  // awaits. Shares aggCache so the warmer's writes satisfy these reads too.
  async function aggCachedAsync<T>(key: string, fn: () => Promise<T>, ttl = config.aggregateMs): Promise<T> {
    const now = Date.now()
    const c = aggCache.get(key)
    if (c) {
      if (now - c.at >= ttl && !c.refreshing) {
        c.refreshing = true
        fn()
          .then((data) => aggCache.set(key, { data, at: Date.now(), refreshing: false }))
          .catch(() => {
            c.refreshing = false
          })
      }
      return c.data as T
    }
    const data = await fn() // cold: one-time await for this key
    aggCache.set(key, { data, at: now, refreshing: false })
    return data
  }
  // Proactively warm the keys the dashboard hits on load so no user request ever
  // pays the cold compute. Each task runs on its own setImmediate so the warmer
  // never freezes the loop in one long synchronous block. statsCache/countsCache
  // get primed here too (computeStats is defined below; warm runs async after
  // registerApi finishes, so the reference is safe).
  // Warm specs as {key, fn} so we can BOTH cache in-memory AND persist the last-good
  // result to sync_state. The in-memory aggCache is lost on restart, so without
  // persistence a fresh origin recomputes every aggregate cold (12-16s each) before
  // it can serve — the post-deploy slow-first-hit window. Persisting + restoring on
  // boot lets a cold origin serve last-known-good INSTANTLY while the warmer
  // refreshes in the background (SWR). Top-tier = users never wait on a cold compute.
  const warmSpecs: { key: string; fn: () => Promise<unknown> }[] = [
    { key: 'ent:casino', fn: () => aggregateEntities('casino') },
    { key: 'ent:all', fn: () => aggregateEntities('all') },
    { key: 'brand:casino', fn: () => aggregateBrands('casino') },
    { key: 'brand:all', fn: () => aggregateBrands('all') }, // Casinos page (By brand)
    { key: 'coverage', fn: () => computeCoverage() },
    { key: 'flow:casino', fn: () => computeFlow('casino') },
    { key: 'series:7:all', fn: () => computeSeries(7, 'all') },
    { key: 'series:30:all', fn: () => computeSeries(30, 'all') },
  ]
  // Restore persisted aggregates into the cache at boot (at:0 → marked stale so the
  // first access triggers a background SWR refresh, but the user gets data NOW).
  for (const s of warmSpecs) {
    try {
      const raw = stateGet('aggcache:' + s.key)
      if (raw) aggCache.set(s.key, { data: JSON.parse(raw), at: 0, refreshing: false })
    } catch {
      /* corrupt/absent persisted entry — the warmer will recompute it */
    }
  }
  const warmTasks: (() => void | Promise<void>)[] = [
    ...warmSpecs.map((s) => async () => {
      const data = await s.fn()
      aggCache.set(s.key, { data, at: Date.now(), refreshing: false })
      try { stateSet('aggcache:' + s.key, JSON.stringify(data)) } catch { /* non-fatal */ }
    }),
    async () => void (await computeStats()), // primes statsCache + the expensive count cache
  ]
  // Run the warm tasks SEQUENTIALLY with a yield between each, and never overlap a
  // cycle with itself. The old version fired all 8 heavy computes via setImmediate
  // on a 30s interval — but at boot (cold disk cache) each takes 12-16s, so a cycle
  // ran far longer than 30s and the next cycle piled on top, permanently saturating
  // the single thread until the disk cache warmed (the post-deploy stall window).
  // Sequential + guarded + a 5-min cadence keeps the keys primed without flooding;
  // the SWR cache refreshes any key that goes stale between cycles on access.
  let warming = false
  const warm = async () => {
    if (warming) return
    warming = true
    try {
      for (const task of warmTasks) {
        try {
          await task()
        } catch {
          /* a transient DB error shouldn't kill the warmer */
        }
        await new Promise((r) => setImmediate(r)) // hand the loop back between heavy tasks
      }
    } finally {
      warming = false
    }
  }
  setTimeout(() => void warm(), 8_000)
  setInterval(() => void warm(), 300_000)

  // Let browsers and the CDN serve the public, non-user-specific leaderboards from
  // cache. The data moves slowly (rolling 7d/30d aggregates), so a short fresh
  // window plus a LONG stale-while-revalidate window means users are served from
  // the edge almost always and the origin is revalidated in the background — they
  // effectively never wait on a cold origin. Gated/auth and per-user endpoints
  // (sentiment carries per-user votes) are excluded.
  const PUBLIC_CACHEABLE = /^\/api\/(stats|casinos|brands|entities|coverage|protocols|predictions|sponsorships|streamers|flow|series|transfers|notifications|arkham\/reserves|directory\/overview|snapshot\/market|entity\/\d+\/(?:series|flow))$/
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' && !reply.getHeader('Cache-Control') && PUBLIC_CACHEABLE.test(req.url.split('?')[0])) {
      reply.header('Cache-Control', 'public, max-age=120, stale-while-revalidate=1800')
    }
    return payload
  })

  // ── global stats (all REAL sums) ─────────────────────────────────────────────
  let statsCache: { data: unknown; at: number } | null = null
  // The COUNT(*)/SUM(usd) scans over the 24M-row transfers table are the costly
  // part of /api/stats. The old query ALSO did COUNT(DISTINCT counterparty) twice —
  // a ~40s synchronous scan that froze the single event loop on every refresh (the
  // root cause of the post-deploy / hourly dashboard stalls). Distinct players now
  // come from the background-maintained map (maintainedPlayers, never blocks); the
  // remaining COUNT/SUM are cached 6h and refreshed off the request path (the stats
  // endpoint is stale-while-revalidate), so the scan runs rarely and never on a
  // user's request.
  let countsCache: { at: number; totals: any; cas: any } | null = null
  const expensiveCounts = async () => {
    if (countsCache && Date.now() - countsCache.at < 6 * 3600_000) return countsCache
    const d7 = Date.now() - 7 * 86_400_000
    // full-table COUNT/SUM over 24M rows → run in the read worker (off the loop)
    const totals = (await workerGet('SELECT COUNT(*) tx, SUM(usd) vol FROM transfers')) as any
    const cas = (await workerGet(
      `SELECT COUNT(*) tx, SUM(usd) vol, SUM(CASE WHEN ts>=? THEN usd ELSE 0 END) vol7
         FROM transfers WHERE category='casino'`,
      [d7],
    )) as any
    countsCache = { at: Date.now(), totals, cas }
    return countsCache
  }
  let statsRefreshing = false
  const computeStats = async () => {
    const now = Date.now()
    const d7 = now - 7 * 86_400_000
    const { totals, cas } = await expensiveCounts()
    const players = maintainedPlayers() // fresh each call; cheap, never scans
    // volume + chain split now come from the credible per-brand aggregate below
    // (external-only, suspect-excluded), so the old raw all-category scans are gone.
    const reserves = (db.prepare('SELECT SUM(usd) v FROM balances').get() as any).v ?? 0
    const wl = (db.prepare('SELECT COUNT(*) n FROM watchlist WHERE active=1').get() as any).n
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
    // total operators we cover (directory: rated or live-site verified) — our free-coverage
    // headline. Far larger than on-chain-only competitors that paywall most of their list.
    let casinosTracked = 0
    try {
      casinosTracked = (db.prepare("SELECT COUNT(*) n FROM casino_directory WHERE tp_rating IS NOT NULL OR site_ok=1").get() as any).n
    } catch {
      /* directory optional */
    }
    // Headline "volume" must be the CREDIBLE figure — the raw all-time SUM(usd) over
    // EVERY transfer (all categories, no external-only, no suspect/churn exclusion)
    // annualises past the whole industry (~$100B+ cumulative). Use the de-distorted
    // per-brand 7d volume instead (attributed, non-suspect; already external-only).
    const cbrands = (await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)) as any[]
    const credible = cbrands.filter((b) => b.attributed && !b.volumeSuspect)
    const verifiedVol7d = credible.reduce((s, b) => s + (b.volume7d || 0), 0)
    // Players on the SAME credible universe as volume (attributed + non-suspect), so the
    // headline player count can't include unattributed Casino-pattern wallets or suspect
    // operators' churn counterparties. Falls back to the background-maintained all-entity
    // count only on a cold start (before the brand aggregate's player map fills).
    const credPlayers = credible.reduce((s, b) => s + (b.players || 0), 0)
    // Credible chain split too — derive from the de-distorted per-brand byChain
    // (external-only, attributed, non-suspect) instead of the raw all-category
    // GROUP BY chain (which Rollbit-style churn otherwise dominates).
    const chainAgg = new Map<string, number>()
    for (const b of cbrands)
      if (b.attributed && !b.volumeSuspect) for (const c of b.byChain ?? []) chainAgg.set(c.chain, (chainAgg.get(c.chain) ?? 0) + (c.value ?? 0))
    const credibleChainSplit = [...chainAgg.entries()].map(([chain, value]) => ({ chain, value })).sort((a, b) => b.value - a.value)
    const data = {
      totalVolume: verifiedVol7d,
      volume7d: verifiedVol7d,
      totalTransfers: totals.tx ?? 0,
      uniquePlayers: players.all,
      reserves,
      entities: wl,
      liveStreamers,
      casinosTracked,
      chainSplit: credibleChainSplit,
      casino: {
        totalVolume: verifiedVol7d,
        volume7d: verifiedVol7d,
        totalTransfers: cas.tx ?? 0,
        uniquePlayers: credPlayers > 0 ? credPlayers : players.casino,
        reserves: casReserves,
        entities: casEntities,
        casinosTracked,
        chainSplit: credibleChainSplit,
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
        computeStats().finally(() => {
          statsRefreshing = false
        })
      }
      return statsCache.data
    }
    return await computeStats() // cold: first call only
  })

  // ── entities (a.k.a. casinos/exchanges) leaderboard ──────────────────────────
  app.get('/api/entities', async (req) => {
    const { category } = req.query as { category?: string }
    // the generic leaderboard intentionally spans every category by default
    const cat = category ?? 'all'
    return aggCachedAsync('ent:' + cat, () => aggregateEntities(cat), 120_000)
  })

  // casino-centric leaderboard — defaults to iGaming only so exchanges/whales
  // never get grouped in with casinos. ?category=all|exchange|whale to override.
  app.get('/api/casinos', async (req) => {
    const { category } = req.query as { category?: string }
    const cat = category ?? 'casino'
    return aggCachedAsync('ent:' + cat, () => aggregateEntities(cat), 120_000)
  })

  // brand-aggregated leaderboard — wallets clustered by known attribution.
  // Also casino-only by default (exchanges/whales excluded unless requested).
  app.get('/api/brands', async (req) => {
    const { category } = req.query as { category?: string }
    const cat = category ?? 'casino'
    return aggCachedAsync('brand:' + cat, () => aggregateBrands(cat), 120_000)
  })

  // public brand history (non-sensitive daily metrics) from the persistent layer
  app.get('/api/brand/:slug/history', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const days = Math.min(Number((req.query as { days?: string })?.days ?? 30) || 30, 180)
    const h = brandHistory(slug, days)
    if (!h) return reply.code(404).send({ error: 'brand not found' })
    return reply.header('Cache-Control', 'public, max-age=300').send(h)
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
  app.get('/api/directory/unlockertest', async (req, reply) => {
    // gated: spends paid unlocker credits and can proxy an arbitrary ?url= — must
    // never be public (credit-drain / SSRF surface)
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
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
  app.get('/api/directory/arkhamtest', async (req, reply) => {
    // gated: proxies arbitrary ?path= to the Arkham API with our key — keep private
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
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
  const computeCoverage = async () => {
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
      try {
        const c = (await workerGet('SELECT COUNT(*) n FROM (SELECT chain FROM transfers GROUP BY chain)')) as any
        if (c && typeof c.n === 'number' && c.n > 0) chainsCache = { at: Date.now(), n: c.n }
      } catch {
        /* keep last-known chain count */
      }
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
  app.get('/api/coverage', async () => aggCachedAsync('coverage', computeCoverage, 300_000))

  // 1.0 content layer: precomputed daily market snapshot (homepage + email source).
  // Reads the snapshot table, never raw transfers — instant, no compute on request.
  app.get('/api/snapshot/market', async () => latestMarketSnapshot() ?? { error: 'no snapshot yet' })

  // Full daily-snapshot archive (one row per day since the daily report launched).
  // The transfers table only retains a rolling window, so THIS is the long-run
  // trend source — used by the whitepaper/open-data exports. Public read-only.
  app.get('/api/snapshot/archive', async (_req, reply) => {
    const rows = db
      .prepare(
        `SELECT snapshot_date, tracked_volume_24h, net_flow_24h, active_casinos, active_chains,
                live_streamers, reserves_total, reserve_change_7d, confidence_level
         FROM daily_market_snapshot ORDER BY snapshot_date`,
      )
      .all()
    return reply.header('Cache-Control', 'public, max-age=3600').send({ days: rows.length, rows })
  })

  // public — branded daily share / OG card (1200×630 PNG) with the day's verified
  // headline figures. ?date=YYYY-MM-DD for an archived report; default = latest.
  app.get('/api/share/daily.png', async (req, reply) => {
    const date = (req.query as { date?: string })?.date
    const row = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? db.prepare('SELECT * FROM daily_market_snapshot WHERE snapshot_date=?').get(date)
      : db.prepare('SELECT * FROM daily_market_snapshot ORDER BY snapshot_date DESC LIMIT 1').get()) as any
    if (!row) return reply.code(404).send({ error: 'no snapshot' })
    let payload: any = {}
    try {
      payload = JSON.parse(row.payload_json || '{}')
    } catch {
      payload = {}
    }
    const f = (n: number) => {
      const a = Math.abs(n || 0)
      return a >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n || 0)
    }
    const net = row.net_flow_24h ?? 0
    const stats = [
      { label: '24h Verified Volume', value: f(row.tracked_volume_24h ?? 0) },
      { label: 'Net Flow 24h', value: (net >= 0 ? '+' : '−') + f(Math.abs(net)) },
      { label: 'Active Brands', value: String(row.active_casinos ?? 0) },
      { label: 'Tracked Reserves', value: f(row.reserves_total ?? 0) },
    ]
    const png = await renderDailyShareCard({ date: row.snapshot_date, stats, topChain: payload.concentration?.topChain ?? undefined })
    if (!png) return reply.code(503).send({ error: 'renderer unavailable' })
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=3600').send(png)
  })

  // public — community submissions: attribution evidence (for unattributed flow) or a
  // correction request for a tracked brand. Stored for ADMIN review; never auto-applied.
  app.post('/api/submit', async (req, reply) => {
    const b = (req.body ?? {}) as { type?: string; brand?: string; email?: string; message?: string; evidenceUrl?: string }
    if (b.type !== 'attribution' && b.type !== 'correction') return reply.code(400).send({ error: 'invalid type' })
    const message = String(b.message ?? '').trim()
    if (message.length < 5 || message.length > 4000) return reply.code(400).send({ error: 'message must be 5–4000 characters' })
    const email = String(b.email ?? '').trim().slice(0, 200)
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'invalid email' })
    // light anti-spam: cap stored submissions from the same email in the last hour
    if (email) {
      const recent = (db.prepare('SELECT COUNT(*) n FROM submission WHERE email=? AND created_at>?').get(email, Date.now() - 3600_000) as any).n
      if (recent >= 10) return reply.code(429).send({ error: 'too many submissions — try again later' })
    }
    db.prepare('INSERT INTO submission(type, brand, email, message, evidence_url, status, created_at) VALUES(?,?,?,?,?,?,?)').run(
      b.type,
      String(b.brand ?? '').trim().slice(0, 120) || null,
      email || null,
      message.slice(0, 4000),
      String(b.evidenceUrl ?? '').trim().slice(0, 500) || null,
      'new',
      Date.now(),
    )
    return { ok: true }
  })

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
  app.get('/api/notifications', async () => {
    // Same credible basis as the headline volume: external-facing flow only, and drop
    // volume-suspect operators — otherwise the feed is flooded by treasury/market-making
    // churn (e.g. Rollbit ~$4M/tx) that the rest of the site already excludes.
    const brands = (await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)) as any[]
    const suspect = new Set<string>()
    for (const b of brands) if (b.volumeSuspect) { suspect.add(b.brand); for (const m of b.members ?? []) suspect.add(m.label) }
    return aggCached(
      'notifications',
      () => {
        const since = Date.now() - 48 * 3600_000
        const rows = db
          .prepare(
            `SELECT label, chain, direction, usd, ts FROM transfers
             WHERE ts >= ? AND category='casino' AND usd >= 50000 ${externalFlowClause()} ${attributedClause()}
             ORDER BY ts DESC LIMIT 80`,
          )
          .all(since) as any[]
        return {
          items: rows
            .filter((r) => !suspect.has(r.label))
            .slice(0, 25)
            .map((r) => ({
              type: r.direction === 'in' ? 'deposit' : 'withdrawal',
              title: `${r.direction === 'in' ? 'Large deposit' : 'Large withdrawal'} · ${r.label}`,
              detail: `$${Math.round(r.usd).toLocaleString()} on ${r.chain}`,
              ts: r.ts,
              href: '/app/blockchain',
            })),
        }
      },
      60_000,
    )
  })

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

  app.get('/api/directory', async (req) => {
    // open-access: the casino directory is public data (this 401 gate was a leftover
    // from the login era and was silently blanking the /app/directory page)
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
    // open-access: same public directory data, CSV form (export button on the page)
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
  const computeSeries = async (days: number, cat: string) => {
    const now = Date.now()
    const from = now - days * 86_400_000
    const bucketMs = days <= 7 ? 6 * 3600_000 : 24 * 3600_000 // 6h buckets ≤7d, daily beyond
    const catFilter = cat !== 'all' ? ' AND category = ?' : ''
    const catArg = catFilter ? [cat] : []
    // Credible basis (consistent with the headline total): external-facing flow only,
    // volume-suspect operators dropped — otherwise the chart annualises past the whole
    // industry and contradicts the tracked-volume headline.
    const brands = (await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)) as any[]
    const suspect = new Set<string>()
    for (const b of brands) if (b.volumeSuspect) { suspect.add(b.brand); for (const m of b.members ?? []) suspect.add(m.label) }
    const suspectArr = [...suspect]
    const suspectNotIn = suspectArr.length ? `AND label NOT IN (${suspectArr.map(() => '?').join(',')})` : ''
    const rows = (await workerAll(
      `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
              SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) deposits,
              SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) withdrawals
       FROM transfers WHERE ts >= ?${catFilter} ${externalFlowClause()} ${attributedClause()} ${suspectNotIn} GROUP BY b ORDER BY b`,
      [from, bucketMs, from, ...catArg, ...suspectArr],
    )) as any[]
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
    return aggCachedAsync(`series:${days}:${cat}`, () => computeSeries(days, cat), 120_000)
  })

  // ── per-entity daily volume series, split by chain (REAL) ───────────────────
  // ?days=30 — daily buckets of indexed volume per chain for one watch entry.
  // An EVM entity's single watch row accrues transfers from every EVM chain,
  // so this surfaces the entity's real multi-chain history.
  app.get('/api/entity/:id/series', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { days?: string }
    const days = Math.min(90, Math.max(7, Number(q.days ?? 30)))
    // cache per (id,days): this GROUP BY scans the entity's window and was uncached
    // on the request path, blocking the single thread per call (see ARCHITECTURE_REVIEW PF-2)
    return aggCachedAsync(`entseries:${id}:${days}`, async () => {
      const now = Date.now()
      const from = now - days * 86_400_000
      const rows = (await workerAll(
        `SELECT chain, CAST((ts - ?) / 86400000 AS INTEGER) AS b, SUM(usd) v
         FROM transfers WHERE watch_id = ? AND ts >= ? ${externalFlowClause()}
         GROUP BY chain, b`,
        [from, Number(id), from],
      )) as { chain: string; b: number; v: number }[]
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
    }, 120_000)
  })

  // ── per-entity money-flow graph: sources → entity → destinations ─────────────
  // Counterparties that are themselves watched are named; the rest roll up into
  // an "Other …" bucket. Powers the Sankey on the casino detail view.
  app.get('/api/entity/:id/flow', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { days?: string }
    const days = Math.min(90, Math.max(7, Number(q.days ?? 30)))
    // cache per (id,days): two GROUP BY + LEFT JOIN scans, previously run on the
    // request path per call → loop freeze (see ARCHITECTURE_REVIEW PF-2)
    return aggCachedAsync(`entflow:${id}:${days}`, async () => {
    const since = Date.now() - days * 86_400_000
    const wid = Number(id)
    const ent = db.prepare('SELECT label FROM watchlist WHERE id=?').get(wid) as any
    if (!ent) return { entity: null, sources: [], sinks: [] }

    const side = async (direction: 'in' | 'out') => {
      const rows = (await workerAll(
        `SELECT t.counterparty AS addr, w2.label AS label, SUM(t.usd) AS usd, COUNT(*) AS n
         FROM transfers t
         LEFT JOIN watchlist w2 ON w2.address = t.counterparty AND w2.active = 1
         WHERE t.watch_id = ? AND t.direction = ? AND t.ts >= ?
         GROUP BY t.counterparty ORDER BY usd DESC`,
        [wid, direction, since],
      )) as { addr: string; label: string | null; usd: number; n: number }[]
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
    return { entity: ent.label, days, sources: await side('in'), sinks: await side('out') }
    }, 120_000)
  })

  // ── flow intelligence: tx-size distribution (REAL, derived) ──────────────────
  // Casino-only by default so exchange/whale flow doesn't pollute the player
  // segmentation; ?category=all|exchange|… to widen.
  const computeFlow = async (cat: string) => {
    const d7 = Date.now() - 7 * 86_400_000
    const meta = [
      { name: 'Whale', color: '#F2C200' },
      { name: 'High Roller', color: '#8b3df0' },
      { name: 'Regular', color: '#2ee6a6' },
      { name: 'Casual', color: '#5b8cff' },
    ]
    const catFilter = cat && cat !== 'all' ? ' AND category = ?' : ''
    const catArg = catFilter ? [cat] : []
    // Drop volume-suspect operators so the Whale tier isn't inflated by treasury/
    // market-making churn (consistent with every other headline figure).
    const brands = (await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)) as any[]
    const suspect = new Set<string>()
    for (const b of brands) if (b.volumeSuspect) { suspect.add(b.brand); for (const m of b.members ?? []) suspect.add(m.label) }
    const suspectArr = [...suspect]
    const suspectNotIn = suspectArr.length ? `AND label NOT IN (${suspectArr.map(() => '?').join(',')})` : ''
    // bucket + COUNT(DISTINCT) in SQL, run in the read worker (off the main loop)
    const rows = (await workerAll(
      `SELECT CASE WHEN usd >= 100000 THEN 0 WHEN usd >= 10000 THEN 1 WHEN usd >= 500 THEN 2 ELSE 3 END AS b,
              COUNT(*) cnt, SUM(usd) vol, COUNT(DISTINCT counterparty) players
       FROM transfers WHERE ts >= ?${catFilter} ${externalFlowClause()} ${attributedClause()} ${suspectNotIn}
       GROUP BY b`,
      [d7, ...catArg, ...suspectArr],
    )) as any[]
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
    return aggCachedAsync('flow:' + cat, () => computeFlow(cat), 120_000)
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
    // The list shows REAL streamers — not the long tail of tiny/empty channels the
    // category-discovery seeds bring in. Quality bar: live now, OR platform-verified,
    // OR has a detected casino affiliation, OR a genuine following (≥10k). The list
    // view is lightweight (no images) so it renders the full quality set fine. Lean
    // columns only (heavy bio/title/thumbnail aren't needed by the list). `collected`
    // stays the honest full count of everything we've fetched data for.
    const MIN_FOLLOWERS = Number(process.env.STREAMER_MIN_FOLLOWERS ?? 10000)
    const QUALITY = `(verified=1 OR (affiliation IS NOT NULL AND affiliation != '') OR followers >= ${MIN_FOLLOWERS})`
    const COLS = 'id, handle, platform, viewers, live, title, followers, affiliation, socials, verified'
    const live = db.prepare(`SELECT ${COLS} FROM streamers WHERE live=1 ORDER BY viewers DESC`).all()
    const offline = db.prepare(`SELECT ${COLS} FROM streamers WHERE live=0 AND ${QUALITY} ORDER BY followers DESC LIMIT 3000`).all()
    const roster = (db.prepare('SELECT COUNT(*) n FROM streamer_roster WHERE active=1').get() as any).n
    const collected = (db.prepare('SELECT COUNT(*) n FROM streamers').get() as any).n
    return { enabled: true, twitch: twitchEnabled(), roster, collected, streamers: live, offline }
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
    // Brand-MERGED view: one row per operator (Stake.com + Stake(11) + Tron wallets
    // → a single "Stake"), but genuinely distinct products (e.g. Stake.us) stay
    // separate — dedup is by brandKey, matching the rest of the product. Votes and
    // mentions are rolled up across each brand's member wallets.
    const brands = await aggCachedAsync('brand:' + cat, () => aggregateBrands(cat), 120_000)
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
    // vote tallies per watch_id, rolled up across a brand's member wallets
    const voteAgg = new Map<number, { up: number; down: number }>(
      (db
        .prepare(
          'SELECT watch_id, SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) up, SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) down FROM votes GROUP BY watch_id',
        )
        .all() as any[]).map((r) => [r.watch_id, { up: r.up, down: r.down }]),
    )
    const myVotes: Map<number, number> = user
      ? new Map((db.prepare('SELECT watch_id, vote FROM votes WHERE user_id = ?').all(user.id) as any[]).map((v) => [v.watch_id, v.vote]))
      : new Map()
    return {
      redditEnabled: redditEnabled(),
      newsEnabled: newsEnabled(),
      mentionsBySource: Object.fromEntries(sourceRows.map((r) => [r.source, r.n])),
      entities: brands.filter((b) => b.attributed).map((b) => {
        const members = b.members ?? []
        const head = members.slice().sort((x, y) => y.volume7d - x.volume7d)[0]
        const ids = members.map((m) => m.id)
        const votesUp = ids.reduce((s, id) => s + (voteAgg.get(id)?.up ?? 0), 0)
        const votesDown = ids.reduce((s, id) => s + (voteAgg.get(id)?.down ?? 0), 0)
        const myVote = ids.map((id) => myVotes.get(id)).find((v) => v != null) ?? 0
        // mentions: sum across the brand label + every member label (deduped)
        let mentions7d = 0,
          mentionsPos = 0,
          mentionsNeg = 0
        for (const l of new Set<string>([b.brand, ...members.map((m) => m.label)])) {
          const x = mMap.get(l)
          if (x) {
            mentions7d += x.mentions
            mentionsPos += x.pos
            mentionsNeg += x.neg
          }
        }
        return {
          id: head?.id ?? ids[0] ?? 0, // representative wallet for casting a vote
          label: b.brand,
          category: b.category,
          chain: head?.chain ?? b.chains[0] ?? '',
          chains: b.chains,
          wallets: b.wallets,
          trust: b.trust,
          onchainTrust: b.trust,
          safetyIndex: b.safetyIndex,
          trustpilot: b.trustpilot,
          inflow7d: b.inflow7d,
          outflow7d: b.outflow7d,
          change24h: b.change24h,
          reserves: b.reserves,
          votesUp,
          votesDown,
          myVote,
          mentions7d,
          mentionsPos,
          mentionsNeg,
          telegramSubs: subs.get(brandKey(b.brand)) ?? 0,
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

  // ── personal watchlist — each signed-in user's own favourited casinos ─────────
  // Keyed by brandKey (survives wallet churn) and joined to live brand stats on read.
  // Distinct from the global /api/watchlist (operator-curated tracked addresses).
  app.get('/api/me/watchlist', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const favs = db
      .prepare('SELECT brand_key, label, created_at FROM user_watch WHERE user_id=? ORDER BY created_at DESC')
      .all(user.id) as { brand_key: string; label: string; created_at: number }[]
    if (!favs.length) return { items: [] }
    const brands = (await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)) as any[]
    const byKey = new Map(brands.map((b) => [brandKey(b.brand), b]))
    return {
      items: favs.map((f) => {
        const b = byKey.get(f.brand_key)
        return {
          brandKey: f.brand_key,
          label: b?.brand ?? f.label,
          createdAt: f.created_at,
          stats: b
            ? {
                volume7d: b.volume7d,
                volume24h: b.volume24h,
                net7d: b.net7d,
                reserves: b.reserves,
                trust: b.trust,
                chains: b.chains,
                safetyIndex: b.safetyIndex,
                trustpilot: b.trustpilot,
                change24h: b.change24h,
              }
            : null,
        }
      }),
    }
  })
  app.post('/api/me/watchlist', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const label = String((req.body as { label?: string })?.label ?? '').trim()
    if (!label) return reply.code(400).send({ error: 'label required' })
    const key = brandKey(label)
    if (!key) return reply.code(400).send({ error: 'invalid label' })
    db.prepare(
      'INSERT INTO user_watch(user_id, brand_key, label, created_at) VALUES(?,?,?,?) ON CONFLICT(user_id, brand_key) DO UPDATE SET label=excluded.label',
    ).run(user.id, key, label, Date.now())
    return { ok: true, brandKey: key }
  })
  app.delete('/api/me/watchlist/:key', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const { key } = req.params as { key: string }
    db.prepare('DELETE FROM user_watch WHERE user_id=? AND brand_key=?').run(user.id, key)
    return { ok: true }
  })

  // ADMIN-ONLY gate. These endpoints expose internal ops (data-quality, enrichment)
  // and the X content pipeline — including publishing to the brand's own X account
  // and spending OpenRouter credits. The site has free passwordless signup, so plain
  // login is NOT enough: only the admin (the first account ever created) may touch
  // these. Returns the user on success, or sends 401/403 and returns null.
  const requireAdmin = (req: any, reply: any) => {
    const u = userFromRequest(req)
    if (!u) {
      reply.code(401).send({ error: 'login required' })
      return null
    }
    // belt-and-suspenders: require BOTH the admin role AND an allowlisted email, so a
    // stray DB role can never grant admin to a non-owner account.
    if (u.role !== 'admin' || !isAdminEmail(u.email)) {
      reply.code(403).send({ error: 'admin only' })
      return null
    }
    return u
  }

  // data-quality report (admin) — last run from the SEO regen cycle, or run on demand
  app.get('/api/diag/dataquality', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const run = (req.query as { run?: string })?.run === '1'
    const data = run ? { at: Date.now(), results: await runDataQualityChecks() } : lastDataQuality()
    if (!data) return { at: 0, results: [], note: 'no run yet — append ?run=1 to force' }
    const fails = data.results.filter((d) => d.status !== 'pass').length
    return { ...data, summary: `${data.results.length - fails}/${data.results.length} passed`, ok: fails === 0 }
  })

  // diag: aggregated Arkham per-chain casino volume (the BTC/Tron attribution layer).
  // Public read — same nature as the chain distribution. Lets us verify the real
  // cross-chain split (incl. Tron/BTC) before wiring it into the daily report.
  app.get('/api/diag/arkham-chains', async () => {
    const rows = db
      .prepare('SELECT chain, SUM(vol7d) v, COUNT(DISTINCT key) casinos FROM arkham_chain_volume GROUP BY chain ORDER BY v DESC')
      .all() as { chain: string; v: number; casinos: number }[]
    const tot = rows.reduce((s, r) => s + (r.v ?? 0), 0) || 1
    const entities = (db.prepare('SELECT COUNT(DISTINCT key) n FROM arkham_chain_volume').get() as any).n
    return { entities, chains: rows.map((r) => ({ chain: r.chain, vol7d: r.v, casinos: r.casinos, share: +((100 * (r.v ?? 0)) / tot).toFixed(1) })) }
  })

  // authoritative cross-chain RESERVE split (Arkham portfolio, non-429). This is
  // the BTC/Tron/SOL attribution that fixes the ETH-skewed indexed-volume chart.
  app.get('/api/diag/arkham-chain-reserves', async () => {
    const rows = db
      .prepare('SELECT chain, SUM(usd) v, COUNT(DISTINCT key) casinos FROM arkham_chain_reserves GROUP BY chain ORDER BY v DESC')
      .all() as { chain: string; v: number; casinos: number }[]
    const tot = rows.reduce((s, r) => s + (r.v ?? 0), 0) || 1
    const entities = (db.prepare('SELECT COUNT(DISTINCT key) n FROM arkham_chain_reserves').get() as any).n
    return { entities, total: tot, chains: rows.map((r) => ({ chain: r.chain, usd: r.v, casinos: r.casinos, share: +((100 * (r.v ?? 0)) / tot).toFixed(1) })) }
  })

  // Per-chain casino capital flow — the clear daily/Nd deposit + withdrawal
  // statistic from our own indexed casino wallets (the metric, not reserves).
  // ?chain=TRON|BTC|ETH|… (default TRON), ?days=N.
  app.get('/api/diag/tron-casino-flow', async (req) => {
    const chain = String((req.query as any)?.chain || 'TRON').toUpperCase()
    const days = Math.min(30, Math.max(1, Number((req.query as any)?.days) || 1))
    const win = (d: number) => Date.now() - d * 86_400_000
    const q = (since: number) =>
      db
        .prepare(
          `SELECT label,
             SUM(CASE WHEN direction='in'  THEN usd ELSE 0 END) AS deposits,
             SUM(CASE WHEN direction='out' THEN usd ELSE 0 END) AS withdrawals,
             SUM(usd) AS total, COUNT(*) AS txns
           FROM transfers
           WHERE chain=? AND category='casino' AND ts>=? ${externalFlowClause()}
           GROUP BY label ORDER BY total DESC`,
        )
        .all(chain, since) as { label: string; deposits: number; withdrawals: number; total: number; txns: number }[]
    const rows = q(win(days))
    const sum = (k: 'deposits' | 'withdrawals' | 'total' | 'txns') => rows.reduce((s, r) => s + (r[k] ?? 0), 0)
    return {
      chain,
      windowDays: days,
      casinos: rows.length,
      totalFlow: sum('total'),
      deposits: sum('deposits'),
      withdrawals: sum('withdrawals'),
      txns: sum('txns'),
      perCasino: rows.slice(0, 60),
    }
  })

  // live debug: one Arkham /transfers fetch → raw transfer shape (confirm chain field).
  app.get('/api/diag/arkham-probe', async () => arkhamProbe())

  // live debug: probe Arkham non-transfers endpoints for an entity's per-chain
  // addresses (the 429-free path to harvest Tron/BTC casino wallets). ?key=<slug>
  app.get('/api/diag/arkham-addresses', async (req) => arkhamAddressProbe((req.query as any)?.key))

  // Credible cross-chain split: external-facing volume (counterparty is NOT a watched
  // casino address → real deposits/withdrawals, not internal churn/double-count) with
  // volume-suspect brands (anomalous wash/treasury/own-token churn) excluded. This is
  // the de-distorted version of the raw per-chain volume.
  app.get('/api/diag/chain-distribution', async () => {
    const brands = await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)
    const suspect = new Set<string>()
    for (const b of brands as any[]) if (b.volumeSuspect) { suspect.add(b.brand); for (const m of b.members ?? []) suspect.add(m.label) }
    const d7 = Date.now() - 7 * 86_400_000
    const rows = db.prepare(
      `SELECT chain, label, SUM(usd) v, COUNT(*) n FROM transfers
       WHERE category='casino' AND ts>=?
         AND label NOT LIKE 'Casino-pattern%' AND label NOT LIKE '0x%' AND label NOT LIKE 'Unknown%' AND label NOT LIKE 'Unnamed%'
         ${externalFlowClause()}
       GROUP BY chain, label`,
    ).all(d7) as { chain: string; label: string; v: number; n: number }[]
    const AVG_TX_CEILING = Number(process.env.DEPOSIT_AVG_TX_CEILING ?? 50_000)
    const m = new Map<string, number>()
    for (const r of rows) {
      if (suspect.has(r.label)) continue
      if (r.n > 0 && r.v / r.n > AVG_TX_CEILING) continue // treasury/market-making churn, not deposits
      m.set(r.chain, (m.get(r.chain) ?? 0) + (r.v ?? 0))
    }
    const total = [...m.values()].reduce((s, v) => s + v, 0) || 1
    const dist = [...m.entries()]
      .map(([chain, v]) => ({ chain, usd: Math.round(v), share: +(100 * v / total).toFixed(1) }))
      .sort((a, b) => b.usd - a.usd)
    return { window: '7d', basis: 'external deposits+withdrawals, volume-suspect excluded', total: Math.round(total), dist, suspectExcluded: [...suspect].filter((l) => !l.startsWith('0x')).slice(0, 20) }
  })

  // BTC clustering audit — per-operator address counts split by provenance
  // (seed vs cluster-discovered). Public read-only: it's how we expanded BTC
  // coverage and the figures are auditable / cluster rows are bulk-reversible.
  app.get('/api/diag/btc-cluster', async () => {
    const rows = db.prepare(
      `SELECT label,
              COUNT(*) AS total,
              SUM(CASE WHEN source='btc-cluster' THEN 1 ELSE 0 END) AS clustered,
              SUM(CASE WHEN source IS NULL OR source!='btc-cluster' THEN 1 ELSE 0 END) AS seed
       FROM watchlist WHERE chain='BTC' AND category='casino'
       GROUP BY label ORDER BY total DESC`,
    ).all() as { label: string; total: number; clustered: number; seed: number }[]
    const totals = rows.reduce(
      (a, r) => ({ addresses: a.addresses + r.total, clustered: a.clustered + r.clustered }),
      { addresses: 0, clustered: 0 },
    )
    return { operators: rows.length, ...totals, perOperator: rows }
  })

  // coverage audit — on-chain casino coverage by attribution source (curated / dune /
  // arkham / labels), named-brand count, and the Dune query id. The lever for tracking
  // more operators than competitors; watch distinctNamedBrands grow as Dune/indexers land.
  app.get('/api/diag/coverage', async () => {
    const bySource = db
      .prepare(
        "SELECT COALESCE(source,'(curated/seed)') src, COUNT(*) wallets, COUNT(DISTINCT label) brands FROM watchlist WHERE active=1 AND category='casino' GROUP BY src ORDER BY wallets DESC",
      )
      .all() as { src: string; wallets: number; brands: number }[]
    const totalCasinoWallets = (db.prepare("SELECT COUNT(*) n FROM watchlist WHERE active=1 AND category='casino'").get() as any).n
    const distinctNamedBrands = (
      db
        .prepare("SELECT COUNT(DISTINCT label) n FROM watchlist WHERE active=1 AND category='casino' AND label NOT LIKE 'Casino-pattern%' AND label NOT LIKE '0x%' AND label NOT LIKE 'Service %'")
        .get() as any
    ).n
    return { totalCasinoWallets, distinctNamedBrands, duneQueryId: stateGet('dune:casino_qid'), bySource }
  })

  // ── open-data export: per-wallet provenance ──────────────────────────────────
  // Public, read-only. Feeds github.com/chenny2023/wcoin-casino-data: every active
  // casino wallet with its evidence source and first-seen date, plus the infra
  // denylist (known non-casino contracts excluded from attribution). Lean columns;
  // brand grouping/metrics come from /api/brands and are joined at export time.
  app.get('/api/labels/export', async (req, reply) => {
    const rows = db
      .prepare("SELECT chain, address, label, COALESCE(source,'curated') source, created_at, role, role_at FROM watchlist WHERE active=1 AND category='casino' ORDER BY label, chain, address")
      .all() as { chain: string; address: string; label: string; source: string; created_at: number; role: string | null; role_at: number | null }[]
    const wallets = rows.map((r) => ({
      chain: r.chain,
      address: r.address,
      label: r.label,
      source: r.source,
      first_seen_at: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null,
      // behaviour-inferred over a rolling window (rolesinfer.ts); null = ambiguous, no claim
      wallet_role: r.role ?? null,
      role_inferred_at: r.role_at ? new Date(r.role_at).toISOString().slice(0, 10) : null,
    }))
    const excluded = [...INFRA_DENYLIST].map((address) => ({ address, reason: 'known_non_casino_infrastructure' }))
    return reply.header('Cache-Control', 'public, max-age=600').send({ as_of: new Date().toISOString(), count: wallets.length, wallets, excluded })
  })

  // infra-demotion audit (read-only) — shows the plausibility ceiling (largest verified
  // non-suspect brand 7d volume) and which unattributed casino entities out-volume it
  // (mislabeled exchange/bridge/MM infra). The deactivation itself runs automatically in
  // demoteImplausibleCasinos() at boot; this is just the auditable view of its decision.
  app.get('/api/diag/infra-demote', async () => {
    const brands = (await aggregateBrands('casino')) as any[]
    const ceiling = Math.max(0, ...brands.filter((b) => b.attributed && !b.volumeSuspect).map((b) => b.volume7d ?? 0))
    const ents = (await aggregateEntities('casino')) as any[]
    const unattr = ents.filter((e) => isUnattributed(e.label))
    const infra = unattr.filter((e) => (e.volume7d ?? 0) > ceiling)
    return {
      flag: stateGet('labels:demoted_infra'),
      ceiling: Math.round(ceiling),
      entsCount: ents.length,
      unattr: unattr.map((e) => ({ id: e.id, label: e.label, vol7d: Math.round(e.volume7d ?? 0) })),
      infraOverCeiling: infra.map((e) => ({ id: e.id, label: e.label, vol7d: Math.round(e.volume7d ?? 0) })),
    }
  })

  // internal-flow marker audit — proves the precomputed `cp_internal` flag is
  // complete enough to replace the slow per-row NOT EXISTS on the volume hot path.
  // Computes the 7d volume three ways over the same window: gross (no filter),
  // cp_internal=0 (the fast flag), and NOT EXISTS (the authoritative-but-slow
  // definition). When cpInternal ≈ notExists the marker has caught up and the
  // cheap filter is safe to make the default. All scans run off the main loop.
  app.get('/api/diag/internal-flow', async () => {
    const d7 = Date.now() - 7 * 86_400_000
    const NE = "SELECT SUM(usd) v FROM transfers WHERE ts>=? AND NOT EXISTS (SELECT 1 FROM watchlist cpw WHERE cpw.address=transfers.counterparty AND cpw.category='casino')"
    const [gross, cpInternal, notExists] = await Promise.all([
      workerGet<{ v: number }>('SELECT SUM(usd) v FROM transfers WHERE ts>=?', [d7]),
      workerGet<{ v: number }>('SELECT SUM(usd) v FROM transfers WHERE ts>=? AND cp_internal=0', [d7]),
      workerGet<{ v: number }>(NE, [d7]),
    ])
    const g = gross?.v ?? 0
    const ci = cpInternal?.v ?? 0
    const ne = notExists?.v ?? 0
    // how closely the cheap flag reproduces the authoritative definition (1 = identical)
    const agreement = ne > 0 ? 1 - Math.abs(ci - ne) / ne : ci === ne ? 1 : 0
    return {
      firstpass: stateGet('internalflow:firstpass') === '1',
      vol7d: { gross: g, cpInternal: ci, notExists: ne },
      internalExcluded: { byFlag: g - ci, byNotExists: g - ne },
      agreement: Number(agreement.toFixed(4)), // ≥0.98 → marker complete, safe to flip default
      ready: agreement >= 0.98,
    }
  })

  // mention-attribution audit — top watch_labels in the mentions table (7d) and
  // whether each matches a current brand label / member label (the join the
  // sentiment board uses). If matched=false dominates, mention labels drifted
  // from brand labels and the per-operator sentiment shows 0 despite live data.
  app.get('/api/diag/mentions', async () => {
    const d7 = Date.now() - 7 * 86_400_000
    const labels = db
      .prepare('SELECT watch_label, COUNT(*) n FROM mentions WHERE ts >= ? GROUP BY watch_label ORDER BY n DESC LIMIT 60')
      .all(d7) as { watch_label: string; n: number }[]
    const brands = await aggCachedAsync('brand:casino', () => aggregateBrands('casino'), 120_000)
    const brandLabelSet = new Set<string>()
    for (const b of brands as any[]) {
      brandLabelSet.add(b.brand)
      for (const m of b.members ?? []) brandLabelSet.add(m.label)
    }
    const rows = labels.map((l) => ({ ...l, matched: brandLabelSet.has(l.watch_label) }))
    return {
      total7d: labels.reduce((s, l) => s + l.n, 0),
      matched: rows.filter((r) => r.matched).reduce((s, r) => s + r.n, 0),
      unmatched: rows.filter((r) => !r.matched).reduce((s, r) => s + r.n, 0),
      brandLabels: brandLabelSet.size,
      top: rows,
    }
  })

  // enrichment queue (gated) — low-confidence brands kept as noindex pages, awaiting
  // on-chain/reserve/trust enrichment before promotion to indexable.
  app.get('/api/diag/enrichment', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const rows = db.prepare("SELECT brand_key, label, slug, confidence, missing, status, updated_at FROM enrichment_queue WHERE status!='promoted' ORDER BY updated_at DESC LIMIT 500").all()
    return { count: rows.length, items: rows }
  })

  // community submissions (admin) — attribution evidence + correction requests to review
  app.get('/api/diag/submissions', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const rows = db.prepare('SELECT id, type, brand, email, message, evidence_url, status, created_at FROM submission ORDER BY created_at DESC LIMIT 200').all()
    return { count: rows.length, items: rows }
  })

  // risk registry — add/edit a CURATED public incident (admin). A source_url is mandatory;
  // framing stays neutral (on-chain signals are auto-generated separately). List for review.
  app.post('/api/risk-event', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = (req.body ?? {}) as { id?: number; brand?: string; category?: string; severity?: string; title?: string; detail?: string; sourceUrl?: string; operatorResponse?: string; status?: string }
    if (!['hack', 'non_payment', 'insolvency', 'other'].includes(String(b.category))) return reply.code(400).send({ error: 'invalid category' })
    const source = String(b.sourceUrl ?? '').trim()
    if (!/^https?:\/\/.+/.test(source)) return reply.code(400).send({ error: 'a valid source_url is required for an incident' })
    const title = String(b.title ?? '').trim()
    if (title.length < 4) return reply.code(400).send({ error: 'title required' })
    const sev = ['info', 'watch', 'elevated'].includes(String(b.severity)) ? b.severity : 'watch'
    const status = ['open', 'resolved', 'disputed', 'dismissed'].includes(String(b.status)) ? b.status : 'open'
    const now = Date.now()
    if (b.id) {
      db.prepare("UPDATE risk_event SET category=?, severity=?, title=?, detail=?, source_url=?, operator_response=?, status=?, updated_at=? WHERE id=? AND kind='incident'").run(b.category, sev, title, String(b.detail ?? '') || null, source, String(b.operatorResponse ?? '') || null, status, now, b.id)
      return { ok: true, id: b.id }
    }
    const brand = String(b.brand ?? '').trim()
    const info = db.prepare("INSERT INTO risk_event(brand_key, brand_label, kind, category, severity, title, detail, source_url, operator_response, status, observed_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(brandKey(brand), brand || null, 'incident', b.category, sev, title, String(b.detail ?? '') || null, source, String(b.operatorResponse ?? '') || null, status, now, now, now)
    return { ok: true, id: Number(info.lastInsertRowid) }
  })
  app.get('/api/diag/risk-events', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { items: db.prepare('SELECT * FROM risk_event ORDER BY observed_at DESC LIMIT 300').all() }
  })

  // (X auto-publish content pipeline removed — automated social posting retired.)

  // ── alerts: user-defined rules + fired events ────────────────────────────────
  app.get('/api/alerts/rules', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    return db.prepare('SELECT * FROM alert_rules WHERE user_id=? ORDER BY created_at DESC').all(user.id)
  })
  app.post('/api/alerts/rules', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required' })
    const b = req.body as { kind?: string; scope?: string; scopeLabel?: string; threshold?: number; windowH?: number; webhook?: string; notifyEmail?: boolean }
    const kind = b?.kind ?? ''
    if (!['whale', 'netflow', 'reserve_drop'].includes(kind)) return reply.code(400).send({ error: 'invalid kind' })
    if (!(Number(b?.threshold) > 0)) return reply.code(400).send({ error: 'threshold must be > 0' })
    db.prepare(
      `INSERT INTO alert_rules(user_id, kind, scope, scope_label, threshold, window_h, webhook, notify_email, active, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(user.id, kind, b.scope || 'all', b.scopeLabel ?? null, Number(b.threshold), Number(b.windowH ?? 24), b.webhook?.trim() || null, b.notifyEmail === false ? 0 : 1, Date.now())
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
