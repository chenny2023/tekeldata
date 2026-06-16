# WCOIN.CASINO — Pre-Launch Architecture Review

_Prepared for the formal launch readiness review. Covers stability, performance, scalability and data-storage across backend runtime, data layer, frontend, and deployment/ops. Synthesised from a four-track code audit + live measurements._

---

## 0. Executive summary

WCOIN.CASINO is a **single Node 20 process** that simultaneously runs a Fastify API, ~40 background data collectors, and serves the built React SPA — all backed by **one synchronous SQLite file** (better-sqlite3, ~24M rows / ~7.7 GB) on a Railway volume behind Cloudflare.

**The design is coherent and well-instrumented for its stage.** The hard work already done is real: deferred boot "waves", chunked/yielding inserts, stale-while-revalidate aggregate caching, a background warmer, background player-count maintenance, WAL discipline, graceful shutdown, Cloudflare edge caching, and broad keyless-collector resilience (backoff, RPC/proxy rotation, adaptive ranges).

**The single architectural fact that dominates everything:** better-sqlite3 is synchronous and Node is single-threaded, so **any heavy query blocks the entire event loop** — every HTTP request, the healthcheck, and SIGTERM handling. This one fact is the root of the residual dashboard stalls (observed 15–45 s on a trivial endpoint when a heavy read lands) and the deploy "Crashed" status (SIGTERM cannot be serviced mid-query → SIGKILL).

**Launch verdict: NOT YET — three operational P0s must close first**, all low-risk:
1. **No volume backup** → volume loss = total data loss (months of indexing). _#1 blocker._
2. **No observability/alerting** → silent failures, no disk/crash signal.
3. **Disk at 77% and growing**, retention not yet effective.

Plus four cheap code-level P0s (below). The one **structural** investment to schedule soon (not a launch blocker) is **moving heavy reads to a read-only worker thread**, which closes both the stall and the deploy-crash windows at once.

---

## 1. System architecture (as built)

```
                          Cloudflare (edge cache: public /api/* + static)
                                       │
                          ┌────────────▼─────────────┐   Railway (1 container, 1 replica)
                          │   Single Node 20 process  │
                          │  ┌─────────────────────┐  │
   browsers ── HTTPS ───► │  │ Fastify API + SPA   │  │
                          │  │ (/api/*, /dist)     │  │
                          │  ├─────────────────────┤  │      ┌──────────────────────┐
   chains/APIs ◄─ fetch ──┤  │ ~40 collectors      │  ├─────►│ better-sqlite3 (WAL)  │
   (proxied)              │  │ (indexers, scrapers)│  │      │ wcoin.db  ~7.7 GB     │
                          │  ├─────────────────────┤  │      │ on mounted volume     │
                          │  │ aggregation + warmer│  │      └──────────────────────┘
                          │  │ + stats maintenance │  │
                          │  └─────────────────────┘  │
                          │   ONE event loop, ONE DB  │
                          └───────────────────────────┘
```

- **Boot is staggered** (`server.ts`): listen + cheap healthcheck immediately → wave 1 (+45 s) forward indexers + social/web/Arkham/directory → wave 2 (+90 s) heavy deep-backfillers → wave 3 (+180 s) per-entity player-count maintenance. This exists so the deploy healthcheck goes green before synchronous bulk inserts saturate the loop.
- **Caching is layered**: in-process SWR `aggCache` (computes once cold, then serves stale + refreshes off the request path) + a sequential 5-min warmer for hot keys + 6 h / 1 h caches for the most expensive scans + Cloudflare `max-age=120, stale-while-revalidate=1800` on public GETs.
- **Reads and writes share one thread**; WAL allows concurrent readers in principle but there is only one thread to read on.

---

## 2. Findings by dimension

Severity: **P0** = fix before launch · **P1** = fix shortly after / hardening · **P2** = nice-to-have.

### 2.1 Stability

