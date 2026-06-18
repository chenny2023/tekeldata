import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { config } from './config.ts'
import { db } from './db.ts'
import { startMonitor } from './monitor.ts'
import { registerRateLimit } from './ratelimit.ts'
import { startReadWorker } from './readpool.ts'
import { seedWatchlist } from './watchlist.ts'
import { registerApi } from './api.ts'
import { registerAuth, reconcileAdmins } from './auth.ts'
import { registerSubscribe } from './subscribe.ts'
import { registerCasinoAlert, startCasinoAlerts } from './casinoalert.ts'
import { startRiskEvents } from './riskevents.ts'
import { startDigest, registerDigest } from './digest.ts'
import { startEvm } from './collectors/evm.ts'
import { startBackfill } from './collectors/backfill.ts'
import { startTron } from './collectors/tron.ts'
import { startTronRpc } from './collectors/tronrpc.ts'
import { startEvmChains } from './collectors/evmchains.ts'
import { startTwitch } from './collectors/twitch.ts'
import { startKick } from './collectors/kick.ts'
import { startReddit } from './collectors/reddit.ts'
import { startNews } from './collectors/news.ts'
import { startPress } from './collectors/press.ts'
import { startTelegram } from './collectors/telegram.ts'
import { startReviews } from './collectors/reviews.ts'
import { startRisk } from './collectors/risk.ts'
import { startLabels } from './collectors/labels.ts'
import { startWayback } from './collectors/wayback.ts'
import { startCircus } from './collectors/circus.ts'
import { startPrices } from './collectors/prices.ts'
import { startNative } from './collectors/native.ts'
import { startBluesky } from './collectors/bluesky.ts'
import { startTwitter } from './collectors/twitter.ts'
import { startGdelt } from './collectors/gdelt.ts'
import { startBitcointalk } from './collectors/bitcointalk.ts'
import { startCasinoTokens } from './collectors/casinotokens.ts'
import { startAppStore } from './collectors/appstore.ts'
import { startLemmy } from './collectors/lemmy.ts'
import { startSolana } from './collectors/solana.ts'
import { startUtxo } from './collectors/utxo.ts'
import { startXrp } from './collectors/xrp.ts'
import { startAggregation } from './aggregate.ts'
import { startAlerts } from './alerts.ts'
import { startRetention } from './retention.ts'
import { startReserveHistory } from './reservehistory.ts'
import { startSnapshots } from './snapshot.ts'
import { registerSeo, startSeo } from './seo.ts'
import { startBrandStore } from './brandstore.ts'
import { startContent } from './content/pipeline.ts'
import { startDailyInsight } from './content/dailyinsight.ts'
import { startDirectory } from './directory.ts'
import { startGuruSpider } from './collectors/guruspider.ts'
import { startTrustpilotCategory } from './collectors/trustpilotcat.ts'
import { startArkham } from './collectors/arkham.ts'
import { startDefiLlama } from './collectors/defillama.ts'
import { startPolymarket } from './collectors/polymarket.ts'
import { startYouTube } from './collectors/youtube.ts'
import { startStatsMaintenance } from './aggregate.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '../../dist')

