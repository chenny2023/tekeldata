# WCOIN.CASINO — Product Feature & Data Inventory

_Pre-launch inventory of what the product does, the data it holds, and how it's sourced. Live figures captured at review time; they grow continuously._

---

## 1. What it is

**WCOIN.CASINO is the most complete on-chain intelligence layer for iGaming.** It unifies, in one free public dashboard, the data that is otherwise scattered or paywalled:

- **On-chain money flow** for crypto casinos (real deposits/withdrawals across 11 chains)
- **All-chain proof-of-reserves** (Arkham entity attribution)
- **Third-party trust** (casino.guru Safety Index, Trustpilot, AskGamblers)
- **On-chain betting markets** (Polymarket prediction markets + DefiLlama protocols)
- **Social & streamer signal** (Kick / Twitch / YouTube + Reddit/news/forum mentions)
- **A vetted casino directory** (outreach-grade contact data, login-gated)

Everything is derived from public, verifiable sources — no fabricated numbers; sources degrade gracefully to zero when blocked.

---

## 2. Live data volumes (at review time)

| Domain | Metric | Value |
|---|---|---|
| **On-chain transfers** | indexed rows (cumulative) | **~24 M** |
| | chains indexed | **11** (ETH, TRON, Solana, BTC, LTC, XRP, BSC, Base, Arbitrum, Optimism, Avalanche) |
| | watched addresses | **475** |
| | casino on-chain volume (all-time / 7 d) | **$21.6 B / $6.7 B** |
| | global volume across all tracked entities | **$162 B** |
| **Casino entities** | with on-chain flow | **392** |
| | indexed reserves (balances) | **$316 M** |
| **Proof-of-reserves (Arkham)** | casinos with all-chain reserves | **33** · **$559 M** |
| **Casino directory** | catalogued casinos | **990** |
| | live sites verified | **511** |
| | Trustpilot-rated | **335** |
| | casino.guru Safety-Index rated | **30** |
| **Prediction markets (Polymarket)** | live markets | **100** · **$4.4 B** volume |
| **On-chain protocols (DefiLlama)** | betting/lottery/prediction protocols | **96** · **$514 M** TVL |
| **Social** | mentions (Reddit/news/press/Telegram/Bluesky/Lemmy/Bitcointalk/App Store) | **5,659** |
| **Streamers** | tracked (Kick/Twitch/YouTube) | **425** · **85 live** |

---

## 3. Feature areas (frontend)

React SPA; public marketing + login + a code-split dashboard. Routes:

| Route | Page | What it does |
|---|---|---|
| `/` | Landing | Public marketing + live coverage board + transfer ticker |
| `/login` | Login | Passwordless email + 6-digit code sign-in |
| `/app` | **Overview** | Casino market dashboard — headline volume/reserves/players, flow series, top casinos, live streamers |
| `/app/casinos` | Casinos | Entity & brand leaderboard (on-chain volume, reserves, blended trust); expandable per-entity series/flow |
| `/app/directory` | Directory | Vetted casino catalogue + filters + CSV export _(contact data login-gated)_ |
| `/app/markets` | Markets | Prediction markets (live odds + volume) + on-chain protocol TVL |
| `/app/blockchain` | Blockchain | Live transfer explorer (real-time SSE feed) |
| `/app/streamers` | Streamers | Kick/Twitch/YouTube monitor + streamer detail + sponsorship graph |
| `/app/sentiment` | Sentiment | Trust leaderboard + all-chain reserves + community voting |
| `/app/players` | Players | Flow / counterparty segmentation (whale → casual) |
| `/app/watchlist` | Watchlist | Manage tracked addresses _(gated)_ |
| `/app/alerts` | Alerts | Whale / net-flow / reserve-drop alert rules + event feed _(gated)_ |
| `/app/reports` | Reports | On-demand CSV/JSON export |
| `/app/api` | API Access | API docs + live health panel |

Global: cross-entity search + whale-activity notifications in the header; one shared SSE live feed.

---

## 4. API surface

Public read endpoints (Cloudflare-cached) + gated write/contact endpoints (Bearer token).

**Public:** `/api/health`, `/api/stats`, `/api/entities`, `/api/casinos`, `/api/brands`, `/api/coverage`, `/api/search`, `/api/notifications`, `/api/protocols`, `/api/predictions`, `/api/arkham/reserves`, `/api/reserves`, `/api/transfers`, `/api/series`, `/api/entity/:id/series`, `/api/entity/:id/flow`, `/api/flow`, `/api/sponsorships`, `/api/streamers`, `/api/streamer`, `/api/sentiment`, `/api/watchlist` (GET), `/api/directory/overview`, `/api/stream` (SSE), `/api/auth/*`.

**Gated (auth):** `/api/directory` + `/api/directory/export.csv` (contact data), `/api/roster` (POST), `/api/watchlist` (POST/DELETE), `/api/alerts/rules` (CRUD), `/api/alerts/events`, `/api/vote`.