| ID | Sev | Finding | Location |
|----|-----|---------|----------|
| ST-1 | **P0** | **No `unhandledRejection` / `uncaughtException` guard.** One unguarded rejection in any of ~40 collectors takes down the only process (no replica). | `server.ts` (process setup) |
| ST-2 | **P0** | **Two public, side-effecting diagnostic endpoints.** `/api/directory/unlockertest?url=` spends paid ScraperAPI credits and proxies arbitrary URLs (credit-drain / SSRF-ish); `/api/directory/arkhamtest?path=` proxies arbitrary paths to Arkham **with your API key** and returns the raw body. | `api.ts` (`unlockertest`, `arkhamtest`) |
| ST-3 | P1 | **SIGTERM during a long synchronous read still → SIGKILL.** The graceful handler is correct but its 4 s self-cap timer can't fire while the loop is blocked in a C++ SQLite call. Residual blockers: uncached heavy endpoints + per-entity `COUNT(DISTINCT)` maintenance. (This is the deploy-"Crashed" symptom.) | `server.ts` shutdown; `aggregate.ts` maintenance |
| ST-4 | P1 | **No React error boundary** — a render-time throw (e.g. malformed payload during a backend freeze) blanks the whole app to a white screen. | `src/main.tsx`, `src/App.tsx` |
| ST-5 | P1 | **Pages ignore the API `error` channel** — a 500/502 during a freeze leaves a perpetual skeleton with silent full-rate retries. | `src/data/api.ts` `usePoll`; most pages |
| ST-6 | P2 | **SSE has no backpressure** — a slow client during a TRON burst buffers unboundedly in-process. | `api.ts` `/api/stream` |
| ST-7 | P2 | **Unbounded synchronous overlap compute** in service classification (nested `Set` loops, no yield). | `collectors/labels.ts` `classifyServices()` |
| ST-8 | P2 | **One-shot unbounded `DELETE FROM transfers WHERE chain='TRON'`** on the v1→jsonrpc migration (single huge transaction). | `collectors/tronrpc.ts` `migrateFromV1()` |

### 2.2 Performance

| ID | Sev | Finding | Location |
|----|-----|---------|----------|
| PF-1 | P1 | **Per-entity `COUNT(DISTINCT counterparty)` maintenance** is the right pattern (index-backed, yields between entities) but a single Stake-scale wallet makes one iteration multi-second, and per-iteration cost grows as the watchlist widens (Arkham harvest). | `aggregate.ts` maintenance loop |
| PF-2 | P1 | **Uncached heavy endpoints on the request path**: `/api/entity/:id/flow` (2× GROUP BY + LEFT JOIN, pulls every counterparty into JS), `/api/entity/:id/series`, `/api/transfers` (user-controlled filters). Each blocks the loop for the query's duration. | `api.ts` |
| PF-3 | P1 | **Cold-cache compute still blocks once per key** — `computeEntities` runs several full 7 d GROUP BY scans in one synchronous stretch (the 12–16 s freeze the warmer pre-pays). | `aggregate.ts` `computeEntities` |
| PF-4 | P1 | **Frontend polling never pauses on hidden tabs** — backgrounded tabs hammer `stats`@12 s, `events`@8 s, etc. indefinitely; pure avoidable origin load on a single-threaded backend. | `src/data/api.ts` `usePoll` |
| PF-5 | P1 | **No client-side dedup** — `stats`/`casinos` are independently re-fetched by 3–4 mounted components; **Casinos** fetches both `casinos('all')` and `brands('all')` @15 s though only one view shows. | `src/pages/*`, `src/data/api.ts` |
| PF-6 | P2 | **recharts not isolated into a shared vendor chunk** (no `manualChunks`), risking duplication across page chunks. | `vite.config.ts` |
| PF-7 | P2 | **`useLiveFeed` re-renders every consumer per SSE message** (no batching). | `src/data/api.ts` |
| PF-8 | ✅ | Already good: cheap `MAX(id)` healthcheck, SWR cache, hourly-cached distinct-chain count, SQL-bucketed `/api/flow`, retention prune batching. | — |