async function main() {
  seedWatchlist()

  const app = Fastify({ logger: false })
  // Lock CORS to our own origins in production (auth is a Bearer token, but there's
  // no reason to reflect arbitrary origins). Dev allows localhost.
  const allowedOrigins = (process.env.CORS_ORIGINS ||
    'https://wcoin.casino,https://www.wcoin.casino,https://wcoin-production.up.railway.app')
    .split(',').map((s) => s.trim()).filter(Boolean)
  await app.register(cors, {
    origin: config.nodeEnv === 'production'
      ? (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) // !origin = same-origin/curl
      : true,
  })
  registerRateLimit(app) // per-IP API rate limiting (defense-in-depth behind CF)
  await registerAuth(app)
  reconcileAdmins() // pin admin to the email allowlist (promote owner, demote strays)
  await registerApi(app)
  registerSubscribe(app) // email digest subscription (double opt-in)
  registerCasinoAlert(app) // per-casino public reserve-alert subscription (double opt-in)
  registerDigest(app) // admin digest preview + test send
  // Phase 2 SEO: stored, server-rendered landing pages + dynamic sitemap. MUST be
  // registered BEFORE fastifyStatic/notFoundHandler so /casino, /rankings, /chains,
  // /methodology and /sitemap.xml are served as real HTML, not the SPA shell.
  registerSeo(app)

  // Serve the built SPA in production (single-process deploy). Vite emits
  // content-hashed asset filenames, so they're safe to cache hard (immutable);
  // index.html must stay no-cache so a new deploy's asset hashes are picked up.
  if (config.nodeEnv === 'production' && existsSync(distDir)) {
    await app.register(fastifyStatic, {
      root: distDir,
      wildcard: false,
      // set Cache-Control per file (NOT via the global maxAge — it overrides
      // setHeaders): content-hashed assets are immutable for a year, but
      // index.html must revalidate so new deploys' asset hashes are picked up.
      setHeaders: (res, path) => {
        // hashed build assets are immutable; index.html must revalidate; the
        // unhashed root files (robots/sitemap/llms/og/favicon) get a moderate TTL
        // so updates propagate without re-downloading the big JS every visit.
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
        else if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        else res.setHeader('Cache-Control', 'public, max-age=3600')
      },
    })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' })
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
    })
    console.log('[web] serving built SPA from /dist')
  }

  await app.listen({ port: config.port, host: '0.0.0.0' })

  // Start the read-only analytics worker right after listen (cheap thread spawn) so
  // heavy reads are offloaded before the first request and before maintenance.
  startReadWorker()

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // The service has a mounted volume, so Railway deploys with a recreate
  // strategy: it SIGTERMs the old container before starting the new one. Without
  // a handler, a SIGTERM landing mid synchronous bulk-insert can't be processed
  // until that blocking C++ call returns; if Railway's grace window expires it
  // SIGKILLs us → exit 137, which Railway flags as "Crashed" on every deploy, and
  // the hard kill leaves a dirty WAL the next boot must recover. Here we stop the
  // listener, checkpoint+truncate the WAL so the next container opens a clean DB,
  // close the handle, and exit 0 — a clean handover, no crash flag.
  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] ${sig} received — draining…`)
    const done = () => {
      try {
        // when litestream owns the WAL, let it do the final checkpoint/replicate;
        // truncating here could drop frames it hasn't shipped to R2 yet
        if (!config.backupActive) db.pragma('wal_checkpoint(TRUNCATE)')
        db.close()
        console.log('[shutdown] DB closed — bye')
      } catch (e) {
        console.warn('[shutdown] checkpoint/close failed:', (e as Error).message)
      }
      process.exit(0)
    }
    // hard cap so a blocked loop can't hang the handover past Railway's grace
    const t = setTimeout(done, 4_000)
    t.unref?.()
    try {
      await app.close()
    } catch {
      /* ignore */
    }
    clearTimeout(t)
    done()
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  const primaryRpc = new URL(config.evmRpcs[0]).host
  const tronHost =
    config.tronMode === 'jsonrpc' ? new URL(config.tronJsonRpc).host : new URL(config.tronApi).host
  console.log(`\n  WCOIN.CASINO API  ➜  http://localhost:${config.port}/api/health`)
  console.log(`  Indexing chains:  ETH (${primaryRpc}) + TRON (${tronHost}, ${config.tronMode})\n`)

  // Defer the heavy indexers ~45s after the server is listening. better-sqlite3
  // is synchronous, so a hard backfill (10k+ inserts/tick) starves Node's single
  // event loop — which previously timed out Railway's deploy healthcheck before
  // it could pass. Letting /api/health go green first, then indexing, avoids that.
  setTimeout(() => {
  startMonitor() // built-in disk / event-loop-lag / DB-size self-monitor (+ optional webhook)
  startEvm() // ETH transfer indexer (public RPC)
  startPrices() // daily historical price series (SOL) for non-1:1 valuation
  startNative() // native-coin (ETH) deposits — full-block scan, block-time priced
  startSolana() // Solana indexer (SPL USDC/USDT + native SOL, historically priced)
  startUtxo() // Bitcoin + Litecoin indexers (Esplora, historically priced)
  startXrp() // XRP Ledger indexer (account_tx, historically priced)
  startLabels() // casino-wallet attribution harvester (Etherscan/Tronscan labels)
  startWayback() // etherscan-nametag attribution via Wayback snapshots (keyless)
  startCircus() // casino attribution via circus.fyi whale-feed → on-chain tx resolution
  startKick() // streamer monitoring (Kick public API, keyless)
  startTwitch() // streamer monitoring (Twitch public GraphQL, keyless)
  startYouTube() // streamer monitoring (YouTube channel-page scrape, keyless)
  startReddit() // social mentions (Reddit OAuth, optional creds)
  startNews() // brand mentions (Google News RSS, keyless)
  startPress() // brand mentions (iGaming trade-press RSS, keyless)
  startBluesky() // social mentions (Bluesky public post search, keyless)
  startTwitter() // X/Twitter official-account activity (syndication widget, keyless)
  startGdelt() // brand mentions (GDELT global news index, keyless)
  startBitcointalk() // social mentions (Bitcointalk gambling forum, keyless)
  startAppStore() // user reviews (Apple App Store, keyless — apps that exist)
  startLemmy() // user social (Lemmy federated, keyless — unblocked Reddit alt)
  startTelegram() // brand community signal (public Telegram channels, keyless)
  startReviews() // third-party trust: casino.guru Safety Index per casino
  startCasinoTokens() // casino-token market data (CoinGecko, keyless)
  startRisk() // compliance: OFAC-sanctioned counterparty exposure flags
  startAggregation()
  startAlerts() // user-defined alert rules: whale stream + net-flow / reserve checks
  startRetention() // periodic prune of transfers past the retention window
  startReserveHistory() // daily solvency snapshots → reserve-adequacy trend
  startCasinoAlerts() // per-casino reserve-drop alert emails to public subscribers
  startRiskEvents() // risk-event registry: auto on-chain signals + curated incidents
  startSnapshots() // 1.0 content layer: daily market snapshot (homepage + email source)
  startDailyInsight() // LLM "Today's Market Read" + Notable Signals for the daily report (QA-gated)
  startDigest() // 1.0 daily email digest scheduler (sends at DIGEST_SEND_HOUR_UTC)
  startSeo() // Phase 2: rebuild stored SEO landing pages from the warm aggregate cache
  startBrandStore() // 1.0: materialise the persistent brand layer (history / audit)
  startContent() // automated X content pipeline (OpenRouter Grok → QA → publish) — off until CONTENT_ENABLED=1
  startDirectory() // casino directory crawler (site/X/email vetting for outreach)
  startGuruSpider() // casino.guru spider — fans the directory out to thousands of casinos
  startTrustpilotCategory() // Trustpilot casino-category sweep — merges consumer ratings onto the directory
  startArkham() // Arkham on-chain attribution — all-chain reserves/volume per casino entity
  startDefiLlama() // DefiLlama — on-chain prediction markets / lotteries / betting protocols
  startPolymarket() // Polymarket — top prediction markets (live odds + volume)

  // Second wave (+90s): the HEAVY deep-backfill indexers. Their synchronous bulk
  // inserts are what saturate the single Node loop on boot and make the API
  // unresponsive — so we let the forward indexers + API warm up first, then start
  // the catch-up. They also self-throttle once caught up.
  setTimeout(() => {
    startBackfill() // ETH deep historical backfill (walks back N days)
    if (config.tronMode === 'jsonrpc') {
      startTronRpc() // TRON via EVM-compat eth_getLogs (wide-scan + backfill) — heaviest
    } else {
      startTron() // TRON via TronGrid REST polling (fallback, TRON_MODE=v1)
    }
    startEvmChains() // extra EVM chains (BSC, Base, Arbitrum, Optimism) — backfill each
  }, 90_000)
  // Third wave (+180s): background player/first-seen maintenance. Starts LAST,
  // long after /api/health has gone green, so its first heavy pass never blocks
  // the deploy healthcheck (running it pre-listen crashed the deploy).
  setTimeout(() => void startStatsMaintenance(), 180_000)
  }, 45_000)
}

// Single-process resilience: one unguarded rejection/throw in any of ~40
// collectors must NOT take down the whole service (there is no second replica).
// Log and keep running — the failing collector retries on its own loop.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err)
})

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
