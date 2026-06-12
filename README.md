# WCOIN.CASINO — The Intelligence Layer for iGaming

A **production-grade, real-data** iGaming analytics platform for casino operators —
a functional fork of the circus.fyi casino-dashboard feature set, restyled in the
WCOIN (`wcoingame.com`) dark / gold / violet aesthetic.

**No mock data.** The platform runs its own on-chain indexer that collects **real
USDT/USDC transfers** on **Ethereum and Tron** for an operator-curated watchlist,
then derives volume, net-flow, whale alerts, on-chain reserves, trust scores and
counterparty segmentation from that live data.

## What is real

| Data | Source | Real? |
|------|--------|-------|
| Deposit/withdrawal transfers | `eth_getLogs` (ETH) + TronGrid (Tron), keyless public endpoints | ✅ live |
| Casino-wallet attributions | Etherscan "gambling" label dump (45+ casinos: 1xBet, Bitsler…) + Tronscan public `addressTag` harvest of top USDT holders | ✅ auto-harvested weekly |
| Volume / inflow / outflow / net-flow | derived from indexed transfers | ✅ |
| On-chain reserves | `balanceOf` (ETH) + account API (Tron) | ✅ live |
| Whale alerts | transfers ≥ $100K, streamed via SSE | ✅ live |
| Unique counterparties / segmentation | derived from transfers | ✅ |
| Streamers (Kick) | Kick public channel API — live status, viewers, followers, casino affiliation parsed from titles/bios | ✅ keyless, live |
| Streamers (Twitch) | official Twitch Helix API | ⚙️ optional (free credentials) |
| Community trust votes | real authenticated user votes (scrypt accounts, sessions) | ✅ built-in |
| Social mentions / sentiment | official Reddit OAuth API + lexicon scoring | ⚙️ optional (free credentials) |
| Trust score | on-chain heuristic (70–100%) blended with community votes (≤30%) | ✅ derived |

The **watchlist is the product's edge**: it ships seeded with real, publicly-documented,
high-volume exchange addresses so you see live data immediately. Add competitor casino
hot-wallet / deposit addresses on the **Watchlist** page (or `POST /api/watchlist`) to
make the leaderboard yours. The indexer treats every watched address identically.

> Trust score (0–100) blends: reserve coverage vs weekly outflow (solvency), inflow/outflow
> balance, on-chain track record (age of observed activity) and liquidity depth. Nothing
> off-chain or social is invented.

## Architecture

```
server/                Node + TypeScript backend (Fastify + better-sqlite3)
  src/
    config.ts          env + keyless RPC defaults
    db.ts              SQLite schema (watchlist, transfers, balances, sync_state, streamers)
    watchlist.ts       real seed addresses
    collectors/
      evm.ts           Ethereum: eth_getLogs over USDT/USDC, RPC rotation, balanceOf reserves
      backfill.ts      deep historical backfill — walks back DEEP_BACKFILL_DAYS with
                       adaptive getLogs ranges; resumes across restarts; rescans when
                       the label harvest grows the watchlist
      tron.ts          Tron: TronGrid TRC20, paginated round-robin + rate-limit backoff
      labels.ts        casino-wallet attribution harvester (Etherscan labels + Tronscan tags)
      kick.ts          Kick streamer monitoring (keyless) + affiliation detection
      twitch.ts        optional Twitch Helix streamer feed
      reddit.ts        optional Reddit OAuth mentions + lexicon sentiment
    aggregate.ts       entity metrics + trust heuristic + community-vote blend
    auth.ts            real accounts (scrypt), sessions, trust votes
    api.ts             REST + SSE (mutations require auth)
    server.ts          boot: seed → collectors → API (+ serves built SPA in prod)
src/                   React 18 + Vite 6 + Tailwind v4 + Recharts frontend
  data/api.ts          typed client, polling hooks, shared SSE live feed
  pages/               Landing, Login, Contact + Overview, Casinos, Blockchain,
                       Streamers, Trust&Reserves, Flow Intel, Watchlist, Reports, API
```

## Run locally

```bash
npm install
npm run dev      # web → http://localhost:5300   ·   api → http://localhost:8787
```

`npm run dev` runs the Vite dev server (proxying `/api` → `:8787`) and the indexer
backend together. Open http://localhost:5300 and watch real transfers stream in.

### Production (single process)

```bash
npm run build    # build the SPA
npm start        # serves /dist + live API + indexers on :8787
```

### Optional configuration

Copy `.env.example` → `.env`. Everything has a working keyless default; add an
`EVM_RPC` (Alchemy/Infura), a `TRONGRID_KEY`, and Twitch credentials for
production reliability and the streamer module.

## API (all live)

```
GET  /api/stats               totals, reserves, chain split
GET  /api/entities            leaderboard (volume, trust, reserves, net flow)
GET  /api/sentiment           blended trust + votes + social mentions
GET  /api/transfers           feed — ?chain=ETH&dir=deposit&min=100000&limit=60
GET  /api/series              6h-bucketed deposit/withdrawal time-series
GET  /api/flow                counterparty segmentation by transfer size
GET  /api/streamers           live + roster streamers (Kick keyless, Twitch optional)
GET  /api/stream              Server-Sent Events — live transfer push
GET  /api/watchlist           list tracked addresses
POST /api/watchlist           add address                    (auth required)
DEL  /api/watchlist/:id       stop tracking                  (auth required)
POST /api/roster              track a Kick/Twitch channel    (auth required)
POST /api/vote                cast trust vote ±1             (auth required)
POST /api/auth/register       { email, password, role } → token (first user = admin)
POST /api/auth/login          { email, password } → token
GET  /api/auth/me             current user
GET  /api/health              indexer status
```

Authentication is real: scrypt-hashed passwords, 30-day opaque session tokens,
and all mutating endpoints require a Bearer token.