### 2.3 Scalability

| ID | Sev | Finding |
|----|-----|---------|
| SC-1 | P1→struct | **Hard ceiling: exactly one replica.** Volume-backed SQLite cannot scale horizontally; the in-memory caches/maps/SSE bus all assume one process. Vertical scaling only, and it's near its useful limit (7.7 GB DB, single event loop). |
| SC-2 | **P1 (structural)** | **Move heavy reads to a read-only worker thread** (better-sqlite3 can open the same WAL file read-only off-thread). This takes _all_ analytic reads off the main loop → the healthcheck and writes are never blocked by a query → closes both the deploy-crash residual (ST-3) and the stall (PF-1/2/3). Highest-leverage structural change. |
| SC-3 | P2 | **Migration path to real scale**: Postgres (Railway-managed) for relational/query data + chain indexing in a worker → unlocks horizontal API replicas and removes event-loop coupling. SQLite-in-process is defensible _for launch_ but a known growth dead-end. |
| SC-4 | ✅ | Collector concurrency/rate-limiting is solid: adaptive ranges with bisect-on-error, exponential backoff, consecutive-fail backoff to 30 min, RPC + proxy/residential/unlocker rotation, chunked yielding inserts. |

### 2.4 Data & storage

| ID | Sev | Finding | Location |
|----|-----|---------|----------|
| DS-1 | **P0** | **No backup of the SQLite volume.** No litestream / scheduled dump / off-volume copy. Volume loss or corruption = 100% data loss (months of backfill/attribution), re-indexable only over days/weeks. | ops |
| DS-2 | **P0** | **Disk 77% (7.7 GB / 10 GB) and growing**; `RETAIN_DAYS` only just set to 45 but the data isn't 45 d old yet, so nothing prunes — the file is still climbing toward the 10 GB ceiling (→ `disk I/O error`, write failures). | volume + `config.ts` |
| DS-3 | P1 | **Missing `(category, ts)` index** → casino-filtered counts do a full 24 M-row scan (cached 6 h, so off the hot path, but each refresh scans the whole table). | `db.ts` |
| DS-4 | P1 | **`idx_transfers_counterparty` is unused** (no equality filter on counterparty anywhere) — a full high-cardinality btree over 24 M rows wasting disk + write-amplification on every insert. **Drop it.** | `db.ts` |
| DS-5 | P1 | **No online reclaim path.** DB is not `auto_vacuum`; a full `VACUUM` needs ~free space = DB size (~8 GB) → impossible in place at 77%. Retention caps _growth_ but the high-water never recedes without an **offline** VACUUM. | `db.ts` |
| DS-6 | ✅ | Write path is sound: `UNIQUE(chain,tx_hash,log_index,watch_id)` + `INSERT OR IGNORE` (idempotent re-indexing), proper upserts, additive try/catch migrations, WAL capped at 64 MB + autocheckpoint, crash-safe recovery. | `db.ts` |

### 2.5 Security / ops

| ID | Sev | Finding |
|----|-----|---------|
| SE-1 | P1 | **CORS `origin: true`** reflects any origin. Auth is Bearer (not cookie) so CSRF surface is limited, but lock to `https://wcoin.casino`. |
| SE-2 | P1 | **`arkham` is read as a lowercase env var** — fragile/inconsistent. Standardise on `ARKHAM_API_KEY`. |
| SE-3 | P2 | No CSP / SRI on third-party scripts (HireCX widget, Google Fonts). |
| SE-4 | P2 | **`admin` role assigned to first user but never enforced** — dead authorization. Remove or wire up. |
| SE-5 | ✅ | No hardcoded secrets; `.env` git- & docker-ignored; gated outreach endpoints require auth; dev sign-in code suppressed when `NODE_ENV=production`; rate-limited passwordless auth. |