> ⚠️ Pre-launch: `/api/directory/unlockertest` and `/api/directory/arkhamtest` are currently public and side-effecting — see ARCHITECTURE_REVIEW ST-2 (gate/remove).

---

## 5. Data sources & collectors

All run in-process as background loops; all keyless-by-default (optional keys/proxies upgrade coverage).

**Chain indexers (on-chain flow + reserves):**
- ETH transfer indexer + native ETH deposits + deep historical backfill
- TRON (eth_getLogs wide-scan + backfill)
- Extra EVM chains: BSC, Base, Arbitrum, Optimism, Avalanche
- Solana (SPL USDC/USDT + native SOL), Bitcoin + Litecoin (Esplora), XRP Ledger
- Historical price series for non-1:1 valuation

**Attribution & reserves:**
- **Arkham** — entity attribution → all-chain reserves + 7-day cross-chain volume + hot-wallet harvesting into the indexer
- Etherscan/Tronscan label harvest, Wayback name-tag attribution, circus.fyi whale-feed resolution, service-overlap classification

**Trust & directory:**
- casino.guru Safety Index, Trustpilot category sweep (via paid web-unlocker), AskGamblers
- casino.guru spider (fans the directory to thousands), directory site/X/email vetting

**Markets:** DefiLlama (on-chain betting/lottery/prediction protocols), Polymarket (top markets)

**Social & streamers:** Kick, Twitch (keyless GraphQL), YouTube (scrape), X/Twitter (syndication timeline), Reddit, Google News, trade-press RSS, Bluesky, GDELT, Bitcointalk, Lemmy, Telegram, Apple App Store reviews; casino-token market data (CoinGecko); OFAC risk flags.

**Maintenance:** aggregation + warmer, user alerts engine, retention prune, daily reserve-history snapshots.

---

## 6. Data model (SQLite)

| Table | Purpose | Growth |
|---|---|---|
| **transfers** | every indexed on-chain transfer touching a watched address | **unbounded** (dominates storage) |
| watchlist | watched addresses (casino/exchange/whale/service) | slow |
| balances | per-watch reserve USD | bounded (= watchlist) |
| sync_state | indexer cursors + persisted headline stats | static |
| streamers / streamer_roster | live streamer status + poll roster | bounded / slow |
| users / sessions / verification_codes / votes | passwordless auth + voting | slow |
| prices | daily close per asset | slow |
| risk_addresses / risk_flags | OFAC list + per-watch exposure | bounded |
| reviews / reserve_history / arkham_casino / arkham_reserve_history | trust ratings + reserve trend snapshots | slow |
| casino_directory / crawl_queue | outreach directory + spider queue | slow |
| onchain_protocol / prediction_market | DefiLlama / Polymarket snapshots | bounded |
| alert_rules / alert_events | user alerts + fired events | slow (events un-pruned) |
| mentions | social/news mentions | slow |

> `transfers` is effectively 100% of on-disk size; everything else is KB–MB. See ARCHITECTURE_REVIEW §2.4 for indexing/retention/backup.

---

## 7. Deployment & configuration

- **Runtime:** one Node 20 container on Railway (Docker → `npm ci` → `vite build` → `tsx` runs the TS server) + a mounted volume for the SQLite file, behind Cloudflare (`wcoin.casino`). Single replica (volume-bound).
- **Auth:** passwordless email-code → 30-day Bearer token; rate-limited.
- **Config:** every env var has a working keyless default — an empty env still boots and collects real data. Keys/proxies (Arkham, ScraperAPI unlocker, Webshare/residential proxies, SMTP/Resend, Twitch) only widen coverage. Full env-var inventory in the ops audit; standardise `arkham` → `ARKHAM_API_KEY` before launch.
- **Edge caching:** hashed assets immutable 1 yr; `index.html` no-cache; public `/api/*` `max-age=120, stale-while-revalidate=1800`.

---

## 8. Launch-readiness snapshot

| Area | Status |
|---|---|
| Feature completeness | ✅ Broad — on-chain flow, reserves, trust, markets, social, directory, alerts |
| Data coverage | ✅ Strong & growing (990 casinos, 11 chains, $559 M reserves, 100 markets, 425 streamers) |
| Performance (steady state) | ✅ Cloudflare-served pages 90–400 ms |
| Performance (cold/under-load) | ⚠️ Occasional 15–45 s stalls when a heavy read blocks the single thread → worker-thread fix |
| Stability | ⚠️ No process-level error guard / error boundary; 2 public diagnostic endpoints |
| Data durability | ❌ **No backups** — top launch blocker |
| Observability | ❌ console.log only — no metrics/alerts |
| Storage headroom | ⚠️ 77% full, retention not yet effective |

→ See `ARCHITECTURE_REVIEW.md` §3 for the prioritised launch checklist.
