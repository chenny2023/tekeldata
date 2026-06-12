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
import { startTwitch } from './collectors/twitch.ts'
import { startKick } from './collectors/kick.ts'
import { startReddit } from './collectors/reddit.ts'
import { startLabels } from './collectors/labels.ts'
import { startAggregation } from './aggregate.ts'

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

  // Kick off the live collectors + aggregation
  startEvm() // ETH transfer indexer (public RPC)
  startBackfill() // ETH deep historical backfill (walks back N days)
  if (config.tronMode === 'jsonrpc') {
    startTronRpc() // TRON via EVM-compat eth_getLogs (wide-scan + backfill)
  } else {
    startTron() // TRON via TronGrid REST polling (fallback, TRON_MODE=v1)
  }
  startLabels() // casino-wallet attribution harvester (Etherscan/Tronscan labels)
  startKick() // streamer monitoring (Kick public API, keyless)
  startTwitch() // streamer monitoring (Twitch Helix, optional creds)
  startReddit() // social mentions (Reddit OAuth, optional creds)
  startAggregation()
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