---

## 3. Consolidated launch checklist (prioritised)

### P0 — must close before public launch
- [ ] **DS-1 Backups.** Add continuous SQLite replication (litestream → S3/R2) **or** a nightly `VACUUM INTO` + off-volume upload; verify a restore. _(needs object-storage creds)_
- [ ] **DS-2 Disk cap.** Lower `RETAIN_DAYS` to a value below current data age so pruning actually engages (recommend **21–30**); alert at 85% disk.
- [ ] **Observability.** Error tracking (Sentry), uptime monitor on `/api/health`, disk-usage + deploy-status alert → Slack/email. _(needs Sentry/monitor accounts)_
- [ ] **ST-2** Gate or remove the two public diagnostic endpoints (`unlockertest`, `arkhamtest`). _(code — safe)_
- [ ] **ST-1** Add `unhandledRejection`/`uncaughtException` guards (log, don't exit). _(code — safe)_
- [ ] **ST-4** Add a React error boundary with a fallback UI. _(code — safe)_
- [ ] **PF-4** Pause polling on hidden tabs in `usePoll`. _(code — safe)_
- [ ] **ST-5** Surface API errors on the dashboard instead of frozen skeletons. _(code — safe)_

### P1 — hardening (first weeks)
- [ ] **SC-2** Move heavy reads + `COUNT(DISTINCT)` maintenance to a read-only worker thread. _(structural — the big win)_
- [ ] **PF-2** Cache `/api/entity/:id/series` + `/api/entity/:id/flow` (keyed `id:days`, 120 s) and add to `PUBLIC_CACHEABLE`. _(code — safe)_
- [ ] **DS-4 → DS-3** Drop unused `idx_transfers_counterparty` to reclaim space, **then** build `idx_transfers_cat_ts(category, ts)` off-hours in the freed headroom (not via boot DDL — the build blocks the loop). _(needs maintenance window)_
- [ ] **DS-5** Schedule a one-time **offline VACUUM** to recover the high-water (stop service, copy DB off-volume, VACUUM, swap back). _(maintenance window)_
- [ ] **SE-1** Lock CORS to the production origin. **SE-2** Rename `arkham` → `ARKHAM_API_KEY`.
- [ ] **PF-5** Client dedup/shared cache; fetch only the active view in Casinos.
- [ ] **PF-1 backbackoff** on the client; distinguish 401 from 5xx so a transient freeze doesn't force logout.
- [ ] **ST-8** Batch the TRON migration delete; **ST-7** yield in `classifyServices()`.

### P2 — polish
- [ ] recharts vendor chunk + lazy charts; SSE re-render batching; list virtualization at scale.
- [ ] CSP/SRI; remove/enforce `admin` role; accessibility (aria-labels, modal focus-trap/Esc); ship compiled JS instead of tsx in prod; `alert_events` retention.

---

## 4. The one structural recommendation

Everything painful at runtime (dashboard stalls, deploy "Crashed") traces to **analytic reads on the same thread as the API + writes**. The targeted fix is a **read-only worker thread**:

- Open a second better-sqlite3 handle **read-only** on the same WAL file inside a `worker_thread`.
- Move there: `computeEntities`/`computeBrands`/`computeSeries`/`computeFlow`, the `/api/entity/*` queries, and the per-entity `COUNT(DISTINCT)` maintenance.
- The main thread keeps: HTTP, light queries, all **writes** (collectors), the SWR cache (now fed by worker results).

Effect: the event loop is never blocked by an analytic query → `/api/health` and SIGTERM are always responsive (no more SIGKILL/"Crashed"), and cold/heavy reads no longer stall the dashboard. It is the cleanest path that closes ST-3, PF-1, PF-2 and PF-3 together, without touching the write path or the data model. When growth eventually exceeds one box, the follow-on is Postgres + horizontal API replicas (SC-3).

_Effort: L · Risk: Medium · Recommended as the first post-launch engineering project._
