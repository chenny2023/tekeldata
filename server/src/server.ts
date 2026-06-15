import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { config } from './config.ts'
import { seedWatchlist } from './watchlist.ts'
import { registerApi } from './api.ts'
import { registerAuth } from './auth.ts'
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
import { startDirectory } from './directory.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '../../dist')

async function main() {
  seedWatchlist()

  const app = Fastify({ logger: false })
  await app.register(cors, { origin: true })
  await registerAuth(app)
  await registerApi(app)

  // Serve the built SPA in production (single-process deploy)
  if (config.nodeEnv === 'production' && existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
    console.log('[web] serving built SPA from /dist')
  }

  await app.listen({ port: config.port, host: '0.0.0.0' })
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
  startTwitch() // streamer monitoring (Twitch Helix, optional creds)
  startReddit() // social mentions (Reddit OAuth, optional creds)
  startNews() // brand mentions (Google News RSS, keyless)
  startPress() // brand mentions (iGaming trade-press RSS, keyless)
  startBluesky() // social mentions (Bluesky public post search, keyless)
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
  startDirectory() // casino directory crawler (site/X/email vetting for outreach)

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
  }, 45_000)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
