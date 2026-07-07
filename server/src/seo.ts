import { FastifyInstance } from 'fastify'
import { db, externalFlowClause } from './db.ts'
import { aggregateBrands, blendedTrustScore, type BrandAgg } from './aggregate.ts'
import { workerAll } from './readpool.ts'
import { runDataQualityChecks } from './dataquality.ts'
import { brandKey, brandName, matchCasinoMeta, type CasinoMeta } from './casinometa.ts'
import { reviewScores, type ReviewScore } from './collectors/reviews.ts'
import { reserveSeries } from './reservehistory.ts'
import { brandRiskEvents, recentRiskEvents, type RiskEvent } from './riskevents.ts'
import { pingIndexNow } from './indexnow.ts'
import type { TokenInfo } from './collectors/casinotokens.ts'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — data-led SEO pages. We pre-render REAL, indexable HTML for high-value
// page types and store it in seo_page, then serve it from Fastify AHEAD of the SPA
// so search engines and AI answer engines get content + internal links (the SPA is
// a JS shell crawlers see as near-empty). Pages are rebuilt on a timer from the
// already-warm aggregate cache, so a request is one PK read.
//
// Page types: /casino/{slug} (on-chain + multi-source ratings, merged), /rankings
// (leaderboards + index), /chains/{slug}, /reports/daily/{date} (snapshot archive),
// /methodology/{topic}.
//
// Liability: every page presents OBSERVED on-chain activity and ATTRIBUTED
// third-party ratings (with sources). It never asserts a verdict on any named
// operator (safe / scam / solvent / legal). The methodology note is on every page.
// Each casino page must clear a data-sufficiency gate (≥1 real rating or on-chain
// signal) — no thin, template-only pages.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = 'https://wcoin.casino'
// current year for rolling leaderboard titles (variable, never hard-coded) — §3.3
const YEAR = new Date().getUTCFullYear()
// Entity review pages (answer-first per-operator pages: is-X-safe / does-X-pay-out /
// X-proof-of-reserves). Highest explicit intent + most AI-citable. `slug` is the URL
// slug; `match` lowercased-key matches the brand in our views. Shared by the generator
// loop and the route registration so the two never drift.
const ENTITY_REVIEW: { name: string; slug: string }[] = [
  { name: 'Stake', slug: 'stake' },
  { name: 'Roobet', slug: 'roobet' },
  { name: 'BC.Game', slug: 'bc-game' },
  { name: 'Rollbit', slug: 'rollbit' },
  { name: 'Metaspins', slug: 'metaspins' },
  { name: 'Duelbits', slug: 'duelbits' },
  { name: 'Gamdom', slug: 'gamdom' },
  { name: 'Shuffle', slug: 'shuffle' },
  { name: 'Cloudbet', slug: 'cloudbet' },
  { name: 'TrustDice', slug: 'trustdice' },
]
const ENTITY_REVIEW_SLUGS = ENTITY_REVIEW.map((e) => e.slug)
// stable publish date for evergreen guides (dateModified tracks the live refresh)
const GUIDE_PUBLISHED = '2026-06-25T00:00:00Z'

// §3.2 JSON-LD helpers. Dataset = highest information-gain schema for a data site;
// ItemList = leaderboards. Only VERIFIED on-chain figures feed these (never claimed).
function datasetLd(name: string, description: string, url: string, modified: number, variableMeasured: string[]): object {
  return {
    '@type': 'Dataset',
    name,
    description,
    url,
    dateModified: new Date(modified).toISOString(),
    creator: { '@id': SITE + '/#org' },
    isAccessibleForFree: true,
    license: 'https://wcoin.casino/methodology/address-attribution',
    variableMeasured,
  }
}
function itemListLd(items: { url: string; name: string }[]): object {
  return {
    '@type': 'ItemList',
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: it.url, name: it.name })),
  }
}

// ── formatting ────────────────────────────────────────────────────────────────
const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
function fmtUsd(n: number): string {
  const a = Math.abs(n || 0)
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
  return '$' + Math.round(n || 0)
}
const fmtNum = (n: number) => (n || 0).toLocaleString('en-US')

export function slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ── chain display names ───────────────────────────────────────────────────────
const CHAIN_NAMES: Record<string, string> = {
  eth: 'Ethereum', ethereum: 'Ethereum', trx: 'Tron', tron: 'Tron', bsc: 'BNB Chain',
  bnb: 'BNB Chain', sol: 'Solana', solana: 'Solana', btc: 'Bitcoin', bitcoin: 'Bitcoin',
  arb: 'Arbitrum', base: 'Base', avax: 'Avalanche', op: 'Optimism', matic: 'Polygon',
  polygon: 'Polygon', xrp: 'XRP Ledger', ltc: 'Litecoin', sei: 'Sei',
}
const chainName = (c: string) => CHAIN_NAMES[String(c || '').toLowerCase()] ?? (c || '').toUpperCase()

// ── shared HTML layout ────────────────────────────────────────────────────────
// Self-contained, dark, on-brand. No external JS/CSS dependency so the crawler
// gets fully-rendered content and the page is fast for a human landing on it.
function layout(opts: {
  title: string
  description: string
  canonical: string
  jsonLd?: object[]
  breadcrumb: { name: string; url: string }[]
  h1: string
  updated: number
  body: string
  noindex?: boolean
  ogImage?: string
}): string {
  const { title, description, canonical, jsonLd = [], breadcrumb, h1, updated, body, noindex, ogImage } = opts
  const crumbLd = {
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumb.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.name, item: b.url })),
  }
  const graph = [crumbLd, ...jsonLd]
  const crumbHtml = breadcrumb
    .map((b, i) => (i < breadcrumb.length - 1 ? `<a href="${esc(b.url)}">${esc(b.name)}</a> <span>/</span> ` : `<span>${esc(b.name)}</span>`))
    .join('')
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large'}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" hreflang="en" href="${esc(canonical)}"><link rel="alternate" hreflang="x-default" href="${esc(canonical)}">
<meta name="theme-color" content="#0a0a0f">
<meta property="og:type" content="website"><meta property="og:site_name" content="WCOIN.CASINO">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(ogImage || SITE + '/og.png')}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(ogImage || SITE + '/og.png')}">
<meta property="article:modified_time" content="${new Date(updated).toISOString()}">
<meta name="rating" content="adult">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>
<style>
:root{--bg:#0a0a0f;--card:#13131b;--line:#ffffff14;--fg:#e8e8ee;--mut:#9aa0b4;--dim:#6b6b78;--gold:#f5b100;--mint:#2ee6a6;--rose:#ff6b8a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--gold);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
header.nav{position:sticky;top:0;z-index:5;border-bottom:1px solid var(--line);background:#0a0a0fcc;backdrop-filter:blur(12px)}
header.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:60px}
.brand{font-weight:700;letter-spacing:.04em;color:var(--gold);font-size:17px}
.navlinks a{color:var(--mut);font-size:14px;margin-left:18px}
.cta{display:inline-block;background:linear-gradient(90deg,#f5b100,#d98a00);color:#0a0a0f!important;font-weight:700;padding:8px 14px;border-radius:9px;font-size:14px}
.crumb{color:var(--dim);font-size:13px;margin:22px 0 6px}.crumb a{color:var(--mut)}.crumb span{margin:0 2px}
h1{font-size:30px;line-height:1.15;margin:6px 0 4px;font-weight:800}
.sub{color:var(--mut);font-size:15px;margin:0 0 4px}
.upd{color:var(--dim);font-size:12px;margin:8px 0 24px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:18px 0}
@media(min-width:640px){.grid{grid-template-columns:repeat(3,1fr)}}
.stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px}
.stat .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.stat .v{font-size:20px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.mint{color:var(--mint)}.rose{color:var(--rose)}.gold{color:var(--gold)}
h2{font-size:19px;margin:30px 0 10px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:13px;overflow:hidden}
/* phones: multi-column data tables scroll inside themselves instead of squeezing */
@media(max-width:639px){table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}table th,table td{white-space:nowrap}}
th,td{text-align:left;padding:11px 14px;font-size:14px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:none}td.n{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;background:#ffffff10;border:1px solid var(--line);border-radius:7px;padding:2px 8px;font-size:12px;color:var(--mut)}
a.pill{color:var(--mut)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.prose{color:var(--mut);font-size:15px}.prose p{margin:10px 0}
.ext{font-size:14px}.ext a{word-break:break-all}
.pager{display:flex;justify-content:space-between;gap:12px;margin:18px 0}
.note{border-top:1px solid var(--line);margin-top:40px;padding-top:18px;color:var(--dim);font-size:12px;line-height:1.7}
footer{border-top:1px solid var(--line);margin-top:30px}footer .wrap{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;padding:22px 20px;color:var(--dim);font-size:13px}
.bar{height:7px;background:#ffffff0d;border-radius:6px;overflow:hidden}.bar>span{display:block;height:100%;background:linear-gradient(90deg,#f5b100,#d98a00)}
</style></head><body>
<header class="nav"><div class="wrap">
<a class="brand" href="/">WCOIN.CASINO</a>
<nav class="navlinks"><a href="/best-crypto-casinos">Best casinos</a><a href="/rankings">Rankings</a><a href="/data">Data</a><a href="/guide">Guides</a><a href="/risk">Risk</a><a href="/daily">Daily report</a><a class="cta" href="/app">Live dashboard →</a></nav>
</div></header>
<main class="wrap">
<div class="crumb">${crumbHtml}</div>
<h1>${esc(h1)}</h1>
<div class="upd">Last updated: ${new Date(updated).toISOString().slice(0, 10)} · live on-chain data, refreshed ~every 30 min</div>
${body}
<p class="note"><strong>Methodology &amp; disclaimer.</strong> Figures are derived from on-chain transfers attributed to wallets we associate with each operator, plus third-party ratings shown with their source. Blockchain attribution carries inherent uncertainty, and reserves are an all-chain best-effort estimate from mapped wallets — coverage varies by operator. These pages describe <em>observed activity and third-party data only</em>; <strong>they are not an endorsement of any operator</strong> and not a statement on any operator's solvency, legality, fairness, or safety, and nothing here is financial, legal or investment advice. See <a href="/methodology/address-attribution">how we attribute on-chain activity</a> · <a href="/about">about us</a> · <a href="/app">report a correction</a>. Data updates roughly every 30 minutes. <strong>18+ only.</strong> Gambling can be addictive — see <a href="/responsible-gambling">responsible gambling resources</a>.</p>
</main>
<section style="border-top:1px solid var(--line);margin-top:30px;padding:24px 20px;text-align:center">
  <div style="font-weight:600;font-size:15px;color:var(--fg)">Get the daily on-chain report</div>
  <div style="color:var(--mut);font-size:13px;margin:6px 0 12px">The whole crypto-casino market in one email — verified flow, reserve watch, chain breakdown. No account, one-click unsubscribe.</div>
  <form method="POST" action="/subscribe" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:440px;margin:0 auto">
    <input type="email" name="email" required placeholder="you@email.com" style="flex:1;min-width:200px;background:#ffffff08;border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--fg);font-size:14px">
    <button type="submit" style="background:linear-gradient(135deg,#ffe27a,#f5b100);border:0;border-radius:9px;padding:10px 20px;font-weight:600;font-size:14px;color:#1a1205;cursor:pointer">Subscribe</button>
  </form>
</section>
<footer><div class="wrap">
<span>© 2026 WCOIN.CASINO — the on-chain intelligence layer for iGaming · <strong>18+</strong></span>
<span><a href="/about">About</a> · <a href="/rankings">Rankings</a> · <a href="/guide">Guides</a> · <a href="/streamers">Streamers</a> · <a href="/insights">Insights</a> · <a href="/submit/casino">List your casino</a> · <a href="/methodology/proof-of-reserves">Methodology</a> · <a href="https://github.com/chenny2023/wcoin-casino-data" rel="noopener" target="_blank">Open data (GitHub)</a> · <a href="/whitepaper">2026 H1 Whitepaper</a> · <a href="/responsible-gambling">Responsible gambling</a></span>
</div></footer>
</body></html>`
}

// ─────────────────────────────────────────────────────────────────────────────
// Casino view — one merged record per operator: on-chain brand (if any) +
// multi-source third-party ratings + directory contact + reference profile.
// ─────────────────────────────────────────────────────────────────────────────
interface CasinoView {
  key: string // brandKey (the join key)
  name: string // display name
  website: string | null
  onchain: BrandAgg | null
  rs: ReviewScore | null
  tpRating: number | null
  tpReviews: number | null
  meta: CasinoMeta | null
}

// best-available rating per source across all merged inputs
function ratingsOf(v: CasinoView) {
  return {
    safety: v.rs?.safety ?? v.onchain?.safetyIndex ?? null,
    tp: v.tpRating ?? v.rs?.trustpilot ?? v.onchain?.trustpilot ?? null,
    tpN: v.tpReviews ?? null,
    ag: v.rs?.askgamblers ?? v.onchain?.askgamblers ?? null,
    ed: v.rs?.editorial ?? v.onchain?.editorial ?? null,
    complaints: v.rs?.complaints ?? v.onchain?.complaints ?? null,
    unresolved: v.rs?.unresolved ?? v.onchain?.unresolved ?? null,
  }
}

// Trustpilot needs enough reviews to be a trustworthy signal — a 1–2 review star
// is noise and must not drive a published score.
const MIN_TP_REVIEWS = Number(process.env.SEO_MIN_TP_REVIEWS ?? 5)

// Independent, QUALIFYING rating sources, each normalised to 0–100. Trustpilot
// qualifies only when we know it has ≥ MIN_TP_REVIEWS reviews.
function trustSources(v: CasinoView): { key: string; label: string; norm: number }[] {
  const r = ratingsOf(v)
  const out: { key: string; label: string; norm: number }[] = []
  if (r.safety != null) out.push({ key: 'guru', label: 'casino.guru', norm: (r.safety / 10) * 100 })
  if (r.ag != null) out.push({ key: 'ag', label: 'AskGamblers', norm: (r.ag / 10) * 100 })
  if (r.ed != null) out.push({ key: 'org', label: 'casino.org', norm: (r.ed / 5) * 100 })
  if (r.tp != null) out.push({ key: 'tp', label: 'Trustpilot', norm: (r.tp / 5) * 100 })
  return out
}

// The ONE canonical Trust. For an on-chain brand we read the AGGREGATE's already-computed
// trust (the single source of truth) so the SEO page, API and dashboard show the EXACT
// same number — the SEO view merges an extra directory Trustpilot rating, which would
// otherwise skew its own blend a few points off the API. Rated-only casinos (no aggregate
// counterpart, so no inconsistency) compute via the shared blendedTrustScore.
function blendedTrust(v: CasinoView): { score: number; sources: number } | null {
  const oc = v.onchain
  if (oc) {
    if (oc.trust == null) return null
    const sources = [oc.safetyIndex, oc.trustpilot, oc.askgamblers, oc.editorial].filter((x) => x != null).length
    return { score: oc.trust, sources: Math.max(2, sources) }
  }
  const r = ratingsOf(v)
  return blendedTrustScore({ safety: r.safety, askgamblers: r.ag, editorial: r.ed, trustpilot: r.tp })
}

// per-page data confidence (for honest labelling)
function dataConfidence(v: CasinoView): 'high' | 'medium' | 'low' {
  const oc = v.onchain
  const r = ratingsOf(v)
  const authoritative = r.safety != null || r.ag != null // casino.guru / AskGamblers
  const s = trustSources(v).length
  if ((oc && oc.volume7d > 0) || s >= 3) return 'high'
  if ((oc && oc.reserves > 0) || s >= 2 || authoritative) return 'medium'
  return 'low' // e.g. a single low-weight Trustpilot rating only
}

// data-sufficiency gate: on-chain activity, an authoritative rating (casino.guru /
// AskGamblers / casino.org), or a CREDIBLE Trustpilot. A stray low-review star
// alone is not enough — keeps every page professional and defensible.
function hasSignal(v: CasinoView): boolean {
  const oc = v.onchain
  if (oc && (oc.volume7d > 0 || oc.reserves > 0)) return true
  const r = ratingsOf(v)
  if (r.safety != null || r.ag != null || r.ed != null) return true
  return r.tp != null && (r.tpN ?? 0) >= MIN_TP_REVIEWS
}

async function buildViews(): Promise<CasinoView[]> {
  const brands = (await aggregateBrands('casino')).filter((b) => b.volume7d > 0 || b.reserves > 0)
  const rs = reviewScores() // Map<brandKey, ReviewScore>
  const dir = db
    .prepare('SELECT name, website, tp_rating, tp_reviews FROM casino_directory WHERE site_ok=1 OR tp_rating IS NOT NULL')
    .all() as { name: string; website: string; tp_rating: number | null; tp_reviews: number | null }[]

  const map = new Map<string, CasinoView>()
  const ensure = (name: string): CasinoView => {
    const key = brandKey(name)
    let v = map.get(key)
    if (!v) {
      v = { key, name: brandName(name), website: null, onchain: null, rs: rs.get(key) ?? null, tpRating: null, tpReviews: null, meta: matchCasinoMeta(name) }
      map.set(key, v)
    }
    return v
  }
  // on-chain brands first (richest, authoritative display name)
  for (const b of brands) {
    const v = ensure(b.brand)
    v.onchain = b
    v.name = b.brand
    if (!v.meta) v.meta = b.meta
  }
  // directory rows: website + Trustpilot from the category sweep
  for (const d of dir) {
    const v = ensure(d.name)
    if (!v.website && d.website) v.website = d.website
    if (d.tp_rating != null && v.tpRating == null) {
      v.tpRating = d.tp_rating
      v.tpReviews = d.tp_reviews ?? null
    }
  }
  return [...map.values()].filter(hasSignal)
}

// ─────────────────────────────────────────────────────────────────────────────
// Page builders
// ─────────────────────────────────────────────────────────────────────────────

const stat = (k: string, vv: string, cls = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(vv)}</div></div>`

// reserve COVERAGE level — qualitative band (mirrors the snapshot logic), never a raw %
function coverageLevelOf(oc: BrandAgg | null): 'high' | 'medium' | 'partial' | 'under_review' | 'unknown' {
  if (!oc || !(oc.reserves > 0)) return 'unknown'
  if (oc.volumeSuspect) return 'under_review'
  if (oc.reserveCoverage != null && oc.reserveCoverage > 200) return 'under_review'
  if (oc.confidence === 'high') return 'high'
  if (oc.confidence === 'medium') return 'medium'
  return 'partial'
}
const COVERAGE_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', partial: 'Partial', under_review: 'Under review', unknown: 'Unknown' }

// tiny inline SVG sparkline of a numeric series (reserves over time) — no JS, crawl-safe
function sparkline(values: number[], w = 220, h = 44): string {
  const v = values.filter((x) => Number.isFinite(x))
  if (v.length < 2) return ''
  const min = Math.min(...v)
  const max = Math.max(...v)
  const span = max - min || 1
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 4 - ((x - min) / span) * (h - 8)).toFixed(1)}`).join(' ')
  const up = v[v.length - 1] >= v[0]
  const col = up ? '#2ee6a6' : '#ff6b8a'
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" style="display:block"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`
}

function casinoPage(
  v: CasinoView,
  slug: string,
  related: { slug: string; label: string }[],
  noindex = false,
  xlinks: { compares?: { slug: string; label: string }[]; bestChains?: { slug: string; label: string }[]; alternatives?: string } = {},
): { title: string; description: string; html: string } {
  const url = `${SITE}/casino/${slug}`
  const oc = v.onchain
  const r = ratingsOf(v)
  const bt = blendedTrust(v)
  const cov = coverageLevelOf(oc)

  // intent-tuned for the questions players actually search ("X reserves / is X legit / safe")
  const title = oc
    ? `${v.name} — On-Chain Reserves, Solvency & Trust Data | WCOIN.CASINO`
    : `${v.name} — Crypto Casino Trust Ratings & Reserves Data | WCOIN.CASINO`
  const description = oc
    ? `Is ${v.name} solvent and active? On-chain data: ${fmtUsd(oc.reserves)} tracked all-chain reserves (${COVERAGE_LABEL[cov]} coverage)${oc.volumeSuspect ? '' : `, ${fmtUsd(oc.volume7d)} 7-day volume across ${oc.byChain?.length || 1} chains`}, and multi-source trust ratings — independently verifiable, updated continuously.`
    : `Trust ratings and reference data for ${v.name} — casino.guru, Trustpilot${r.ag != null ? ', AskGamblers' : ''} and more, in one place. Updated continuously.`

  // stats grid — on-chain tiles when we track wallets, else rating tiles
  let stats = ''
  if (oc) {
    const net = oc.net7d ?? 0
    // anomalous-volume operators (wash / treasury churn): withhold the volume figures
    // as "Under review" rather than publish an inflated number as fact
    const vsus = oc.volumeSuspect
    stats =
      `<div class="grid">` +
      stat('7d volume', vsus ? 'Under review' : fmtUsd(oc.volume7d)) +
      stat('24h volume', vsus ? 'Under review' : fmtUsd(oc.volume24h)) +
      stat('Net flow (7d)', vsus ? 'Under review' : (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), vsus ? '' : net >= 0 ? 'mint' : 'rose') +
      stat('Mapped reserves', fmtUsd(oc.reserves), 'mint') +
      stat('Active counterparties (7d)', fmtNum(oc.players)) +
      stat('Chains', String(oc.byChain?.length || 0)) +
      `</div>`
  } else {
    const tiles: string[] = []
    if (bt) tiles.push(stat(`Blended trust · ${bt.sources} sources`, `${bt.score} / 100`, 'gold'))
    if (r.safety != null) tiles.push(stat('casino.guru', r.safety.toFixed(1) + ' / 10'))
    if (r.ag != null) tiles.push(stat('AskGamblers', r.ag.toFixed(1) + ' / 10'))
    if (r.tp != null && (r.tpN ?? 0) >= MIN_TP_REVIEWS) tiles.push(stat('Trustpilot', r.tp.toFixed(1) + ' / 5'))
    if (r.ed != null) tiles.push(stat('casino.org', r.ed.toFixed(1) + ' / 5'))
    if (tiles.length) stats = `<div class="grid">${tiles.join('')}</div>`
  }

  // unified ratings table
  const ratings: string[] = []
  if (r.safety != null) ratings.push(`<tr><td>casino.guru Safety Index</td><td class="n">${r.safety.toFixed(1)} / 10</td></tr>`)
  if (r.tp != null) ratings.push(`<tr><td>Trustpilot${r.tpN != null ? ` (${fmtNum(r.tpN)} reviews${r.tpN < MIN_TP_REVIEWS ? ' — limited sample' : ''})` : ''}</td><td class="n">${r.tp.toFixed(1)} / 5</td></tr>`)
  if (r.ag != null) ratings.push(`<tr><td>AskGamblers expert</td><td class="n">${r.ag.toFixed(1)} / 10</td></tr>`)
  if (r.ed != null) ratings.push(`<tr><td>casino.org editorial</td><td class="n">${r.ed.toFixed(1)} / 5</td></tr>`)
  if (r.complaints != null) ratings.push(`<tr><td>casino.guru complaints (current)</td><td class="n">${fmtNum(r.complaints)}${r.unresolved != null ? ` (${fmtNum(r.unresolved)} unresolved)` : ''}</td></tr>`)
  const ratingsTable = ratings.length
    ? `<h2>Third-party trust ratings</h2><p class="prose">Independently published by the sources named below — shown here with attribution, not endorsed or verified by us.</p><table><tbody>${ratings.join('')}</tbody></table>`
    : ''

  // on-chain volume by network (only when we track wallets)
  let chainTable = ''
  if (oc) {
    const chainRows = (oc.byChain ?? [])
      .slice()
      .sort((a, b) => b.value - a.value)
      .map((c) => `<tr><td><span class="pill">${esc(chainName(c.chain))}</span></td><td class="n">${fmtUsd(c.value)}</td></tr>`)
      .join('')
    chainTable = chainRows ? `<h2>On-chain volume by network (7d)</h2><table><thead><tr><th>Network</th><th style="text-align:right">7d volume</th></tr></thead><tbody>${chainRows}</tbody></table>` : ''
  }

  // reference (license / house edge / coverage), if available — factual only
  const meta = v.meta as any
  const refRows: string[] = []
  if (meta?.license) refRows.push(`<tr><td>Stated licence</td><td class="n">${esc(String(meta.license))}</td></tr>`)
  if (meta?.established) refRows.push(`<tr><td>Established</td><td class="n">${esc(String(meta.established))}</td></tr>`)
  if (meta?.houseEdge) refRows.push(`<tr><td>Typical house edge</td><td class="n">${esc(String(meta.houseEdge))}</td></tr>`)
  if (oc?.reserveCoverage != null) refRows.push(`<tr><td>Withdrawal-coverage ratio <span class="pill">reserves ÷ 7d outflow</span></td><td class="n">${oc.reserveCoverage.toFixed(1)}×</td></tr>`)
  const refTable = refRows.length ? `<h2>Reference</h2><table><tbody>${refRows.join('')}</tbody></table>` : ''

  // outbound website (nofollow — we don't vouch for or pass equity to operators)
  const website = v.website
    ? `<p class="ext" style="margin-top:18px">Official website: <a href="${esc(v.website)}" rel="nofollow noopener" target="_blank">${esc(v.website.replace(/^https?:\/\//, ''))}</a></p>`
    : ''

  const rel = related.length
    ? `<h2>Related operators</h2><div class="chips">${related.map((x) => `<a class="pill" href="/casino/${x.slug}">${esc(x.label)}</a>`).join('')}</div>`
    : ''
  // internal links to the high-intent comparison + chain-best pages this operator
  // appears in — deepens the page and strengthens crawl/relevance signals.
  const compareLinks = xlinks.compares?.length
    ? `<h2>Compare ${esc(v.name)}</h2><div class="chips">${xlinks.compares.map((c) => `<a class="pill" href="/compare/${c.slug}">${esc(c.label)}</a>`).join('')}</div>`
    : ''
  const chainBestLinks = xlinks.bestChains?.length
    ? `<h2>Ranked among the best on</h2><div class="chips">${xlinks.bestChains.map((c) => `<a class="pill" href="/rankings/best-on-${c.slug}">Best on ${esc(c.label)}</a>`).join('')}</div>`
    : ''
  const altLink = xlinks.alternatives
    ? `<h2>Looking for alternatives?</h2><p class="prose">See <a href="/${xlinks.alternatives}-alternatives">trusted ${esc(v.name)} alternatives</a> — crypto casinos on the same chains, ranked by independent trust (not affiliate payouts).</p>`
    : ''

  const conf = dataConfidence(v)
  const confPill = `<span class="pill">data confidence: ${conf}</span>`
  const trustLine = bt
    ? `<p class="prose" style="margin-top:6px">Blended trust <strong class="gold">${bt.score} / 100</strong> from ${bt.sources} independent sources — see <a href="/rankings/trust">the trust ranking</a> and <a href="/methodology/trust">how it's sourced</a>.</p>`
    : ''
  const sub = oc
    ? `<p class="sub">Observed on-chain activity and third-party ratings attributed to <strong>${esc(v.name)}</strong>, across ${oc.byChain?.length || 1} blockchain${(oc.byChain?.length || 1) === 1 ? '' : 's'}.</p><p class="upd">Updated continuously from indexed on-chain data. ${confPill}</p>`
    : `<p class="sub">Aggregated third-party trust ratings and reference data for <strong>${esc(v.name)}</strong>, in one place.</p><p class="upd">We don't yet track this operator's on-chain wallets — only attributed third-party signals are shown. ${confPill}</p>`

  const cta = oc
    ? `<p class="prose" style="margin-top:24px">Explore the full live picture — real-time deposits &amp; withdrawals, whale flow and reserve history — on the <a href="/app/casinos">live casino dashboard</a>, or see the whole market in today's <a href="/daily">daily report</a>.</p>`
    : `<p class="prose" style="margin-top:24px">Compare operators by <a href="/rankings/trust">third-party trust rating</a> (our recommended ranking — on-chain volume is easily inflated by wash trading), or browse the live <a href="/app/casinos">casino dashboard</a>.</p>`

  // contextual guides — distribute link equity from every casino page to the data/
  // guide clusters, and help readers act on what they're seeing
  const guideLinks = `<h2>Judge ${esc(v.name)} for yourself</h2><div class="chips"><a class="pill" href="/guide/how-to-verify-a-crypto-casino">How to verify a casino on-chain</a><a class="pill" href="/guide/are-crypto-casinos-safe">Are crypto casinos safe?</a><a class="pill" href="/guide/crypto-casino-proof-of-reserves">Proof of reserves explained</a><a class="pill" href="/data/crypto-casino-reserves">Reserves report</a></div>`

  // limited (noindex) pages get an honest banner explaining the thin data
  const limitedNote = noindex
    ? `<p class="prose" style="margin:0 0 4px;padding:9px 13px;background:#ffffff08;border:1px solid var(--line);border-radius:10px;font-size:13px;color:var(--dim)">Limited profile — we don't yet have enough independent data to feature ${esc(v.name)}. It will be expanded as on-chain activity and additional rating sources are added.</p>`
    : ''
  // anomalous on-chain volume — caveat it so a wash/internal figure isn't read as real activity
  const suspectNote = oc?.volumeSuspect
    ? `<p class="prose" style="margin:0 0 4px;padding:9px 13px;background:#ffb02014;border:1px solid #ffb02033;border-radius:10px;font-size:13px;color:#e8c98a">⚠ Volume note: ${esc(v.name)}'s observed on-chain volume is anomalously concentrated (very high value per counterparty), a pattern consistent with wash trading or internal transfers rather than real player activity. We exclude it from volume rankings; read the volume figure with caution.</p>`
    : ''
  // ── solvency & activity — the heart of what a player wants to know ──────────────
  let solvency = ''
  if (oc && oc.reserves > 0) {
    const series = reserveSeries(v.name, 60) // newest-first
    const chrono = series.slice().reverse() // oldest → newest for the sparkline
    const spark = chrono.length >= 2 ? sparkline(chrono.map((s) => s.reserves)) : ''
    const oldest = chrono.length ? chrono[0].reserves : null
    const newest = chrono.length ? chrono[chrono.length - 1].reserves : oc.reserves
    const trendPct = oldest && oldest > 0 ? (newest - oldest) / oldest : null
    const net = oc.net7d ?? 0
    solvency =
      `<h2>On-chain solvency &amp; activity</h2>` +
      `<div class="grid">${stat('Tracked reserves', fmtUsd(oc.reserves), 'mint')}${stat('Reserve coverage', COVERAGE_LABEL[cov])}${stat('Net flow (7d)', (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), net >= 0 ? 'mint' : 'rose')}</div>` +
      (spark
        ? `<div style="margin:14px 0"><div class="prose" style="font-size:13px;margin-bottom:6px">Tracked reserves trend · last ${chrono.length} days${trendPct != null ? ` · <strong class="${trendPct >= 0 ? 'mint' : 'rose'}">${trendPct >= 0 ? '+' : ''}${(trendPct * 100).toFixed(1)}%</strong>` : ''}</div>${spark}</div>`
        : '') +
      `<p class="prose" style="font-size:13px">Reserves are an all-chain best-effort estimate from mapped wallets; coverage is partial by brand and shown as a level, not a percentage. This is observed wallet data — <em>not</em> a statement on solvency, safety or legality. <a href="/methodology/proof-of-reserves">How reserves are tracked →</a></p>`
  }

  // ── FAQ — answers the exact questions players search, neutrally (+ FAQPage schema) ─
  const faqs: { q: string; a: string }[] = []
  if (oc) {
    faqs.push({ q: `What are ${v.name}'s on-chain reserves?`, a: `WCOIN tracks approximately ${fmtUsd(oc.reserves)} in all-chain reserves mapped to ${v.name}, with ${COVERAGE_LABEL[cov].toLowerCase()} coverage. Reserves are a best-effort estimate from mapped wallets and may be partial by brand.` })
    faqs.push({ q: `Is ${v.name} active on-chain?`, a: oc.volumeSuspect
      ? `${v.name} is active across ${oc.byChain?.length || 1} chain${(oc.byChain?.length || 1) === 1 ? '' : 's'} with ${fmtNum(oc.players)} active counterparties. Its on-chain transfer volume is anomalous (consistent with treasury/market-making rather than player flow), so we hold the headline volume figure under review rather than publish it.`
      : `${v.name} has ${fmtUsd(oc.volume7d)} of tracked on-chain volume over the last 7 days across ${oc.byChain?.length || 1} chain${(oc.byChain?.length || 1) === 1 ? '' : 's'}, with ${fmtNum(oc.players)} active counterparties.` })
    faqs.push({ q: `Is ${v.name} legit or safe to use?`, a: `WCOIN is an independent on-chain data site and does not rate operators as legit, safe or unsafe. We surface verifiable signals — on-chain reserves, tracked volume and independent third-party ratings${bt ? ` (blended trust ${bt.score}/100 from ${bt.sources} sources)` : ''} — so you can assess for yourself. Always do your own research.` })
    faqs.push({ q: `How is ${v.name}'s data verified?`, a: `Figures come from on-chain transfers attributed to wallets associated with ${v.name}, plus published third-party ratings shown with their source. Attribution carries inherent uncertainty; see our methodology.` })
    const chainsSettled = (oc.byChain ?? []).filter((c) => c.value > 0).map((c) => chainName(c.chain))
    if (chainsSettled.length) {
      const list = chainsSettled.join(', ').replace(/, ([^,]*)$/, chainsSettled.length > 1 ? ' and $1' : '$1')
      faqs.push({ q: `Which blockchains and cryptocurrencies does ${v.name} use?`, a: `We observe ${v.name} settling on-chain across ${chainsSettled.length} network${chainsSettled.length === 1 ? '' : 's'} — ${list}. That means it processes the assets native to those chains (for example USDT on Tron and Ethereum, or BTC on Bitcoin). Always confirm the supported deposit options on the operator's own site before depositing.` })
    }
    if (bt) faqs.push({ q: `What is ${v.name}'s trust rating?`, a: `${v.name} has a blended independent-trust score of ${bt.score}/100, aggregated from ${bt.sources} third-party source${bt.sources === 1 ? '' : 's'} such as casino.guru, Trustpilot and AskGamblers. It reflects reputation and is independent of on-chain volume, which is easily inflated by wash trading. See how trust is scored in our methodology.` })
    faqs.push({ q: `Does ${v.name} have proof of reserves?`, a: oc.reserves > 0
      ? `We map and track approximately ${fmtUsd(oc.reserves)} in on-chain reserves for ${v.name} — wallet balances anyone can verify on a public block explorer. This is observed proof of reserves, not a self-reported claim, and may be partial by brand.`
      : `We don't yet map verifiable on-chain reserves for ${v.name}. That isn't evidence of insolvency — it usually means we haven't attributed enough of its wallets yet. Check back as coverage expands.` })
  }
  const faqHtml = faqs.length ? `<h2>Frequently asked questions</h2>${faqs.map((f) => `<div style="margin:10px 0"><p style="font-weight:600;margin:0 0 2px">${esc(f.q)}</p><p class="prose" style="margin:0;font-size:14px">${esc(f.a)}</p></div>`).join('')}` : ''

  // reserve-alert sign-up — turns the answer page into a retention point. Plain HTML
  // form (no JS) so it works on the server-rendered SEO page; double opt-in on submit.
  const alertForm =
    oc && oc.reserves > 0
      ? `<h2 style="margin-top:34px">Get reserve alerts for ${esc(v.name)}</h2>` +
        `<p class="prose" style="font-size:13px;margin-bottom:10px">Be emailed when ${esc(v.name)}'s tracked on-chain reserves drop materially or a large net outflow is observed. Free, one-click unsubscribe. Observed data — not a solvency or safety statement.</p>` +
        `<form method="POST" action="/api/casino-alert" style="display:flex;gap:8px;flex-wrap:wrap;max-width:460px">` +
        `<input type="hidden" name="brand" value="${esc(v.name)}">` +
        `<input type="email" name="email" required placeholder="you@email.com" style="flex:1;min-width:200px;background:#ffffff08;border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--fg);font-size:14px">` +
        `<button type="submit" class="cta" style="border:none;cursor:pointer">Alert me</button>` +
        `</form>`
      : ''

  // risk registry — observed on-chain signals + any sourced incidents for this brand
  const riskEvts = brandRiskEvents(v.key)
  const riskSection = riskEvts.length
    ? `<h2>Risk signals &amp; events</h2><p class="prose" style="font-size:13px">Observed on-chain risk signals${riskEvts.some((e) => e.kind === 'incident') ? ' and sourced public incidents' : ''} for ${esc(v.name)}. Signals are our own observed data; incidents link their source. Neutral — these are not a verdict on the operator.</p>${riskEvts
        .map((e) => {
          const col = e.severity === 'elevated' ? '#ff6b8a' : e.severity === 'watch' ? '#f5b100' : '#9aa0b4'
          const src = e.source_url ? ` · <a href="${esc(e.source_url)}" rel="nofollow noopener" target="_blank">source →</a>` : ''
          const tag = `<span class="pill">${e.kind === 'incident' ? 'incident' : 'on-chain signal'}</span>`
          const resp = e.operator_response ? `<div class="prose" style="font-size:12px;margin-top:3px"><strong>Operator response:</strong> ${esc(e.operator_response)}</div>` : ''
          return `<div style="border-left:3px solid ${col};padding:4px 0 4px 12px;margin:10px 0"><div style="font-weight:600">${esc(e.title)} ${tag}</div>${e.detail ? `<div class="prose" style="font-size:13px;margin-top:2px">${esc(e.detail)}${src}</div>` : src ? `<div class="prose" style="font-size:13px">${src}</div>` : ''}${resp}</div>`
        })
        .join('')}<p class="prose" style="font-size:12px"><a href="/risk">Full risk registry →</a></p>`
    : ''

  const body = `${limitedNote}${suspectNote}${sub}${trustLine}${stats}${solvency}${riskSection}${chainTable}${ratingsTable}${refTable}${website}${rel}${compareLinks}${chainBestLinks}${altLink}${faqHtml}${guideLinks}${alertForm}${cta}`

  const pageUpdated = Date.now()
  const jsonLd: object[] = [
    ...(oc
      ? [
          {
            '@type': 'Dataset',
            name: `${v.name} on-chain activity dataset`,
            description,
            url,
            dateModified: new Date(pageUpdated).toISOString(),
            creator: { '@id': SITE + '/#org' },
            isAccessibleForFree: true,
            license: SITE + '/methodology/address-attribution',
            variableMeasured: ['all-chain tracked reserves (USD)', '7d on-chain volume', 'net flow', 'active counterparties'],
          },
        ]
      : []),
    ...(faqs.length ? [{ '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
  ]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Casinos', url: SITE + '/rankings/trust' },
        { name: v.name, url },
      ],
      h1: oc ? `${v.name} — on-chain data` : `${v.name} — trust ratings & data`,
      updated: pageUpdated,
      body,
      noindex,
    }),
  }
}

// ── entity answer pages — answer-first, GEO/AI-citable, per question ───────────
// Three focused pages per operator (is-X-safe / does-X-pay-out / X-proof-of-reserves)
// that open with a DATA STATUS (not a subjective safe/scam verdict — the site never
// issues one) + an as-of date + the verifiable basis, then the relevant on-chain data
// and a FAQ using the exact phrasings players search. Distinct from the full /casino
// profile (focused on one question), which they link to.
type AnswerType = 'is_safe' | 'does_pay' | 'proof_of_reserves'
function entityAnswerPage(v: CasinoView, slug: string, type: AnswerType, asOf: string, casinoSlug: string): { title: string; description: string; html: string } {
  const url = `${SITE}/${slug}`
  const oc = v.onchain
  const r = ratingsOf(v)
  const bt = blendedTrust(v)
  const cov = coverageLevelOf(oc)
  const net = oc?.net7d ?? 0
  const conf = dataConfidence(v)
  // shared verifiable-signal phrases
  const reservesPhrase = oc && oc.reserves > 0 ? `${fmtUsd(oc.reserves)} in mapped on-chain reserves (${COVERAGE_LABEL[cov]} coverage)` : `no on-chain reserves mapped yet`
  const trustPhrase = bt ? `a blended independent-trust score of ${bt.score}/100 from ${bt.sources} sources` : (r.safety != null ? `a casino.guru Safety Index of ${r.safety.toFixed(1)}/10` : `limited third-party rating data`)
  const complaintPhrase = r.complaints != null ? `${fmtNum(r.complaints)} logged complaints${r.unresolved != null ? ` (${fmtNum(r.unresolved)} unresolved)` : ''} on casino.guru` : `no aggregated complaint count on file`
  const flowPhrase = oc && !oc.volumeSuspect ? `${(net >= 0 ? 'net inflow' : 'net outflow')} of ${fmtUsd(Math.abs(net))} over 7 days` : (oc?.volumeSuspect ? `volume held under review (anomalous pattern)` : `no tracked on-chain flow yet`)
  const covRatio = oc?.reserveCoverage != null ? `${oc.reserveCoverage.toFixed(1)}× reserve-to-7d-outflow coverage` : null

  let h1 = '', title = '', description = '', answer = '', body2 = '', faqs: { q: string; a: string }[] = []
  const disclaimer = `<p class="prose" style="font-size:12px;color:var(--dim);margin-top:4px">WCOIN is an independent on-chain data site. We don't label operators safe, legit, solvent or scam — we surface verifiable signals so you can decide. This is observed wallet data, not financial or legal advice.</p>`
  const dataTiles = oc
    ? `<div class="grid">${stat('Mapped reserves', oc.reserves > 0 ? fmtUsd(oc.reserves) : '—', 'mint')}${stat('Reserve coverage', COVERAGE_LABEL[cov])}${stat('Net flow (7d)', oc.volumeSuspect ? 'Under review' : (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), oc.volumeSuspect ? '' : net >= 0 ? 'mint' : 'rose')}${bt ? stat(`Blended trust · ${bt.sources} src`, `${bt.score} / 100`, 'gold') : ''}</div>`
    : (bt || r.safety != null ? `<div class="grid">${bt ? stat(`Blended trust · ${bt.sources} src`, `${bt.score} / 100`, 'gold') : ''}${r.safety != null ? stat('casino.guru', r.safety.toFixed(1) + ' / 10') : ''}${r.complaints != null ? stat('Complaints', fmtNum(r.complaints) + (r.unresolved != null ? ` (${fmtNum(r.unresolved)} open)` : '')) : ''}</div>` : '')

  if (type === 'is_safe') {
    h1 = `Is ${v.name} safe & legit? On-chain data (${asOf})`
    title = `Is ${v.name} Safe & Legit? On-Chain Data Check (${YEAR}) | WCOIN.CASINO`
    description = `Is ${v.name} safe and legit? The verifiable data as of ${asOf}: ${reservesPhrase}, ${trustPhrase}, and ${complaintPhrase}. We don't issue safe/scam verdicts — here's the data to judge.`
    answer = `<p class="prose"><strong>The verifiable data (as of ${asOf}):</strong> ${v.name} has ${trustPhrase}, ${reservesPhrase}, and ${complaintPhrase}. On-chain it shows ${flowPhrase}. Rather than a subjective "safe" or "scam" label, these are independent, checkable signals — use them to judge ${v.name} before depositing.</p>`
    body2 =
      `<h2>How to read these signals</h2><p class="prose">No single number proves an operator is safe. The strongest pre-deposit checks are (1) <strong>verifiable on-chain reserves</strong> that comfortably cover withdrawals, (2) a <strong>track record</strong> in independent trust ratings, and (3) the <strong>trend in unresolved complaints</strong>. A cluster of red flags — thin or falling reserves, one-way outflow, many unresolved disputes — is a reason to slow down. Learn the full checklist in <a href="/guide/crypto-casino-red-flags">crypto casino red flags</a> and verify it yourself with <a href="/guide/how-to-verify-a-crypto-casino">how to verify a casino on-chain</a>.</p>` +
      `<h2>The full ${esc(v.name)} profile</h2><p class="prose">This page answers the safety question; the <a href="/casino/${casinoSlug}">full ${esc(v.name)} data profile</a> has its complete on-chain activity, reserve trend, third-party ratings and any risk signals.</p>`
    faqs = [
      { q: `Is ${v.name} safe?`, a: `WCOIN does not label operators safe or unsafe. As of ${asOf}, the verifiable signals for ${v.name} are: ${trustPhrase}, ${reservesPhrase}, and ${complaintPhrase}. Use these checkable data points — not a marketing claim — to decide for yourself.` },
      { q: `Is ${v.name} legit or a scam?`, a: `We don't make legit/scam accusations. ${v.name} shows ${flowPhrase} on-chain and ${trustPhrase}. On-chain activity and independent ratings are the verifiable basis; a pattern of unresolved withdrawal complaints would be the clearest negative signal to watch.` },
      { q: `How can I check if ${v.name} is safe myself?`, a: `Read its mapped on-chain reserves and net flow (shown above and on the full profile), cross-check independent trust ratings, and look at the trend in unresolved complaints. Our <a href="/guide/how-to-verify-a-crypto-casino">verification guide</a> walks through reading the wallets on a block explorer.` },
    ]
  } else if (type === 'does_pay') {
    h1 = `Does ${v.name} pay out? Withdrawal & payout data (${asOf})`
    title = `Does ${v.name} Pay Out? Withdrawal Reliability Data (${YEAR}) | WCOIN.CASINO`
    description = `Does ${v.name} pay out withdrawals? On-chain data as of ${asOf}: ${flowPhrase}${covRatio ? ', ' + covRatio : ''}, and ${complaintPhrase}. Observable payout signals — judge before you deposit.`
    answer = `<p class="prose"><strong>The verifiable data (as of ${asOf}):</strong> ${v.name}'s on-chain wallets show ${flowPhrase}${covRatio ? `, with ${covRatio}` : ''}. Third-party reputation data shows ${complaintPhrase}. Because withdrawals settle on public chains, payout <em>activity</em> is observable — healthy two-way flow and reserves that cover outflows are positive signals — but no data can guarantee any individual cashout.</p>`
    body2 =
      `<h2>What the on-chain payout signals mean</h2><p class="prose">A casino that is paying players shows steady <strong>outflow</strong> alongside deposits — balanced two-way flow. Sustained heavy net outflow can signal stress; deposits with almost no outflow can signal players aren't being paid. Reserve-to-outflow coverage shows how many weeks of withdrawals the mapped reserves could cover. Pair these with the complaint trend: a wave of <em>unresolved</em> withdrawal complaints is the clearest warning. See <a href="/guide/crypto-casino-withdrawal-times">withdrawal times</a> and the <a href="/data/crypto-casino-net-flow">net-flow report</a>.</p>` +
      `<h2>If a withdrawal is stuck</h2><p class="prose">Most stuck withdrawals are fixable — wrong network, unconfirmed transaction, missing memo. Diagnose it with <a href="/guide/crypto-casino-deposit-not-showing">deposit/withdrawal troubleshooting</a> before assuming non-payment. See the <a href="/casino/${casinoSlug}">full ${esc(v.name)} profile</a> for its complete flow history.</p>`
    faqs = [
      { q: `Does ${v.name} pay out?`, a: `On-chain as of ${asOf}, ${v.name} shows ${flowPhrase}${covRatio ? ` and ${covRatio}` : ''}. Withdrawal activity is publicly observable on-chain; balanced flow and reserve coverage are positive payout signals, but we can't guarantee any single cashout. Check the unresolved-complaint trend too.` },
      { q: `Why is my ${v.name} withdrawal slow or not paying?`, a: `Delays are often network confirmations, a wrong-network send, or a missing memo rather than refusal to pay — see our <a href="/guide/crypto-casino-deposit-not-showing">troubleshooting guide</a>. If the on-chain transaction is confirmed to the right address and still not credited, contact support with the transaction hash. Persistent unexplained non-payment across users is a red flag.` },
      { q: `How fast does ${v.name} pay withdrawals?`, a: `Speed depends on the network and the operator's processing. On-chain settlement itself is seconds-to-minutes (USDT-TRC20, Solana) once released; the operator's internal review is the variable. We track net flow and reserves, not individual payout times — the full profile shows ${v.name}'s observed flow.` },
    ]
  } else {
    h1 = `${v.name} proof of reserves & solvency (${asOf})`
    title = `${v.name} Proof of Reserves & Solvency — On-Chain (${YEAR}) | WCOIN.CASINO`
    description = `${v.name} proof of reserves: ${reservesPhrase} as of ${asOf}, read directly from mapped wallets on public blockchains. Observed proof of reserves, not a self-reported claim.`
    answer = oc && oc.reserves > 0
      ? `<p class="prose"><strong>The verifiable data (as of ${asOf}):</strong> WCOIN maps ${reservesPhrase} for ${v.name} across ${oc.byChain?.length || 1} chain${(oc.byChain?.length || 1) === 1 ? '' : 's'} — wallet balances anyone can verify on a public block explorer. This is <strong>observed proof of reserves</strong>, not a figure the operator self-reports. Note it proves assets held, not total liabilities to players, and coverage is partial by brand.</p>`
      : `<p class="prose"><strong>As of ${asOf}:</strong> WCOIN does not yet map verifiable on-chain reserves for ${v.name}. That is <em>not</em> evidence of insolvency — it usually means we haven't attributed enough of its wallets yet. ${trustPhrase.charAt(0).toUpperCase() + trustPhrase.slice(1)} is available in the meantime.</p>`
    body2 =
      `<h2>Proof of reserves vs proof of custody</h2><p class="prose">"Proof of reserves" shows assets exist on-chain at known wallets; it does <em>not</em> prove the operator controls them exclusively or that they exceed what's owed to players (liabilities). A wallet can also be funded temporarily to look healthy. That's why we show a <strong>coverage level</strong> rather than a single "fully reserved" claim, and pair reserves with net flow and trend. The full definitional breakdown is in <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves explained</a>.</p>` +
      (oc && oc.reserves > 0 ? `<h2>How we verify ${esc(v.name)}'s reserves</h2><p class="prose">We map wallets to ${v.name} from public block-explorer name-tags and on-chain behaviour, then read their balances across every chain we track — see <a href="/methodology/address-attribution">our attribution methodology</a>. The <a href="/casino/${casinoSlug}">full profile</a> shows the reserve trend and per-network breakdown.</p>` : `<h2>More on ${esc(v.name)}</h2><p class="prose">See the <a href="/casino/${casinoSlug}">full ${esc(v.name)} profile</a> for its third-party ratings, and our <a href="/proof-of-reserves">proof-of-reserves hub</a> for operators with mapped reserves.</p>`)
    faqs = [
      { q: `Does ${v.name} have proof of reserves?`, a: oc && oc.reserves > 0 ? `Yes — WCOIN maps ${reservesPhrase} for ${v.name}, read directly from wallets on public blockchains as of ${asOf}. This is observed proof of reserves (verifiable by anyone), not a self-reported figure, and may be partial by brand.` : `WCOIN does not yet map verifiable on-chain reserves for ${v.name} as of ${asOf}. This isn't evidence of insolvency — typically it means we haven't attributed enough of its wallets. Reserves appear here as coverage expands.` },
      { q: `Is ${v.name} solvent?`, a: `We don't issue solvency verdicts. Proof of reserves shows assets held on-chain (${reservesPhrase} as of ${asOf}), not total liabilities to players, so it can't prove solvency on its own. We pair it with net flow and the reserve trend, shown on the full profile.` },
      { q: `What does ${v.name}'s reserve coverage level mean?`, a: `Coverage is a qualitative band (High/Medium/Partial/Under review) reflecting how complete our wallet mapping for ${v.name} is — not a claim that it is "fully reserved". It is shown as a level, never a precise percentage, because attribution is inherently partial.` },
    ]
  }

  const faqHtml = `<h2>Frequently asked questions</h2>${faqs.map((f) => `<div style="margin:10px 0"><p style="font-weight:600;margin:0 0 2px">${esc(f.q)}</p><p class="prose" style="margin:0;font-size:14px">${f.a}</p></div>`).join('')}`
  const guideLinks = `<div class="chips" style="margin-top:18px"><a class="pill" href="/casino/${casinoSlug}">Full ${esc(v.name)} profile</a><a class="pill" href="/rankings/trust">Trust ranking</a><a class="pill" href="/proof-of-reserves">Proof of reserves</a><a class="pill" href="/guide/how-to-verify-a-crypto-casino">Verify on-chain</a></div>`
  const body = `<p class="upd">As of ${asOf} · data confidence: ${conf} · independently verifiable</p>${answer}${disclaimer}${dataTiles}${body2}${faqHtml}${guideLinks}`

  const jsonLd: object[] = [
    { '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } })) },
  ]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: v.name, url: `${SITE}/casino/${casinoSlug}` },
        { name: h1, url },
      ],
      h1,
      updated: Date.now(),
      body,
    }),
  }
}

// ── head-to-head comparison ("X vs Y") — high search-intent, data-led ─────────
// Only generated for pairs where BOTH operators have ≥medium-confidence data, so a
// comparison is never thin. Neutral framing: facts side by side; only the blended
// trust (our recommended metric) is marked, never volume (wash-tradeable).
function comparePage(a: CasinoView, b: CasinoView, slugA: string, slugB: string): { title: string; description: string; html: string } {
  const path = `/compare/${slugA}-vs-${slugB}`
  const url = SITE + path
  const oa = a.onchain
  const ob = b.onchain
  const bta = blendedTrust(a)
  const btb = blendedTrust(b)
  const ra = ratingsOf(a)
  const rb = ratingsOf(b)
  const tpA = (ra.tpN ?? 0) >= MIN_TP_REVIEWS ? ra.tp : null
  const tpB = (rb.tpN ?? 0) >= MIN_TP_REVIEWS ? rb.tp : null

  const title = `${a.name} vs ${b.name} — Crypto Casino Comparison | WCOIN.CASINO`
  const description = `${a.name} vs ${b.name}: a side-by-side, data-led comparison of independent trust ratings, on-chain volume and mapped reserves. Neutral and updated continuously.`

  // a comparison row; `mark` highlights the stronger side ONLY when explicitly asked
  // (we mark blended trust, never volume — volume is easily inflated by wash trading).
  const row = (label: string, av: number | null, bv: number | null, fmt: (n: number) => string, mark = false) => {
    const aS = av == null ? '—' : fmt(av)
    const bS = bv == null ? '—' : fmt(bv)
    let aCls = ''
    let bCls = ''
    if (mark && av != null && bv != null && av !== bv) (av > bv ? (aCls = 'mint') : (bCls = 'mint'))
    return `<tr><td>${esc(label)}</td><td class="n ${aCls}">${aS}</td><td class="n ${bCls}">${bS}</td></tr>`
  }
  const rows =
    row('Blended trust (0–100)', bta?.score ?? null, btb?.score ?? null, (n) => `${n}`, true) +
    row('casino.guru Safety (/10)', ra.safety, rb.safety, (n) => n.toFixed(1)) +
    row('AskGamblers expert (/10)', ra.ag, rb.ag, (n) => n.toFixed(1)) +
    row('Trustpilot (/5)', tpA, tpB, (n) => n.toFixed(1)) +
    // suspect (wash/treasury-pattern) volume is never rendered as a comparable figure
    row('7d on-chain volume', oa?.volumeSuspect ? null : oa?.volume7d ?? null, ob?.volumeSuspect ? null : ob?.volume7d ?? null, fmtUsd) +
    row('Mapped reserves', oa?.reserves ?? null, ob?.reserves ?? null, fmtUsd) +
    row('Active counterparties (7d)', oa?.players ?? null, ob?.players ?? null, fmtNum) +
    row('Chains tracked', oa?.byChain?.length ?? null, ob?.byChain?.length ?? null, (n) => `${n}`)

  const verdict =
    bta && btb && bta.score !== btb.score
      ? `On our recommended metric — a blend of independent third-party trust ratings — <strong>${esc(bta.score > btb.score ? a.name : b.name)}</strong> currently scores higher (${Math.max(bta.score, btb.score)} vs ${Math.min(bta.score, btb.score)} / 100). On-chain volume differences are shown for context only and are <em>not</em> a quality signal — volume is easily inflated by wash trading.`
      : `Both operators are compared on independent third-party trust ratings (our recommended metric) and observed on-chain activity. On-chain volume is shown for context only — it is easily inflated and is not a quality signal.`

  const body =
    `<p class="sub">A neutral, data-led comparison of <strong>${esc(a.name)}</strong> and <strong>${esc(b.name)}</strong> — independent trust ratings, observed on-chain volume and mapped reserves, side by side.</p>` +
    `<p class="upd">Updated continuously from indexed on-chain data and third-party ratings.</p>` +
    `<table><thead><tr><th>Metric</th><th style="text-align:right">${esc(a.name)}</th><th style="text-align:right">${esc(b.name)}</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="prose" style="margin-top:14px">${verdict}</p>` +
    `<h2>Full profiles</h2><div class="chips"><a class="pill" href="/casino/${slugA}">${esc(a.name)} data →</a><a class="pill" href="/casino/${slugB}">${esc(b.name)} data →</a></div>` +
    `<p class="prose" style="margin-top:18px">See the full <a href="/rankings/trust">trust ranking</a> (our recommended ordering — not volume), or how the blended score is built in <a href="/methodology/trust">the methodology</a>.</p>`

  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: `${a.name} vs ${b.name}`, url },
      ],
      h1: `${a.name} vs ${b.name}`,
      updated: Date.now(),
      body,
    }),
  }
}

// ── "{brand} alternatives" — trust-ranked operators sharing a chain ────────────
// High commercial intent ("Stake alternatives") normally owned by affiliate spam.
// Ours is neutral and trust-data-backed: alternatives are operators that settle on
// a chain the target uses, ranked by independent blended trust (never volume).
function alternativesPage(
  target: CasinoView,
  targetSlug: string,
  alts: { v: CasinoView; slug: string; shared: string[] }[],
): { title: string; description: string; html: string } {
  const path = `/${targetSlug}-alternatives`
  const url = SITE + path
  const oc = target.onchain
  const bt = blendedTrust(target)
  const title = `${target.name} Alternatives ${YEAR} — Trusted Crypto Casinos Compared | WCOIN.CASINO`
  const description = `Looking for alternatives to ${target.name}? ${alts.length} crypto casinos that settle on the same chains, ranked by independent trust and verifiable on-chain reserves — not affiliate payouts. Updated continuously.`
  const rows = alts
    .map(({ v, slug, shared }) => {
      const b = blendedTrust(v)
      const o = v.onchain
      const cmp = [targetSlug, slug].sort()
      return (
        `<tr><td><a href="/casino/${slug}">${esc(v.name)}</a></td>` +
        `<td class="n">${b ? b.score : '—'}</td>` +
        `<td class="n">${o && o.reserves > 0 ? fmtUsd(o.reserves) : '—'}</td>` +
        `<td style="font-size:12px">${esc(shared.map(chainName).join(', ')) || '—'}</td>` +
        `<td><a href="/compare/${cmp[0]}-vs-${cmp[1]}">compare →</a></td></tr>`
      )
    })
    .join('')
  const selfLine = bt
    ? `For reference, ${esc(target.name)} currently carries a blended trust score of <strong>${bt.score}/100</strong>${oc && oc.reserves > 0 ? ` with ${fmtUsd(oc.reserves)} in mapped on-chain reserves` : ''}. The operators below are ranked the same way.`
    : `The operators below are ranked by the same independent blended-trust metric we apply everywhere.`
  const body =
    `<p class="sub">Reasonable alternatives to <strong>${esc(target.name)}</strong> — crypto casinos that settle on the <strong>same blockchains</strong>, ranked by <a href="/methodology/trust">independent blended trust</a> and verifiable on-chain reserves, <em>not</em> by who pays the biggest affiliate commission.</p>` +
    `<p class="upd">${selfLine} Updated continuously from indexed on-chain data and third-party ratings.</p>` +
    `<table><thead><tr><th>Operator</th><th style="text-align:right">Trust /100</th><th style="text-align:right">Mapped reserves</th><th>Shared chains</th><th>vs ${esc(target.name)}</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<h2>How this list is built</h2><div class="prose"><p>We start from every operator with <a href="/methodology/address-attribution">attributed on-chain activity</a> on a chain ${esc(target.name)} also uses, then rank by a blend of independent third-party trust ratings — the same metric behind our <a href="/rankings/trust">trust ranking</a>. On-chain volume is deliberately excluded because it is <a href="/guide/wash-trading-in-crypto-casinos-explained">easily wash-traded</a>. Every reserve figure is a wallet balance you can verify yourself on a block explorer.</p></div>` +
    `<h2>Before you switch</h2><div class="prose"><p>Check the alternative's <a href="/proof-of-reserves">proof of reserves</a> and read <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">how to spot a casino that won't pay</a>. A higher trust score is a starting signal, not a guarantee — verify solvency and terms before depositing. <strong>18+ only.</strong> See <a href="/responsible-gambling">responsible gambling resources</a>.</p></div>` +
    `<h2>Explore</h2><div class="chips"><a class="pill" href="/casino/${targetSlug}">${esc(target.name)} full data →</a><a class="pill" href="/rankings/trust">Trust ranking</a><a class="pill" href="/best-crypto-casinos">Best crypto casinos</a></div>`
  const upd = Date.now()
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: `${target.name} alternatives`, url },
      ],
      h1: `${target.name} alternatives`,
      updated: upd,
      body,
    }),
  }
}

// chain cslug → the asset slug used by the /best-{asset}-casinos pages (they differ:
// eth→ethereum, bsc→bnb, arb→arbitrum, etc.). Falls back to the cslug itself.
const BEST_ASSET_SLUG: Record<string, string> = { eth: 'ethereum', sol: 'solana', btc: 'bitcoin', bsc: 'bnb', arb: 'arbitrum', avax: 'avalanche' }
const bestAssetSlug = (cslug: string) => BEST_ASSET_SLUG[cslug] ?? cslug

// ── "{chainA} vs {chainB} for crypto casinos" — data-led chain settlement compare ─
// Answers "which chain should I deposit on?" with real on-chain settlement facts
// (operators tracked, 7d external settlement) + network characteristics from
// CHAIN_FACTS. Deliberately does NOT compare things we can't measure (payout speed).
function chainVsChainPage(
  a: { cslug: string; name: string; ops: number; settled: number },
  b: { cslug: string; name: string; ops: number; settled: number },
): { title: string; description: string; html: string } {
  const path = `/${a.cslug}-vs-${b.cslug}-casinos`
  const url = SITE + path
  const fa = CHAIN_FACTS[a.cslug]
  const fb = CHAIN_FACTS[b.cslug]
  const title = `${a.name} vs ${b.name} for Crypto Casinos ${YEAR} — Which Chain to Deposit On | WCOIN.CASINO`
  const description = `${a.name} vs ${b.name} for crypto-casino deposits: ${a.ops} vs ${b.ops} operators settling on-chain, ${fmtUsd(a.settled)} vs ${fmtUsd(b.settled)} of tracked 7-day settlement, plus real confirmation speed and fees. Data-led and neutral.`
  const row = (label: string, av: string, bv: string) => `<tr><td>${esc(label)}</td><td class="n">${av}</td><td class="n">${bv}</td></tr>`
  const rows =
    row('Operators settling here (tracked)', String(a.ops), String(b.ops)) +
    row('7d external settlement (tracked)', fmtUsd(a.settled), fmtUsd(b.settled)) +
    row('Confirmation speed', esc(fa?.speed ?? '—'), esc(fb?.speed ?? '—')) +
    row('Typical fee', esc(fa?.fee ?? '—'), esc(fb?.fee ?? '—'))
  const body =
    `<p class="sub">A neutral, on-chain look at <strong>${esc(a.name)}</strong> vs <strong>${esc(b.name)}</strong> as crypto-casino deposit rails — how many operators actually settle on each, how much real money we can see moving, and the network characteristics that matter for depositing.</p>` +
    `<p class="upd">Settlement figures are external-facing flow (real deposits/withdrawals, wash/treasury volume excluded), updated continuously from indexed on-chain data.</p>` +
    `<table><thead><tr><th>Metric</th><th style="text-align:right">${esc(a.name)}</th><th style="text-align:right">${esc(b.name)}</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<h2>${esc(a.name)} for casino deposits</h2><div class="prose"><p>${esc(fa?.why ?? '')}</p></div>` +
    `<h2>${esc(b.name)} for casino deposits</h2><div class="prose"><p>${esc(fb?.why ?? '')}</p></div>` +
    `<h2>Which should you choose?</h2><div class="prose"><p>There is no universal winner — it depends on how you play. For frequent, small stablecoin deposits, the cheaper and faster chain wins because fees compound; for large, infrequent transfers, deep liquidity and network reputation matter more than saving a few cents of gas. What actually protects you is not the chain but the <strong>operator's solvency</strong>: check <a href="/proof-of-reserves">proof of reserves</a> and independent <a href="/rankings/trust">trust ratings</a> before depositing on either. See the full <a href="/data/crypto-casino-deposit-currencies">deposit-currency breakdown</a> for where money really moves.</p></div>` +
    `<h2>Explore</h2><div class="chips"><a class="pill" href="/best-${bestAssetSlug(a.cslug)}-casinos">Best ${esc(a.name)} casinos</a><a class="pill" href="/best-${bestAssetSlug(b.cslug)}-casinos">Best ${esc(b.name)} casinos</a><a class="pill" href="/chains/${a.cslug}">${esc(a.name)} activity</a><a class="pill" href="/chains/${b.cslug}">${esc(b.name)} activity</a></div>`
  const upd = Date.now()
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [datasetLd(`${a.name} vs ${b.name} crypto-casino settlement`, description, url, upd, ['operators settling per chain', '7d external settlement per chain'])],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: `${a.name} vs ${b.name}`, url },
      ],
      h1: `${a.name} vs ${b.name} for crypto casinos`,
      updated: upd,
      body,
    }),
  }
}

// ── "best crypto casinos on {chain}" — trust-ranked, per network ───────────────
// Distinct from /chains/{chain} (which is volume-by-network): this is an editorial,
// TRUST-ranked shortlist of the operators actually settling on that chain.
function bestOnChainPage(chain: string, entries: { v: CasinoView; slug: string }[]): { title: string; description: string; html: string } {
  const cn = chainName(chain)
  const cslug = slugify(chain)
  const path = `/rankings/best-on-${cslug}`
  const url = SITE + path
  const title = `Best ${cn} Crypto Casinos ${YEAR} — Ranked by Independent Trust | WCOIN.CASINO`
  const description = `The most independently-trusted crypto casinos settling on ${cn} in ${YEAR}, ranked by a blend of third-party trust ratings (not volume). On-chain volume and reserves shown for context. Updated continuously.`
  const rows = entries
    .map((x, i) => {
      const bt = blendedTrust(x.v)
      const oc = x.v.onchain
      const onVol = oc?.byChain?.find((c) => slugify(c.chain) === cslug)?.value ?? 0
      return `<tr><td class="n">${i + 1}</td><td><a href="/casino/${x.slug}">${esc(x.v.name)}</a></td><td class="n gold">${bt ? `${bt.score} / 100` : '—'}</td><td class="n">${oc?.volumeSuspect ? '<span style="color:var(--dim)">Under review</span>' : fmtUsd(onVol)}</td><td class="n">${oc ? fmtUsd(oc.reserves) : '—'}</td></tr>`
    })
    .join('')
  const body =
    `<p class="sub">Crypto casinos with tracked settlement on <strong>${esc(cn)}</strong>, ranked by our blended independent-trust score — <em>not</em> by volume, which is easily inflated.</p>` +
    `<p class="upd">${entries.length} operators with ≥medium-confidence data · updated continuously.</p>` +
    `<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">Blended trust</th><th style="text-align:right">7d vol · ${esc(cn)}</th><th style="text-align:right">Reserves</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="prose" style="margin-top:16px">See total volume settled on this network in <a href="/chains/${cslug}">the ${esc(cn)} activity page</a>, the overall <a href="/rankings/trust">trust ranking</a>, or <a href="/methodology/trust">how trust is scored</a>.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [itemListLd(entries.map((x) => ({ url: `${SITE}/casino/${x.slug}`, name: x.v.name })))],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: `Best on ${cn}`, url },
      ],
      h1: `Best ${cn} crypto casinos ${YEAR}`,
      updated: Date.now(),
      body,
    }),
  }
}

// ── crypto-casino streamers (public SSR; data was previously app-only) ──────────
const streamerSlug = (s: { platform: string; handle: string }) => `${slugify(s.platform)}-${slugify(s.handle)}`

function streamersIndexPage(streamers: any[]): { title: string; description: string; html: string } {
  const path = '/streamers'
  const url = SITE + path
  const title = 'Top Crypto Casino Streamers — Live Gambling Streams & Followers | WCOIN.CASINO'
  const description = `The biggest crypto-casino and gambling streamers across Kick, Twitch and YouTube — ranked by following, with live status, audience and the casino each promotes. Updated continuously.`
  const rows = streamers
    .map((s, i) => {
      const aff = s.affiliation ? esc(String(s.affiliation)) : '—'
      return `<tr><td class="n">${i + 1}</td><td><a href="/streamer/${streamerSlug(s)}">${esc(s.handle)}</a></td><td>${esc(s.platform)}</td><td class="n">${fmtNum(s.followers || 0)}</td><td>${s.live ? '<span class="gold">● LIVE</span>' : 'offline'}</td><td>${aff}</td></tr>`
    })
    .join('')
  const body =
    `<p class="sub">Crypto-gambling streamers we track live across <strong>Kick, Twitch and YouTube</strong>, ranked by following. Live status and viewer counts refresh continuously; affiliation is the casino each streamer most visibly promotes.</p>` +
    `<p class="upd">${streamers.length} streamers tracked · updated continuously.</p>` +
    `<table><thead><tr><th>#</th><th>Streamer</th><th>Platform</th><th style="text-align:right">Followers</th><th>Status</th><th>Promotes</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="prose" style="margin-top:16px">Streamer promotion is a major acquisition channel for crypto casinos. Cross-reference a streamer's affiliated casino with its <a href="/rankings/trust">independent trust ranking</a> and <a href="/proof-of-reserves">on-chain reserves</a> before depositing.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Streamers', url },
      ],
      h1: 'Top crypto casino streamers',
      updated: Date.now(),
      body,
    }),
  }
}

// platform profile URL from the stored id (e.g. "twitch:roshtein" → the real slug,
// which can differ from the display handle in case/spacing)
function streamerChannelUrl(s: any): string | null {
  const slug = String(s.id ?? '').split(':')[1]
  if (!slug) return null
  const p = String(s.platform ?? '').toLowerCase()
  if (p === 'twitch') return `https://www.twitch.tv/${slug}`
  if (p === 'kick') return `https://kick.com/${slug}`
  if (p === 'youtube') return `https://www.youtube.com/@${slug}`
  return null
}

// turn a stored socials blob ({network: handleOrUrl}) into absolute profile URLs
const SOCIAL_BASE: Record<string, (h: string) => string> = {
  twitter: (h) => `https://x.com/${h.replace(/^@/, '')}`,
  x: (h) => `https://x.com/${h.replace(/^@/, '')}`,
  instagram: (h) => `https://instagram.com/${h.replace(/^@/, '')}`,
  youtube: (h) => {
    const v = h.replace(/^@/, '')
    return /^(channel|c|user)\//i.test(v) ? `https://www.youtube.com/${v}` : `https://www.youtube.com/@${v}`
  },
  tiktok: (h) => `https://www.tiktok.com/@${h.replace(/^@/, '')}`,
  facebook: (h) => `https://facebook.com/${h.replace(/^@/, '')}`,
  discord: (h) => `https://discord.gg/${h.replace(/^.*\//, '')}`,
}
function streamerSocials(s: any): { network: string; url: string }[] {
  let obj: Record<string, string> = {}
  try {
    obj = s.socials ? JSON.parse(s.socials) : {}
  } catch {
    return []
  }
  const out: { network: string; url: string }[] = []
  for (const [net, val] of Object.entries(obj)) {
    const v = String(val ?? '').trim()
    if (!v) continue
    const url = /^https?:\/\//i.test(v) ? v : SOCIAL_BASE[net.toLowerCase()]?.(v)
    if (url) out.push({ network: net.toLowerCase(), url })
  }
  return out
}

function streamerPage(s: any, affCasino: { name: string; slug: string; vol7d: number; volSuspect?: boolean; reserves: number; trust: number | null } | null): { title: string; description: string; html: string } {
  const path = `/streamer/${streamerSlug(s)}`
  const url = SITE + path
  const followers = fmtNum(s.followers || 0)
  const verified = !!s.verified
  const bio: string | null = typeof s.bio === 'string' && s.bio.trim() ? s.bio.trim() : null
  const channelUrl = streamerChannelUrl(s)
  const socials = streamerSocials(s)
  const sameAs = [channelUrl, ...socials.map((x) => x.url)].filter(Boolean) as string[]
  const title = `${esc(s.handle)} — Crypto Casino Streamer on ${esc(s.platform)} | WCOIN.CASINO`
  const description = `${s.handle} is a ${s.platform} crypto-gambling streamer with ${followers} followers${s.affiliation ? `, promoting ${s.affiliation}` : ''}. Bio, socials, live status and the on-chain data for the casino they play.`
  const affBlock = affCasino
    ? `<div class="card"><h2>Promotes: <a href="/casino/${affCasino.slug}">${esc(affCasino.name)}</a></h2>` +
      `<p class="prose">On-chain snapshot for ${esc(affCasino.name)} — independent of any promotion:</p>` +
      `<table><tbody>` +
      `<tr><td>7d on-chain volume</td><td class="n">${affCasino.volSuspect ? 'Under review' : fmtUsd(affCasino.vol7d)}</td></tr>` +
      `<tr><td>Mapped reserves</td><td class="n">${fmtUsd(affCasino.reserves)}</td></tr>` +
      `<tr><td>Blended trust</td><td class="n gold">${affCasino.trust != null ? `${affCasino.trust} / 100` : '—'}</td></tr>` +
      `</tbody></table></div>`
    : s.affiliation
      ? `<p class="prose">Most visibly promotes <strong>${esc(String(s.affiliation))}</strong>.</p>`
      : ''
  const socialChips = socials.length
    ? `<h2>Social profiles</h2><div class="chips">` +
      (channelUrl ? `<a class="pill" href="${esc(channelUrl)}" rel="nofollow noopener" target="_blank">${esc(s.platform)}</a>` : '') +
      socials.map((x) => `<a class="pill" href="${esc(x.url)}" rel="nofollow noopener" target="_blank">${esc(x.network.charAt(0).toUpperCase() + x.network.slice(1))}</a>`).join('') +
      `</div>`
    : channelUrl
      ? `<h2>Social profiles</h2><div class="chips"><a class="pill" href="${esc(channelUrl)}" rel="nofollow noopener" target="_blank">${esc(s.platform)}</a></div>`
      : ''
  // Data-driven analysis of the promoted casino — only when we have its real on-chain
  // figures, so the section is substance (not padding). Neutral, never a verdict.
  const resRatio = affCasino && !affCasino.volSuspect && affCasino.vol7d > 0 && affCasino.reserves > 0 ? (affCasino.reserves / affCasino.vol7d) * 100 : null
  const analysisBlock = affCasino
    ? `<h2>What the on-chain data says about ${esc(affCasino.name)}</h2>` +
      (affCasino.volSuspect
        ? `<p class="prose">${esc(affCasino.name)}'s on-chain volume is currently <strong>held under review</strong> — its transfer pattern is anomalous (consistent with wash trading or internal treasury churn), so we don't present it as real player activity. It holds <strong>${fmtUsd(affCasino.reserves)}</strong> in reserves mapped across the chains we track${affCasino.trust != null ? `, with a blended independent trust score of <strong>${affCasino.trust}/100</strong>` : ''}.`
        : `<p class="prose">Over the last 7 days, ${esc(affCasino.name)} settled <strong>${fmtUsd(affCasino.vol7d)}</strong> in verified on-chain volume and holds <strong>${fmtUsd(affCasino.reserves)}</strong> in reserves mapped across the chains we track${affCasino.trust != null ? `, with a blended independent trust score of <strong>${affCasino.trust}/100</strong>` : ''}.` +
          (resRatio != null ? ` Its mapped reserves are equivalent to roughly <strong>${resRatio >= 100 ? Math.round(resRatio) + '%' : resRatio.toFixed(0) + '%'}</strong> of that 7-day volume.` : '')) +
      ` These are observed wallet figures, not a solvency guarantee — a streamer promoting a casino tells you nothing about whether it can pay winners. Cross-check the reserve trend and complaint history on the <a href="/casino/${affCasino.slug}">${esc(affCasino.name)} profile</a>, its <a href="/is-${affCasino.slug}-safe">safety page</a> and our <a href="/proof-of-reserves">proof-of-reserves hub</a> before acting on any promotion.</p>`
    : ''
  // FAQ — real questions answered from this streamer's own data (+ FAQPage schema)
  const faqs: { q: string; a: string }[] = [
    { q: `What crypto casino does ${s.handle} promote?`, a: affCasino ? `${s.handle} most visibly promotes ${affCasino.name}. Its mapped on-chain reserves are ${fmtUsd(affCasino.reserves)}${affCasino.volSuspect ? ' (its volume is held under review due to an anomalous transfer pattern)' : ` and 7-day verified volume ${fmtUsd(affCasino.vol7d)}`}${affCasino.trust != null ? `, with a blended trust score of ${affCasino.trust}/100` : ''}. Promotion is observed from stream titles and bio — it is not an endorsement, and not a paid placement we verify.` : s.affiliation ? `${s.handle} most visibly promotes ${s.affiliation}, observed from stream titles and bio. We don't yet have mapped on-chain data for that operator.` : `We haven't detected a clear casino affiliation for ${s.handle} from their stream titles or bio.` },
    { q: `How many followers does ${s.handle} have on ${s.platform}?`, a: `${s.handle} has ${followers} followers on ${s.platform}${verified ? `, and is a verified/partnered channel` : ''}${s.since ? `, active on ${s.platform} since ${s.since}` : ''}. Follower and live-viewer counts on this page are pulled from ${s.platform}'s public API and refresh continuously.` },
  ]
  if (affCasino) faqs.push({ q: `Is the casino ${s.handle} promotes safe?`, a: `We don't issue safe/unsafe verdicts. ${affCasino.name} currently shows ${affCasino.trust != null ? `a blended independent trust score of ${affCasino.trust}/100` : 'no blended trust score yet'} and ${affCasino.reserves > 0 ? `mapped on-chain reserves of ${fmtUsd(affCasino.reserves)}` : 'no mapped reserves yet'}. A streamer's promotion is not a safety signal — verify solvency yourself on the ${affCasino.name} profile and our proof-of-reserves hub before depositing.` })
  const faqBlock = `<h2>FAQ</h2>` + faqs.map((f) => `<h3 style="font-size:15px;margin:14px 0 4px">${esc(f.q)}</h3><p class="prose">${esc(f.a)}</p>`).join('')
  const body =
    `<p class="sub"><strong>${esc(s.handle)}</strong> is a crypto-casino / gambling streamer on <strong>${esc(s.platform)}</strong>${verified ? ' <span class="gold">✓ verified</span>' : ''}${s.live ? ' — <span class="gold">live now</span>' : ''}.</p>` +
    (bio ? `<p class="prose">${esc(bio)}</p>` : '') +
    `<table><tbody>` +
    `<tr><td>Platform</td><td>${esc(s.platform)}</td></tr>` +
    `<tr><td>Followers</td><td class="n">${followers}</td></tr>` +
    `<tr><td>Status</td><td>${s.live ? `Live · ${fmtNum(s.viewers || 0)} viewers` : 'Offline'}</td></tr>` +
    (s.game ? `<tr><td>Category</td><td>${esc(String(s.game))}</td></tr>` : '') +
    (verified ? `<tr><td>Platform verified</td><td>Yes</td></tr>` : '') +
    (s.since ? `<tr><td>On ${esc(s.platform)} since</td><td>${esc(String(s.since))}</td></tr>` : '') +
    (s.affiliation ? `<tr><td>Most-promoted casino</td><td>${affCasino ? `<a href="/casino/${affCasino.slug}">${esc(affCasino.name)}</a>` : esc(String(s.affiliation))}</td></tr>` : '') +
    `</tbody></table>` +
    socialChips +
    affBlock +
    analysisBlock +
    faqBlock +
    `<p class="prose" style="margin-top:16px">Profile data (bio, socials, follower count, verified status) is pulled from ${esc(s.platform)}'s own public API and refreshed continuously. Affiliation is the casino this streamer most visibly promotes — observed from stream titles and bio, not a paid placement.</p>` +
    `<p class="prose" style="margin-top:10px">See all <a href="/streamers">tracked crypto casino streamers</a>. Streamer promotion ≠ endorsement of solvency — always check a casino's <a href="/proof-of-reserves">on-chain reserves</a> and <a href="/rankings/trust">independent trust</a>.</p>`
  const personLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: s.handle,
    ...(bio ? { description: bio } : {}),
    ...(s.thumbnail ? { image: s.thumbnail } : {}),
    ...(sameAs.length ? { sameAs } : {}),
    ...(channelUrl ? { url: channelUrl } : {}),
  }
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  }
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [personLd, faqLd],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Streamers', url: SITE + '/streamers' },
        { name: s.handle, url },
      ],
      h1: `${esc(s.handle)} — crypto casino streamer`,
      updated: Date.now(),
      body,
    }),
  }
}

// ── rankings ──────────────────────────────────────────────────────────────────
// metric leaderboards run over on-chain brands (quantitative); the trust board
// runs over the full merged view set (so all rated operators are eligible).
type MetricCfg = { title: string; blurb: string; metric: (e: BrandAgg) => number; fmt: (e: BrandAgg) => string; col: string }
const METRICS: Record<string, MetricCfg> = {
  volume: { title: 'Top crypto casinos by on-chain volume (7d)', blurb: 'Crypto casinos ranked by tracked on-chain transaction volume over the last 7 days.', metric: (e) => e.volume7d, fmt: (e) => fmtUsd(e.volume7d), col: '7d volume' },
  movers: { title: 'Biggest crypto casinos by 24h on-chain volume', blurb: 'Operators with the most tracked on-chain volume in the last 24 hours.', metric: (e) => e.volume24h, fmt: (e) => fmtUsd(e.volume24h), col: '24h volume' },
  reserves: { title: 'Crypto casinos by mapped on-chain reserves', blurb: 'Operators ranked by all-chain reserves mapped from on-chain wallets (proof-of-reserves estimate).', metric: (e) => e.reserves, fmt: (e) => fmtUsd(e.reserves), col: 'Mapped reserves' },
  coverage: { title: 'Crypto casinos by withdrawal-coverage ratio', blurb: 'Mapped reserves divided by 7-day outflow — a descriptive on-chain liquidity indicator (not a solvency rating).', metric: (e) => e.reserveCoverage ?? 0, fmt: (e) => (e.reserveCoverage != null ? e.reserveCoverage.toFixed(1) + '×' : '—'), col: 'Coverage ratio' },
  netflow: { title: 'Crypto casinos by 7-day net on-chain flow', blurb: 'Operators ranked by net on-chain flow (inflow minus outflow) over the last 7 days.', metric: (e) => e.net7d, fmt: (e) => (e.net7d >= 0 ? '+' : '−') + fmtUsd(Math.abs(e.net7d)), col: 'Net flow 7d' },
  players: { title: 'Most active crypto casinos by on-chain counterparties', blurb: 'Operators ranked by distinct on-chain counterparties (a proxy for active players) over 7 days.', metric: (e) => e.players, fmt: (e) => fmtNum(e.players), col: 'Counterparties 7d' },
}

// flow-based rankings exclude volume-suspect brands (anomalous wash/internal volume)
const SUSPECT_EXCLUDE_RANKINGS = new Set(['volume', 'movers', 'netflow', 'players'])

function metricRankingPage(key: string, brands: BrandAgg[], slugOfBrand: (b: BrandAgg) => string): { title: string; description: string; html: string } | null {
  const cfg = METRICS[key]
  if (!cfg) return null
  const url = `${SITE}/rankings/${key}`
  const excludeSuspect = SUSPECT_EXCLUDE_RANKINGS.has(key)
  const rows = brands
    .filter((e) => Math.abs(cfg.metric(e)) > 0)
    .filter((e) => !(excludeSuspect && e.volumeSuspect))
    .sort((a, b) => cfg.metric(b) - cfg.metric(a))
    .slice(0, 50)
  const title = `${cfg.title} | WCOIN.CASINO`
  const description = `${cfg.blurb} Ranking ${rows.length} operators from live on-chain data. Free, updated continuously.`
  const trows = rows
    .map(
      (e, i) =>
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOfBrand(e)}">${esc(e.brand)}</a></td><td class="n">${esc(cfg.fmt(e))}</td><td class="n" style="color:var(--mut)">${fmtUsd(e.volume7d)}</td></tr>`,
    )
    .join('')
  const others = [...Object.keys(METRICS), 'trust'].filter((k) => k !== key)
  // activity (flow) metrics are gameable on-chain — label them honestly
  const isActivity = ['volume', 'movers', 'netflow', 'players'].includes(key)
  const caveat = isActivity
    ? `<p class="prose" style="margin:10px 0;padding:11px 14px;background:#ffffff08;border:1px solid var(--line);border-radius:11px;font-size:13px"><strong>Read this as activity, not quality.</strong> On-chain volume and flow can be inflated by wash trading and internal/self transfers, so this is a liquidity/activity signal — not an endorsement. For a quality ranking see <a href="/rankings/trust">most trusted casinos</a>.</p>`
    : ''
  const body = `
<p class="sub">${esc(cfg.blurb)}</p>
<p class="upd">${rows.length} operators · live on-chain data, refreshed continuously · <a href="/rankings">all rankings</a></p>
${caveat}
<div class="chips">${others.map((k) => `<a class="pill" href="/rankings/${k}">${esc(rankingLabel(k))}</a>`).join('')}</div>
<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">${esc(cfg.col)}</th><th style="text-align:right">7d volume</th></tr></thead><tbody>${trows}</tbody></table>
<p class="prose" style="margin-top:22px">See live deposits, withdrawals and reserve history on the <a href="/app/casinos">interactive dashboard</a>, or the whole-market view in the <a href="/daily">daily report</a>.</p>`
  const jsonLd = [
    { '@type': 'ItemList', name: cfg.title, itemListElement: rows.map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: e.brand, url: `${SITE}/casino/${slugOfBrand(e)}` })) },
  ]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: cfg.col, url },
      ],
      h1: cfg.title,
      updated: Date.now(),
      body,
    }),
  }
}

// Consumer-facing proof-of-reserves GUIDE + verified list. Distinct intent from the
// /rankings/reserves leaderboard (a ranking) and /methodology/proof-of-reserves (how we
// estimate): this answers "which crypto casinos have proof of reserves / what does it
// mean" with an explainer + FAQ schema + the live verified list. The on-chain moat page.
function reservesHubPage(brands: BrandAgg[], slugOfBrand: (b: BrandAgg) => string): { title: string; description: string; html: string } {
  const url = `${SITE}/proof-of-reserves`
  const withReserves = brands.filter((b) => (b.reserves ?? 0) > 0).sort((a, b) => (b.reserves ?? 0) - (a.reserves ?? 0)).slice(0, 60)
  const totalRes = withReserves.reduce((s, b) => s + (b.reserves ?? 0), 0)
  const title = 'Crypto Casino Proof of Reserves — Verified List & How It Works | WCOIN.CASINO'
  const description = `Which crypto casinos have on-chain proof of reserves? We map ${withReserves.length} operators' wallet reserves directly from the blockchain (≈${fmtUsd(totalRes)} tracked) and explain what proof of reserves does — and doesn't — prove.`
  const trows = withReserves
    .map(
      (e, i) =>
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOfBrand(e)}">${esc(e.brand)}</a></td><td class="n gold">${fmtUsd(e.reserves ?? 0)}</td><td class="n">${e.reserveCoverage != null ? e.reserveCoverage.toFixed(1) + '×' : '—'}</td></tr>`,
    )
    .join('')
  const faqs = [
    { q: 'What is proof of reserves for a crypto casino?', a: 'Proof of reserves means an operator\'s holdings can be verified directly on the blockchain rather than taken on trust. Because crypto wallets are public, anyone can check the balances of an operator\'s known wallets at any time.' },
    { q: 'How does WCOIN.CASINO track casino reserves?', a: 'We map the on-chain wallets we associate with each operator and read their all-chain balances directly from the blockchain, refreshed roughly every 30 minutes. Coverage varies by operator and attribution carries inherent uncertainty — see our methodology.' },
    { q: 'Does proof of reserves mean a casino is solvent or safe?', a: 'No. Mapped reserves show what is observable on-chain at a point in time. They are not a statement on solvency, liabilities, legality, or safety, and balances can move. Treat reserves as one descriptive signal among several.' },
    { q: 'Which crypto casinos have the largest mapped reserves?', a: `As of the latest update, operators with the largest mapped on-chain reserves include ${withReserves.slice(0, 5).map((b) => b.brand).join(', ') || '—'}. See the full ranked list below.` },
  ]
  const body =
    `<p class="sub">Proof of reserves lets you verify a crypto casino's holdings <strong>directly on the blockchain</strong> instead of taking the operator's word for it. Below is every casino whose wallets we map on-chain, with reserves read live from the chain.</p>` +
    `<p class="upd">${withReserves.length} operators with mapped reserves · ≈${fmtUsd(totalRes)} tracked · refreshed continuously · <a href="/rankings/reserves">reserves ranking</a> · <a href="/methodology/proof-of-reserves">how we estimate</a></p>` +
    `<p class="prose" style="margin:10px 0;padding:11px 14px;background:#ffffff08;border:1px solid var(--line);border-radius:11px;font-size:13px"><strong>What this is — and isn't.</strong> Mapped reserves are an on-chain best-effort estimate from wallets we attribute to each operator; coverage varies and attribution is uncertain. This is observed on-chain data, <em>not</em> a statement on any operator's solvency, legality, fairness, or safety.</p>` +
    `<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">Mapped reserves</th><th style="text-align:right">Coverage ratio</th></tr></thead><tbody>${trows}</tbody></table>` +
    `<h2 style="margin-top:26px">Proof of reserves — FAQ</h2>` +
    faqs.map((f) => `<h3 style="margin:16px 0 4px;font-size:15px">${esc(f.q)}</h3><p class="prose">${esc(f.a)}</p>`).join('') +
    `<p class="prose" style="margin-top:22px">Track any operator's reserve history on the <a href="/app/casinos">interactive dashboard</a>, or see the daily market-wide view in the <a href="/daily">daily report</a>.</p>`
  const jsonLd = [
    { '@type': 'ItemList', name: 'Crypto casinos with proof of reserves', itemListElement: withReserves.map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: e.brand, url: `${SITE}/casino/${slugOfBrand(e)}` })) },
    { '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  ]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Proof of Reserves', url },
      ],
      h1: 'Crypto Casino Proof of Reserves',
      updated: Date.now(),
      body,
    }),
  }
}

function trustRankingPage(views: CasinoView[], slugOfView: (v: CasinoView) => string): { title: string; description: string; html: string } {
  const url = `${SITE}/rankings/trust`
  const rows = views
    .map((v) => ({ v, t: blendedTrust(v) }))
    .filter((x): x is { v: CasinoView; t: { score: number; sources: number } } => x.t != null)
    .sort((a, b) => b.t.score - a.t.score)
    .slice(0, 50)
  const title = 'Crypto casinos by trust signals — third-party rating ranking | WCOIN.CASINO'
  const description = `Crypto casinos ranked by a blended score of independently published trust signals (casino.guru, AskGamblers, casino.org, Trustpilot). Only operators with ≥2 verified sources. ${rows.length} operators, updated continuously.`
  const trows = rows
    .map((x, i) => {
      const s = trustSources(x.v)
        .map((q) => q.label.replace('casino.guru', 'guru').replace('AskGamblers', 'AG').replace('casino.org', 'org'))
        .join(' · ')
      return `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOfView(x.v)}">${esc(x.v.name)}</a></td><td class="n gold">${x.t.score} / 100</td><td class="n" style="color:var(--mut)">${x.t.sources} · ${esc(s)}</td></tr>`
    })
    .join('')
  const others = Object.keys(METRICS)
  const body = `
<p class="sub">Crypto casinos ranked by a blended 0–100 score from independently published ratings — only operators with <strong>≥2 verified sources</strong> qualify. Shown with attribution, not our judgement of any operator.</p>
<p class="upd">${rows.length} operators · this is our recommended ranking (on-chain volume is easily inflated by wash trading) · <a href="/rankings">all rankings</a> · <a href="/methodology/trust">how ratings are sourced</a></p>
<div class="chips">${others.map((k) => `<a class="pill" href="/rankings/${k}">${esc(rankingLabel(k))}</a>`).join('')}</div>
<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">Blended trust</th><th style="text-align:right">Sources</th></tr></thead><tbody>${trows}</tbody></table>
<p class="prose" style="margin-top:22px">Ratings are produced by third parties; we aggregate and attribute them. Browse the live <a href="/app/sentiment">trust &amp; reserves board</a>.</p>`
  const jsonLd = [
    { '@type': 'ItemList', name: 'Crypto casinos by third-party trust rating', itemListElement: rows.map((x, i) => ({ '@type': 'ListItem', position: i + 1, name: x.v.name, url: `${SITE}/casino/${slugOfView(x.v)}` })) },
  ]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: 'Trust', url },
      ],
      h1: 'Crypto casinos by third-party trust rating',
      updated: Date.now(),
      body,
    }),
  }
}

const rankingLabel = (k: string) =>
  k === 'trust' ? 'By trust rating' : k === 'volume' ? 'By 7d volume' : k === 'movers' ? 'By 24h volume' : k === 'reserves' ? 'By reserves' : k === 'coverage' ? 'By coverage ratio' : k === 'netflow' ? 'By net flow' : k === 'players' ? 'By active counterparties' : k

function rankingsIndexPage(chains: string[], hasUnattributed: boolean): { title: string; description: string; html: string } {
  const url = `${SITE}/rankings`
  const title = 'Crypto casino rankings — most trusted, reserves & on-chain activity | WCOIN.CASINO'
  const description = 'Crypto-casino leaderboards led by blended third-party trust ratings (our recommended ranking), plus mapped reserves, withdrawal coverage and on-chain activity. All from live data, clearly sourced.'
  const reserveKeys = ['reserves', 'coverage'] // reserve-backed, harder to fake
  const activityKeys = ['volume', 'movers', 'netflow', 'players'] // gameable on-chain
  const li = (k: string) => `<li><a href="/rankings/${k}">${esc(rankingLabel(k))}</a></li>`
  const chainLinks = chains.map((c) => `<a class="pill" href="/chains/${slugify(c)}">${esc(chainName(c))}</a>`).join('')
  const body = `
<p class="sub">Crypto-casino leaderboards, built from live on-chain data and independently published third-party ratings — every figure shown with its source.</p>
<h2>★ Top by trust signals <span class="pill">recommended</span></h2>
<p class="prose">Our primary ranking: a blended score from independent third-party trust signals (operators with ≥2 verified sources). We rank by trust, not transaction volume — <a href="/methodology/trust">why</a>.</p>
<ul class="prose" style="line-height:2"><li><a href="/rankings/trust"><strong>Crypto casinos by trust signals →</strong></a></li></ul>
<h2>Reserves &amp; solvency</h2>
<ul class="prose" style="line-height:2">${reserveKeys.map(li).join('')}</ul>
<h2>On-chain activity</h2>
<p class="prose" style="font-size:13px;color:var(--dim)">Activity/liquidity signals — not a quality measure. On-chain volume and flow can be inflated by wash trading, so treat these as scale indicators, not endorsements.</p>
<ul class="prose" style="line-height:2">${activityKeys.map(li).join('')}</ul>
<h2>By blockchain</h2>
<p class="prose">Per-network casino volume:</p>
<div class="chips">${chainLinks}</div>
${hasUnattributed ? `<h2>Unattributed flow</h2><p class="prose">Pattern-detected casino-related wallet activity not yet attributed to a verified brand — kept out of the rankings above. <a href="/rankings/unattributed-flow">View unattributed casino flow →</a></p>` : ''}
<p class="prose" style="margin-top:22px">Or see the whole-market snapshot in the <a href="/daily">daily report</a>.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url },
      ],
      h1: 'Crypto casino rankings',
      updated: Date.now(),
      body,
    }),
  }
}

// ── chains ────────────────────────────────────────────────────────────────────
// Real per-chain settlement characteristics for crypto-casino deposits/withdrawals.
// Factual (block time / fee level / stablecoin support / how casinos actually use the
// chain) — this is context, not padding, and makes every qualifying chain page a
// substantive, indexable answer rather than a bare table.
const CHAIN_FACTS: Record<string, { speed: string; fee: string; why: string }> = {
  eth: { speed: 'blocks every ~12 seconds, final in a minute or two', fee: 'gas can run several dollars and spikes with congestion', why: 'Casinos use Ethereum for larger transfers and for the reputation and deep liquidity of ERC-20 USDT/USDC, less for high-frequency small deposits where the gas fee bites. It is the security-and-liquidity chain, not the cheap-and-fast one.' },
  tron: { speed: 'confirms in seconds', fee: 'fees of cents or effectively free', why: 'USDT-TRC20 on Tron is the single most-used crypto-casino deposit rail in the world — cheap, fast and dollar-stable. If an operator settles a lot of small player flow, it is almost certainly doing it here. This is the default stablecoin rail for casino play.' },
  bsc: { speed: '~3-second blocks', fee: 'fees of a few cents', why: 'High throughput and very low cost make BNB Chain a common casino settlement venue for BEP-20 stablecoins — second-tier to Tron for stablecoin deposits but widely supported.' },
  polygon: { speed: 'a few seconds to confirm', fee: 'fees of a fraction of a cent', why: 'A low-fee EVM network increasingly used by casinos for cheap USDT/USDC play, combining Ethereum-compatible tooling with negligible transaction costs.' },
  sol: { speed: 'sub-second finality', fee: 'sub-cent fees', why: 'Solana pairs near-instant settlement with tiny fees and native USDC, making it a fast-growing casino deposit and payout venue for players who want speed.' },
  base: { speed: 'a couple of seconds to confirm', fee: 'fees of a fraction of a cent', why: "Coinbase's Ethereum L2 — cheap, fast and USDC-native. A newer but rapidly-growing casino settlement chain, attractive for low-fee stablecoin play." },
  btc: { speed: '~10-minute blocks (casinos usually wait 1–3 confirmations)', fee: 'fees that vary with mempool congestion', why: "Native Bitcoin casinos exist and appeal to players who already hold BTC or value censorship-resistance, but Bitcoin is a small single-digit share of actual deposit flow compared with stablecoins — it suits large, infrequent transfers more than frequent play." },
  arb: { speed: 'fast, near-instant confirmation', fee: 'fees of cents', why: 'An Ethereum L2 with deep USDC/USDT liquidity at low fees — used by casinos that want Ethereum-ecosystem assets without mainnet gas costs.' },
  avax: { speed: 'sub-second finality', fee: 'low fees', why: 'A fast-finality chain with USDT/USDC support — a smaller but active casino settlement venue.' },
  op: { speed: 'fast confirmation', fee: 'low fees', why: 'An Ethereum L2 (OP Stack) with USDC support and low fees — a smaller casino settlement venue in the Ethereum L2 family.' },
  sei: { speed: 'fast finality', fee: 'low fees', why: 'A newer high-performance chain seeing early casino settlement activity.' },
  xrp: { speed: 'settles in seconds', fee: 'negligible fees', why: 'The XRP Ledger settles quickly and cheaply; a smaller share of casino activity settles here.' },
}

function chainPage(chain: string, brands: BrandAgg[], slugOfBrand: (b: BrandAgg) => string): { title: string; description: string; html: string } {
  const name = chainName(chain)
  const cslug = slugify(chain)
  const url = `${SITE}/chains/${cslug}`
  const onChain = brands
    // volume IS the ranking basis here, so anomalous (wash/treasury-pattern) operators
    // are excluded outright — flag+demote, never rank suspect volume as if real.
    .filter((e) => !e.volumeSuspect)
    .map((e) => ({ e, v: (e.byChain ?? []).find((c) => slugify(c.chain) === slugify(chain))?.value ?? 0 }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 30)
  const total = onChain.reduce((s, x) => s + x.v, 0)
  const max = Math.max(...onChain.map((x) => x.v), 1)
  const facts = CHAIN_FACTS[cslug]
  const leader = onChain.slice(0, 3).map((x) => x.e.brand).join(', ')
  const title = `${name} Crypto Casinos ${YEAR} — On-Chain Volume by Operator | WCOIN.CASINO`
  const description = `Crypto casinos settling on ${name}: ${fmtUsd(total)} tracked 7-day on-chain volume across ${onChain.length} operators${leader ? ` (top: ${leader})` : ''}. Verified on-chain data — internal churn and wash/treasury flow excluded. Updated continuously.`
  const trows = onChain
    .map(
      (x, i) =>
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOfBrand(x.e)}">${esc(x.e.brand)}</a></td><td class="n">${fmtUsd(x.v)}</td><td style="width:120px"><div class="bar"><span style="width:${Math.max(3, (x.v / max) * 100)}%"></span></div></td></tr>`,
    )
    .join('')
  const factsBlock = facts
    ? `<h2>${esc(name)} for crypto-casino settlement</h2><p class="prose">On ${esc(name)}, transactions ${facts.speed}, with ${facts.fee}. ${facts.why} We track ${onChain.length} operator${onChain.length === 1 ? '' : 's'} with real settlement activity on ${esc(name)}, totalling ${fmtUsd(total)} of verified 7-day volume — internal hot-wallet churn, casino-to-casino double counts and <a href="/guide/wash-trading-in-crypto-casinos-explained">wash/treasury flow</a> excluded, so the figure reflects genuine player activity.</p>`
    : ''
  const body = `
<p class="sub">Crypto casinos with tracked on-chain settlement on <strong>${esc(name)}</strong>, ranked by verified 7-day volume.</p>
<p class="upd">${onChain.length} operators · ${fmtUsd(total)} total verified 7d volume · <a href="/rankings">all rankings</a></p>
<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">7d volume on ${esc(name)}</th><th></th></tr></thead><tbody>${trows}</tbody></table>
${factsBlock}
<h2>How to read this</h2><p class="prose">This is on-chain settlement volume attributed to casino wallets on ${esc(name)} — verified deposits and withdrawals, not inflated throughput. Volume is easily wash-traded, so it is a measure of <em>activity</em>, not trustworthiness: rank operators by independent trust and verifiable <a href="/proof-of-reserves">reserves</a> before depositing, not by volume alone. See the <a href="/methodology/on-chain-volume">volume methodology</a>, the trust-ranked <a href="/rankings/best-on-${cslug}">best ${esc(name)} casinos</a> where available, or the live <a href="/app/blockchain">on-chain feed</a>.</p>`
  const faqs = [
    { q: `Which crypto casinos use ${name}?`, a: `We track ${onChain.length} operator${onChain.length === 1 ? '' : 's'} settling real volume on ${name}${leader ? `, led by ${leader}` : ''}. The full ranked list with per-operator 7-day volume is above; each links to that operator's on-chain profile.` },
    ...(facts ? [{ q: `Is ${name} good for crypto-casino deposits?`, a: `On ${name}, transactions ${facts.speed} with ${facts.fee}. ${facts.why}` }] : []),
    { q: `How much crypto-casino volume settles on ${name}?`, a: `Currently ${fmtUsd(total)} of verified 7-day volume across ${onChain.length} tracked operator${onChain.length === 1 ? '' : 's'} — with internal churn, double counts and wash/treasury flow excluded, so it reflects genuine player activity rather than inflated throughput.` },
  ]
  const chUpdated = Date.now()
  const jsonLd = [
    datasetLd(`${name} crypto-casino on-chain volume`, description, url, chUpdated, ['7d on-chain volume', 'per-operator settlement']),
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } })) },
  ]
  const bodyWithFaq = body + `<h2>FAQ</h2>` + faqs.map((f) => `<h3 style="font-size:15px;margin:14px 0 4px">${esc(f.q)}</h3><p class="prose">${f.a}</p>`).join('')
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Chains', url: SITE + '/rankings' },
        { name, url },
      ],
      h1: `${name} crypto casinos ${YEAR}`,
      updated: chUpdated,
      body: bodyWithFaq,
    }),
  }
}

// ── daily report archive ──────────────────────────────────────────────────────
function reportPage(snap: any, prev: string | null, next: string | null): { title: string; description: string; html: string } {
  const date = snap.snapshot_date
  const url = `${SITE}/reports/daily/${date}`
  const p = snap.payload || {}
  const net = snap.net_flow_24h ?? 0
  const title = `Crypto casino market — ${date} | Daily on-chain report | WCOIN.CASINO`
  const description = `Crypto-casino market on ${date} (UTC): ${fmtUsd(snap.tracked_volume_24h ?? 0)} verified tracked 24h on-chain volume across ${snap.active_casinos ?? 0} verified brands and ${snap.active_chains ?? 0} chains, ${fmtUsd(snap.reserves_total ?? 0)} tracked all-chain reserves. Unattributed flow excluded.`

  const stats =
    `<div class="grid">` +
    stat('24H Verified Tracked Volume', fmtUsd(snap.tracked_volume_24h ?? 0)) +
    stat('Net flow (24h)', (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), net >= 0 ? 'mint' : 'rose') +
    stat('Active Verified Brands', fmtNum(snap.active_casinos ?? 0)) +
    stat('Active Chains', String(snap.active_chains ?? 0)) +
    stat('Live streamers', String(snap.live_streamers ?? 0)) +
    stat('Tracked reserves', fmtUsd(snap.reserves_total ?? 0), 'mint') +
    `</div>`

  // AI "Today's Market Read" (QA-gated prose; numbers are program-injected) — unique
  // editorial per day, strong for SEO. Only present once generated for that date.
  let read: any = null
  try {
    read = snap.ai_market_read ? JSON.parse(snap.ai_market_read) : null
  } catch {
    read = null
  }
  const readT =
    read && (read.what_changed || read.why_it_matters || read.what_to_watch)
      ? `<h2>Today's market read</h2>` +
        [
          ['What changed', read.what_changed],
          ['Why it matters', read.why_it_matters],
          ['What to watch next', read.what_to_watch],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => `<p class="prose"><strong style="color:var(--gold)">${k}.</strong> ${esc(String(v))}</p>`)
          .join('')
      : ''

  const movers = (p.topMovers ?? []).slice(0, 8)
  const moversT = movers.length
    ? `<h2>Verified casino flow — biggest movers (24h)</h2><table><thead><tr><th>Operator</th><th style="text-align:right">24h volume</th><th style="text-align:right">7d volume</th></tr></thead><tbody>${movers
        .map((m: any) => `<tr><td><a href="/casino/${slugify(m.label)}">${esc(m.label)}</a></td><td class="n">${fmtUsd(m.vol24h)}</td><td class="n" style="color:var(--mut)">${fmtUsd(m.vol7d ?? 0)}</td></tr>`)
        .join('')}</tbody></table>`
    : ''

  const chains = (p.chainVolume ?? []).slice(0, 10)
  const maxC = Math.max(...chains.map((c: any) => c.vol7d || 0), 1)
  const chainsT = chains.length
    ? `<h2>Volume by chain (7d)</h2><table><tbody>${chains
        .map((c: any) => `<tr><td><span class="pill">${esc(chainName(c.chain))}</span></td><td class="n">${fmtUsd(c.vol7d)}</td><td style="width:120px"><div class="bar"><span style="width:${Math.max(3, ((c.vol7d || 0) / maxC) * 100)}%"></span></div></td></tr>`)
        .join('')}</tbody></table>`
    : ''

  // aggregated whale activity (grouped by brand·chain·direction); fall back to raw
  // events for snapshots taken before aggregation existed
  const wGroups = (p.whaleGroups ?? []).length
    ? p.whaleGroups.slice(0, 12)
    : (p.whales ?? []).slice(0, 10).map((w: any) => ({ label: w.label, chain: w.chain, direction: w.direction, count: 1, total: w.usd, largest: w.usd }))
  const whalesT = wGroups.length
    ? `<h2>Whale activity — aggregated (24h, ≥ $50K)</h2><p class="prose" style="font-size:13px;color:var(--dim)">Observed large wallet transfers involving tracked casino-related wallets. Does not indicate user identity or intent.</p><table><thead><tr><th>Operator</th><th>Network</th><th style="text-align:right">Events</th><th style="text-align:right">Total</th></tr></thead><tbody>${wGroups
        .map(
          (g: any) =>
            `<tr><td>${esc(g.label)}</td><td><span class="pill">${esc(chainName(g.chain))}</span></td><td class="n">${g.count} ${g.direction === 'in' ? 'in' : 'out'}</td><td class="n ${g.direction === 'in' ? 'mint' : 'rose'}">${g.direction === 'in' ? '+' : '−'}${fmtUsd(g.total)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''

  const COV: Record<string, string> = { high: 'High', medium: 'Medium', partial: 'Partial', under_review: 'Under review', unknown: 'Unknown' }
  const reserves = (p.topReserves ?? []).slice(0, 8)
  const reservesT = reserves.length
    ? `<h2>Tracked all-chain reserves</h2><p class="prose" style="font-size:13px;color:var(--dim)">Observed wallet balances for verified casino brands. Coverage may be partial — not a complete financial statement.</p><table><thead><tr><th>Operator</th><th>Coverage</th><th style="text-align:right">Tracked reserves</th></tr></thead><tbody>${reserves
        .map((r: any) => `<tr><td><a href="/casino/${slugify(r.label)}">${esc(r.label)}</a></td><td><span class="pill">${esc(COV[r.level] ?? 'Unknown')}</span></td><td class="n mint">${fmtUsd(r.reserves)}</td></tr>`)
        .join('')}</tbody></table>`
    : ''

  // unattributed flow — pattern-detected, never mixed into the verified figures above
  const u = p.unattributed
  const unattrT =
    u && u.count
      ? `<h2>Unattributed Casino-related Flow</h2><p class="prose" style="font-size:13px;color:var(--dim)">Pattern-detected casino-related wallet activity not yet attributed to a verified casino brand — shown separately and excluded from every verified figure and ranking above until attribution improves. Confidence: low.</p><table><tbody>${(u.top ?? [])
          .map((x: any) => `<tr><td>${esc(x.label)}</td><td class="n">${fmtUsd(x.vol7d)} 7d</td></tr>`)
          .join('')}<tr><td><strong>Total unattributed</strong></td><td class="n"><strong>${fmtUsd(u.vol24h)} 24h · ${fmtUsd(u.vol7d)} 7d</strong></td></tr></tbody></table>`
      : ''

  const confNote = `<p class="prose" style="margin-top:20px;font-size:13px"><strong>Data coverage notes.</strong> Headline figures are <em>verified</em> casino flow only — brand-merged on-chain observations for the stated window. Unattributed pattern flow is reported separately and excluded from every figure above. Reserve coverage is partial by brand and expressed as a level, not a percentage. See <a href="/methodology/data-confidence">how we rate data confidence</a>.</p>`

  const pager =
    prev || next
      ? `<div class="pager">${prev ? `<a href="/reports/daily/${prev}">← ${esc(prev)}</a>` : '<span></span>'}${next ? `<a href="/reports/daily/${next}">${esc(next)} →</a>` : '<span></span>'}</div>`
      : ''

  const body = `
<p class="sub">Verified on-chain snapshot of the crypto-casino market for <strong>${esc(date)} (UTC)</strong> — verified flow only; unattributed flow shown separately.</p>
<p class="upd">Archived daily report · <a href="/reports/weekly/${isoWeek(date).key}">week ${esc(isoWeek(date).key)} summary</a> · <a href="/daily">today's live report</a></p>
${pager}
${stats}
${readT}
${moversT}
${chainsT}
${whalesT}
${reservesT}
${unattrT}
${confNote}
${pager}
<p class="prose" style="margin-top:22px">Numbers are observed on-chain activity for the stated 24-hour window. See the <a href="/methodology/on-chain-volume">volume</a> and <a href="/methodology/proof-of-reserves">reserves</a> methodology, or the live <a href="/app">dashboard</a>.</p>`
  const jsonLd = [
    { '@type': 'Dataset', name: `Crypto casino market snapshot ${date}`, description, url, temporalCoverage: date, creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE }, isAccessibleForFree: true },
  ]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Daily reports', url: SITE + '/daily' },
        { name: date, url },
      ],
      h1: `Crypto casino market — ${date}`,
      updated: Date.now(),
      body,
      ogImage: `${SITE}/api/share/daily.png?date=${encodeURIComponent(date)}`,
    }),
  }
}

// ── Weekly report — aggregates the week's daily snapshots into one evergreen page ─
function isoWeek(dateStr: string): { key: string; start: string; end: string } {
  const d = new Date(dateStr + 'T00:00:00Z')
  const day = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - day)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const thursday = new Date(monday)
  thursday.setUTCDate(monday.getUTCDate() + 3)
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { key: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) }
}

function weeklyReportPage(wk: { key: string; start: string; end: string }, days: any[], prev: string | null, next: string | null): { title: string; description: string; html: string } {
  const url = `${SITE}/reports/weekly/${wk.key}`
  const n = days.length
  const totalVol = days.reduce((s, r) => s + (r.tracked_volume_24h ?? 0), 0)
  const netFlow = days.reduce((s, r) => s + (r.net_flow_24h ?? 0), 0)
  const avgBrands = Math.round(days.reduce((s, r) => s + (r.active_casinos ?? 0), 0) / Math.max(1, n))
  const last = days[days.length - 1]
  const reserves = last?.reserves_total ?? 0
  const peak = days.slice().sort((a, b) => (b.tracked_volume_24h ?? 0) - (a.tracked_volume_24h ?? 0))[0]

  // weekly brand leaderboard — sum each brand's daily 24h volume across the week
  const brandVol = new Map<string, number>()
  const chainVol = new Map<string, number>()
  for (const r of days) {
    for (const m of r.payload?.topMovers ?? []) brandVol.set(m.label, (brandVol.get(m.label) ?? 0) + (m.vol24h ?? 0))
    for (const c of r.payload?.chainVolume ?? []) chainVol.set(c.chain, (chainVol.get(c.chain) ?? 0) + (c.vol24h ?? 0))
  }
  const topBrands = [...brandVol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const chains = [...chainVol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const totChain = chains.reduce((s, c) => s + c[1], 0) || 1

  const title = `Crypto casino market — week ${wk.key} | Weekly on-chain report | WCOIN.CASINO`
  const description = `Crypto-casino market for ISO week ${wk.key} (${wk.start} → ${wk.end}): ${fmtUsd(totalVol)} total verified on-chain volume across ${n} tracked days, ${fmtUsd(reserves)} end-of-week reserves. Verified flow only.`

  const stats =
    `<div class="grid">` +
    stat('Verified volume (week)', fmtUsd(totalVol)) +
    stat('Net flow (week)', (netFlow >= 0 ? '+' : '−') + fmtUsd(Math.abs(netFlow)), netFlow >= 0 ? 'mint' : 'rose') +
    stat('Avg active brands/day', String(avgBrands)) +
    stat('Days covered', String(n)) +
    stat('Peak day', peak ? fmtUsd(peak.tracked_volume_24h ?? 0) : '—') +
    stat('End-of-week reserves', fmtUsd(reserves), 'mint') +
    `</div>`

  const brandsT = topBrands.length
    ? `<h2>Top verified casino flow — week ${esc(wk.key)}</h2><table><thead><tr><th>Operator</th><th style="text-align:right">Week volume</th></tr></thead><tbody>${topBrands
        .map(([b, v]) => `<tr><td><a href="/casino/${slugify(b)}">${esc(b)}</a></td><td class="n">${fmtUsd(v)}</td></tr>`)
        .join('')}</tbody></table>`
    : ''
  const chainsT = chains.length
    ? `<h2>Volume by chain — week</h2><table><tbody>${chains.map(([c, v]) => `<tr><td><span class="pill">${esc(chainName(c))}</span></td><td class="n">${fmtUsd(v)}</td><td class="n" style="color:var(--mut)">${((v / totChain) * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>`
    : ''
  const trendT = `<h2>Daily breakdown</h2><table><thead><tr><th>Date</th><th style="text-align:right">Verified volume</th><th style="text-align:right">Active brands</th></tr></thead><tbody>${days
    .map((r) => `<tr><td><a href="/reports/daily/${r.snapshot_date}">${esc(r.snapshot_date)}</a></td><td class="n">${fmtUsd(r.tracked_volume_24h ?? 0)}</td><td class="n">${r.active_casinos ?? 0}</td></tr>`)
    .join('')}</tbody></table>`

  const pager =
    prev || next
      ? `<div class="pager">${prev ? `<a href="/reports/weekly/${prev}">← ${esc(prev)}</a>` : '<span></span>'}${next ? `<a href="/reports/weekly/${next}">${esc(next)} →</a>` : '<span></span>'}</div>`
      : ''

  const body = `
<p class="sub">Verified weekly snapshot of the crypto-casino market — ISO week <strong>${esc(wk.key)}</strong> (${esc(wk.start)} → ${esc(wk.end)}, UTC). Verified flow only; unattributed flow excluded.</p>
<p class="upd">Aggregated from ${n} daily snapshots · <a href="/daily">today's live report</a></p>
${pager}
${stats}
${brandsT}
${chainsT}
${trendT}
<p class="prose" style="margin-top:20px;font-size:13px"><strong>Data coverage notes.</strong> Weekly figures sum the verified daily snapshots for the period; unattributed pattern flow is excluded throughout. Reserves are an all-chain best-effort estimate. See <a href="/methodology/on-chain-volume">volume</a> and <a href="/methodology/proof-of-reserves">reserves</a> methodology.</p>
${pager}`
  const jsonLd = [{ '@type': 'Dataset', name: `Crypto casino market — week ${wk.key}`, description, url, temporalCoverage: `${wk.start}/${wk.end}`, creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE }, isAccessibleForFree: true }]
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd,
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Daily reports', url: SITE + '/daily' },
        { name: `Week ${wk.key}`, url },
      ],
      h1: `Crypto casino market — week ${wk.key}`,
      updated: Date.now(),
      body,
      ogImage: last ? `${SITE}/api/share/daily.png?date=${encodeURIComponent(last.snapshot_date)}` : undefined,
    }),
  }
}

// ── risk registry index — neutral, sourced; on-chain signals + curated incidents ─
function riskIndexPage(events: RiskEvent[]): { title: string; description: string; html: string } {
  const url = `${SITE}/risk`
  const title = `Crypto Casino Risk Registry — On-Chain Signals & Incidents | WCOIN.CASINO`
  const description = `A neutral, sourced registry of crypto-casino risk signals: observed on-chain reserve drops and coverage anomalies, plus publicly-reported incidents shown with their source. Not a verdict — do your own research.`
  const sevCol = (s: string) => (s === 'elevated' ? 'rose' : s === 'watch' ? 'gold' : 'mut')
  const rows = events
    .map((e) => {
      const brand = e.brand_label ? `<a href="/casino/${slugify(e.brand_label)}">${esc(e.brand_label)}</a>` : esc(e.brand_key)
      const src = e.source_url ? `<a href="${esc(e.source_url)}" rel="nofollow noopener" target="_blank">source →</a>` : '<span class="pill">on-chain</span>'
      return `<tr><td>${brand}</td><td><span class="${sevCol(e.severity)}">${esc(e.title)}</span></td><td><span class="pill">${e.kind === 'incident' ? 'incident' : 'signal'}</span></td><td class="n">${src}</td></tr>`
    })
    .join('')
  const body =
    `<p class="sub">A neutral, sourced registry of observed crypto-casino risk signals and publicly-reported incidents. <strong>On-chain signals</strong> are our own observed wallet data; <strong>incidents</strong> are shown with their source and the operator's response where available.</p>` +
    `<p class="upd">Updated continuously. This is <em>not</em> a statement on any operator's solvency, safety or legality.</p>` +
    (events.length
      ? `<table><thead><tr><th>Operator</th><th>Signal / event</th><th>Type</th><th style="text-align:right">Source</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="prose">No open risk signals or incidents right now. On-chain signals appear automatically when observed (e.g. a material reserve drop); incidents are added when publicly reported with a source.</p>`) +
    `<p class="prose" style="margin-top:18px;font-size:13px">On-chain signals are derived from observed wallet data with partial coverage and may be benign. Incidents are publicly-reported events linked to their source; inclusion is not an endorsement of the claim. Nothing here is a verdict. Spotted something we should track? <a href="/daily">Submit evidence or a correction →</a> See the <a href="/methodology/data-confidence">data-confidence methodology</a>.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Risk registry', url },
      ],
      h1: 'Crypto casino risk registry',
      updated: Date.now(),
      body,
    }),
  }
}

// Unattributed Casino Flow — pattern-detected wallet clusters we can't yet tie to a
// verified brand. Listed transparently, kept OUT of verified rankings, no profiles.
function unattributedFlowPage(brands: BrandAgg[]): { title: string; description: string; html: string } {
  const url = `${SITE}/rankings/unattributed-flow`
  const rows = brands.filter((b) => b.volume7d > 0).sort((a, b) => b.volume7d - a.volume7d).slice(0, 30)
  const total = rows.reduce((s, b) => s + b.volume7d, 0)
  const title = 'Unattributed Casino Flow — pattern-detected wallet activity | WCOIN.CASINO'
  const description = 'Pattern-detected casino-related on-chain wallet activity not yet attributed to a verified casino brand. Shown separately from verified rankings, for transparency.'
  const trows = rows
    .map(
      (b, i) =>
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td>${esc(b.brand)}</td><td class="n">${fmtUsd(b.volume7d)}</td><td class="n" style="color:var(--mut)">${fmtUsd(b.reserves)}</td><td>${(b.chains || []).slice(0, 3).map((c) => `<span class="pill">${esc(chainName(c))}</span>`).join(' ')}</td></tr>`,
    )
    .join('')
  const body = `
<p class="sub">Pattern-detected casino-related wallet activity <strong>not yet attributed</strong> to a verified casino brand — listed here for transparency and deliberately kept out of the verified rankings.</p>
<p class="upd">${rows.length} wallet clusters · ${fmtUsd(total)} observed 7d flow · <span class="pill">data confidence: low</span></p>
<table><thead><tr><th>#</th><th>Wallet cluster</th><th style="text-align:right">7d flow</th><th style="text-align:right">Tracked reserves</th><th>Chains</th></tr></thead><tbody>${trows}</tbody></table>
<p class="prose" style="margin-top:22px">These clusters show on-chain patterns consistent with casino activity, but we have not confirmed which operator (if any) controls them — so they are <em>excluded</em> from the <a href="/rankings/trust">verified rankings</a> and get no casino profile. See <a href="/methodology/address-attribution">how we attribute on-chain activity</a>.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: 'Unattributed flow', url },
      ],
      h1: 'Unattributed Casino Flow',
      updated: Date.now(),
      body,
    }),
  }
}

// methodology: hand-written explainers (stable, link targets for the disclaimers)
const METHODOLOGY: Record<string, { title: string; body: string }> = {
  'address-attribution': {
    title: 'How we attribute on-chain activity to crypto casinos',
    body: `<p>WCOIN.CASINO links blockchain wallets to crypto-casino operators using public block-explorer name-tags, published hot-wallet addresses, on-chain clustering of deposit/withdrawal patterns, and cross-referencing against third-party datasets. A single operator typically runs many wallets across several chains, which we group under one brand.</p>
<p>Attribution is a best-effort inference, not a certainty. Wallets can be mislabelled, shared, rotated, or operated by third parties (payment processors, market makers). We continuously revise mappings as new evidence appears. Figures should be read as <em>observed activity for the wallets we associate with an operator</em> — not an audited, operator-confirmed total.</p>
<p>Activity we detect as casino-like but cannot yet tie to a specific brand is marked <strong>unattributed</strong> and kept out of verified rankings — see the <a href="/rankings/unattributed-flow">Unattributed Casino Flow</a> page. We deliberately do not publish verdicts on operators.</p>`,
  },
  'on-chain-volume': {
    title: 'How on-chain volume is measured',
    body: `<p>On-chain volume is the USD value of transfers to and from attributed casino wallets over a window (24-hour and 7-day), priced at transfer time. It captures on-chain settlement — deposits and withdrawals that touch the public blockchain — and excludes purely off-chain ledger movements inside an operator, which are not observable.</p>
<p>A figure reflects observed settlement only and should not be read as revenue, profit, or gross gaming revenue.</p>
<p><strong>Why we don't rank by volume.</strong> On-chain volume is easily inflated — wash trading, internal transfers between an operator's own wallets, and market-maker activity all add observable volume without reflecting real player activity or quality. We therefore treat volume as an activity/liquidity signal only, and our recommended ranking is <a href="/rankings/trust">by blended third-party trust signals</a>, which is far harder to manufacture.</p>`,
  },
  'net-flow': {
    title: 'How net flow is measured',
    body: `<p>Net flow is observed inflow (deposits) minus outflow (withdrawals) to attributed casino wallets over a window, in USD. A positive net flow means more value moved in than out over the period; a negative net flow means more moved out.</p>
<p>It is an <em>observation of on-chain settlement</em>, not a profit-and-loss figure. Sustained net outflow can have many benign causes — treasury rebalancing, cold-storage moves, processor settlement — so we describe it neutrally as <strong>observed net flow</strong> and never infer financial distress, insolvency, or wrongdoing from it. Reserve context (see <a href="/methodology/proof-of-reserves">proof-of-reserves</a>) matters when reading flow.</p>`,
  },
  'proof-of-reserves': {
    title: 'How we estimate all-chain reserves (proof-of-reserves)',
    body: `<p>Reserves are the current on-chain balance of stablecoins and major assets held by wallets we attribute to an operator, summed across every chain we map and priced in USD. It is an all-chain, best-effort proof-of-reserves estimate.</p>
<p>Coverage varies: we can only sum wallets we have mapped, so the true figure may be higher, and some balances belong to processors rather than the operator. The withdrawal-coverage ratio (reserves ÷ 7-day outflow) is a descriptive liquidity indicator, <em>not</em> a solvency rating. None of this is a statement that any operator is or is not solvent.</p>`,
  },
  'data-confidence': {
    title: 'How we rate data confidence',
    body: `<p>Every brand and page carries a <strong>data-confidence</strong> label — high, medium or low — so you can weigh the numbers appropriately. It reflects how much independent signal backs the figures, not a judgement of the operator.</p>
<p><strong>High</strong>: tracked on-chain activity, or three or more independent third-party rating sources. <strong>Medium</strong>: tracked on-chain reserves, an authoritative single source (casino.guru or AskGamblers), or two sources. <strong>Low</strong>: a single low-weight signal, or pattern-detected activity not yet attributed to a verified brand.</p>
<p>Public casino profiles and rankings require at least <em>medium</em> confidence. Low-confidence and unattributed data is shown only in clearly-labelled contexts and is never presented as a verified casino.</p>`,
  },
  trust: {
    title: 'How third-party trust signals are sourced',
    body: `<p>We aggregate independently published ratings — the casino.guru Safety Index, Trustpilot consumer scores, AskGamblers expert ratings, casino.org editorial ratings, and casino.guru complaint counts — and show each with its source. Where we display a blended score, it is a transparent combination of those external signals, and we only publish a blended score when at least two independent sources exist.</p>
<p>These ratings are produced by third parties and shown for convenience with attribution. We do not endorse, verify, or originate them, and they are not our judgement of any operator.</p>`,
  },
}

function methodologyPage(topic: string): { title: string; description: string; html: string } | null {
  const m = METHODOLOGY[topic]
  if (!m) return null
  const url = `${SITE}/methodology/${topic}`
  const title = `${m.title} | WCOIN.CASINO methodology`
  const description = m.body.replace(/<[^>]+>/g, '').slice(0, 155)
  const others = Object.keys(METHODOLOGY).filter((k) => k !== topic)
  const body = `
<p class="upd">WCOIN.CASINO methodology</p>
<div class="prose">${m.body}</div>
<h2>More methodology</h2>
<div class="chips">${others.map((k) => `<a class="pill" href="/methodology/${k}">${esc(METHODOLOGY[k].title)}</a>`).join('')}</div>
<p class="prose" style="margin-top:22px">See the data these methods produce in the <a href="/daily">daily report</a> or the <a href="/app">live dashboard</a>.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [{ '@type': 'Article', headline: m.title, author: { '@type': 'Organization', name: 'WCOIN.CASINO' }, publisher: { '@type': 'Organization', name: 'WCOIN.CASINO' } }],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Methodology', url: SITE + '/methodology/address-attribution' },
        { name: m.title, url },
      ],
      h1: m.title,
      updated: Date.now(),
      body,
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation — rebuild every page into seo_page from the warm aggregate cache
// ─────────────────────────────────────────────────────────────────────────────
// Content fingerprint with the per-rebuild VOLATILE timestamps stripped out, so a
// page whose real content is unchanged hashes identically across rebuilds. Without
// this, article:modified_time / "Last updated" / JSON-LD dateModified (all = the
// rebuild's Date.now()) would make every page look freshly modified every 30 min —
// the exact lastmod-inflation that makes crawlers stop trusting <lastmod>.
function contentHash(html: string): string {
  const stable = html
    .replace(/<meta property="article:modified_time"[^>]*>/g, '')
    .replace(/"dateModified":"[^"]*"/g, '')
    .replace(/Last updated: \d{4}-\d{2}-\d{2}/g, '')
  return createHash('sha1').update(stable).digest('hex')
}
// updated_at only advances when content_hash actually changes → sitemap <lastmod>
// reflects real modifications. New pages get @now; unchanged pages keep their stored
// updated_at; genuinely-changed pages (moving on-chain numbers, edited copy) bump it.
const upsert = db.prepare(
  `INSERT INTO seo_page(path, kind, title, description, html, content_hash, updated_at, lifecycle)
   VALUES(@path,@kind,@title,@description,@html,@hash,@now,@lifecycle)
   ON CONFLICT(path) DO UPDATE SET kind=@kind, title=@title, description=@description, html=@html, lifecycle=@lifecycle,
     updated_at=CASE WHEN seo_page.content_hash IS @hash THEN seo_page.updated_at ELSE @now END,
     content_hash=@hash`,
)
const enqueueEnrich = db.prepare(
  `INSERT INTO enrichment_queue(brand_key, label, slug, confidence, missing, status, created_at, updated_at)
   VALUES(@brand_key,@label,@slug,@confidence,@missing,'pending',@now,@now)
   ON CONFLICT(brand_key) DO UPDATE SET label=@label, slug=@slug, confidence=@confidence, missing=@missing, updated_at=@now,
     status=CASE WHEN enrichment_queue.status='promoted' THEN 'promoted' ELSE 'pending' END`,
)

const MAX_CASINOS = Number(process.env.SEO_MAX_CASINOS ?? 600)
const MAX_REPORTS = Number(process.env.SEO_MAX_REPORTS ?? 400)

// ── E-E-A-T + YMYL compliance pages (§4.1 / §4.4) ────────────────────────────
function aboutPage(): { title: string; description: string; html: string } {
  const url = `${SITE}/about`
  const title = 'About WCOIN.CASINO — Independent On-Chain Crypto-Casino Intelligence'
  const description = 'WCOIN.CASINO is an independent data-media platform tracking crypto casinos on-chain — verified volume, proof-of-reserves and trust signals. Not an operator, no paid rankings.'
  const body = `
<p class="sub">WCOIN.CASINO is an independent on-chain intelligence platform for the crypto-casino industry. We are a <strong>data-media site — not a casino, not an operator, and not an affiliate that sells rankings.</strong></p>
<h2>What we do</h2>
<div class="prose"><p>We attribute public blockchain transfers to crypto-casino operators and surface what the chain actually shows: tracked deposit/withdrawal volume, all-chain reserves mapped from on-chain wallets, net flow, and independent third-party trust ratings (always shown with their source). Everything is derived from public on-chain data and public review sources — information anyone can independently verify.</p></div>
<h2>How we're different</h2>
<div class="prose"><p>Most casino "review" sites rank by affiliate payouts. We don't. Our default ranking is <a href="/rankings/trust">independent trust</a>, never volume — which is trivially wash-traded. We separate <em>verified</em> wallet attribution from <em>claimed</em> / pattern-detected flow, and we never state a verdict on any operator's solvency, legality, fairness or safety.</p></div>
<h2>Data &amp; methodology</h2>
<div class="prose"><p>See our <a href="/methodology/address-attribution">attribution methodology</a>, <a href="/methodology/proof-of-reserves">proof-of-reserves methodology</a> and <a href="/methodology/trust">trust scoring</a>. Data refreshes roughly every 30 minutes. Spot an error in our attribution? <a href="/app">Report a correction</a> — corrections are reviewed and, where valid, applied.</p>
<p><strong>Open data.</strong> We publish the attributed wallet set, curated label sources and full methodology on GitHub for independent audit — every address is verifiable on its block explorer, and git history shows how the dataset evolves: <a href="https://github.com/chenny2023/wcoin-casino-data" rel="noopener" target="_blank">github.com/chenny2023/wcoin-casino-data</a> (CC BY 4.0). The read-only JSON API the site runs on is free and open — see the <a href="https://github.com/chenny2023/wcoin-casino-data/blob/main/API.md" rel="noopener" target="_blank">API docs</a>.</p></div>
<h2>Coverage</h2>
<div class="prose"><p>Explore the <a href="/rankings">rankings hub</a>, per-operator on-chain pages, per-chain activity, the <a href="/daily">daily report</a>, and <a href="/streamers">streamer tracking</a>.</p></div>
<p class="prose" style="margin-top:18px"><strong>18+ only.</strong> This site provides data, not gambling. Nothing here is financial, legal or investment advice. See <a href="/responsible-gambling">responsible gambling resources</a>.</p>`
  return { title, description, html: layout({ title, description, canonical: url, breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'About', url }], h1: 'About WCOIN.CASINO', updated: Date.now(), body }) }
}

// ── 2026 H1 whitepaper landing page (social-shareable, PDF download) ──────────
const WHITEPAPER_PDF = '/wcoin-2026-h1-crypto-igaming-market-outlook.pdf'
function whitepaperPage(): { title: string; description: string; html: string } {
  const url = `${SITE}/whitepaper`
  const title = `2026 H1 Crypto iGaming Market Outlook — Free Whitepaper (PDF) | WCOIN.CASINO`
  const description = `Free data whitepaper: stablecoin payments, on-chain capital flows and the next iGaming trust layer. Built on WCOIN.CASINO's open, verifiable on-chain dataset (verified volume, all-chain proof-of-reserves, blended trust) as of 2026-07-03. Download the PDF.`
  const body =
    `<p class="sub"><strong>2026 H1 Crypto iGaming Market Outlook</strong> — stablecoin payments, on-chain capital flows, and the next iGaming trust layer. Built on our open, independently verifiable dataset, not estimates.</p>` +
    `<p style="margin:22px 0"><a class="cta" style="display:inline-block;background:linear-gradient(90deg,#f5c542,#f5b100);color:#0a0a0f;font-weight:700;padding:13px 26px;border-radius:12px;text-decoration:none" href="${WHITEPAPER_PDF}" download>Download the whitepaper (PDF, free — no email required)</a></p>` +
    `<h2>What's inside</h2><div class="prose"><ul>` +
    `<li><strong>Market overview</strong> — verified on-chain casino volume (internal churn, double counts and wash/treasury-pattern flow excluded), daily trend from our measured snapshot archive, and net-flow structure.</li>` +
    `<li><strong>Operator landscape</strong> — the on-chain leaderboard by verified activity, all-chain proof-of-reserves with coverage levels, and blended third-party trust.</li>` +
    `<li><strong>Payments</strong> — why stablecoins (USDT-TRC20 above all) dominate deposit rails, with the chain split from live settlement data.</li>` +
    `<li><strong>The trust layer</strong> — how public blockchains make casino solvency independently checkable, and what "Under review" volume flags mean.</li>` +
    `</ul></div>` +
    `<h2>Why this report is different</h2><p class="prose">Every figure traces to public, reproducible data: the wallet set, evidence classes, rule thresholds and the full export pipeline are published in our <a href="https://github.com/chenny2023/wcoin-casino-data" rel="noopener" target="_blank">open-data repository (GitHub)</a>, and the same numbers are served live by our <a href="/about">free public API</a>. Where measurement began mid-period, the report says so instead of extrapolating — honesty about coverage is the methodology.</p>` +
    `<h2>Cite or share</h2><p class="prose">The report is free to share and cite with attribution to <strong>wcoin.casino</strong> (data: CC BY 4.0). For the always-current figures behind it, see the <a href="/daily">daily market report</a>, <a href="/best-crypto-casinos">rankings</a> and <a href="/proof-of-reserves">proof-of-reserves hub</a>.</p>`
  const reportLd = {
    '@context': 'https://schema.org',
    '@type': 'Report',
    name: '2026 H1 Crypto iGaming Market Outlook',
    headline: 'Stablecoin Payments, Onchain Capital Flows, and the Next iGaming Trust Layer',
    datePublished: '2026-07-03',
    url,
    encoding: { '@type': 'MediaObject', contentUrl: SITE + WHITEPAPER_PDF, encodingFormat: 'application/pdf' },
    author: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
    publisher: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
  }
  return { title, description, html: layout({ title, description, canonical: url, jsonLd: [reportLd], breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Whitepaper', url }], h1: '2026 H1 Crypto iGaming Market Outlook', updated: Date.now(), body }) }
}

function responsibleGamblingPage(): { title: string; description: string; html: string } {
  const url = `${SITE}/responsible-gambling`
  const title = 'Responsible Gambling — Help & Resources | WCOIN.CASINO'
  const description = 'Gambling can be addictive. WCOIN.CASINO is a data platform (18+). Find responsible-gambling tools and free, confidential help resources by region.'
  const orgs = [
    ['BeGambleAware (UK)', 'https://www.begambleaware.org', 'Free, confidential advice and a 24/7 helpline.'],
    ['GamCare (UK)', 'https://www.gamcare.org.uk', 'Support, information and counselling for problem gambling.'],
    ['National Council on Problem Gambling (US)', 'https://www.ncpgambling.org', 'Call/text 1-800-522-4700 — 24/7, confidential.'],
    ['Gamblers Anonymous', 'https://www.gamblersanonymous.org', 'Peer fellowship for those who want to stop gambling.'],
    ['Gambling Therapy (Global)', 'https://www.gamblingtherapy.org', 'Free online support in multiple languages, worldwide.'],
  ]
  const list = orgs.map(([n, u, d]) => `<tr><td><a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(n)}</a></td><td>${esc(d)}</td></tr>`).join('')
  const body = `
<p class="sub"><strong>You must be 18+ (or the legal age in your jurisdiction) to gamble.</strong> WCOIN.CASINO is an information and data platform — we do not operate gambling and do not take bets. Gambling can be addictive; please play responsibly.</p>
<h2>Signs it may be a problem</h2>
<div class="prose"><p>Spending more than you can afford, chasing losses, borrowing to gamble, gambling to escape stress, or hiding it from people close to you. If any of this sounds familiar, free and confidential help is available.</p></div>
<h2>Tools that help</h2>
<div class="prose"><p>Set deposit and time limits, use cooling-off / self-exclusion features your operator provides, and consider blocking software (e.g. Gamban, GameStop). Never treat gambling as a way to make money.</p></div>
<h2>Free, confidential help</h2>
<table><thead><tr><th>Organisation</th><th>What they offer</th></tr></thead><tbody>${list}</tbody></table>
<p class="prose" style="margin-top:16px">Availability and legality of gambling vary by jurisdiction — it is your responsibility to comply with your local laws. Nothing on this site is an endorsement to gamble. See our <a href="/about">about page</a> and <a href="/methodology/trust">methodology</a>.</p>`
  return { title, description, html: layout({ title, description, canonical: url, breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Responsible gambling', url }], h1: 'Responsible gambling', updated: Date.now(), body }) }
}

// §4.3 — /insights archive of the dated daily reports (hub for the digest pages)
function insightsIndexPage(snaps: any[]): { title: string; description: string; html: string } {
  const url = `${SITE}/insights`
  const title = 'Crypto Casino Insights — Daily On-Chain Market Reports | WCOIN.CASINO'
  const description = `Archive of WCOIN.CASINO daily on-chain crypto-casino reports — tracked volume, reserve moves, whale flow and chain breakdown. ${snaps.length} editions and counting.`
  const rows = snaps
    .slice(0, 120)
    .map((s) => `<tr><td><a href="/reports/daily/${s.snapshot_date}">Daily report — ${s.snapshot_date}</a></td><td class="n">${fmtUsd(s.tracked_volume_24h ?? 0)}</td><td class="n">${s.active_casinos ?? 0}</td></tr>`)
    .join('')
  const body =
    `<p class="sub">Every day we publish an on-chain snapshot of the crypto-casino market — verified tracked volume, reserve watch, whale flow and chain breakdown. Browse the archive below or get it in your inbox.</p>` +
    `<p class="upd">${snaps.length} daily editions · newest first</p>` +
    `<table><thead><tr><th>Edition</th><th style="text-align:right">24h tracked volume</th><th style="text-align:right">Active casinos</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="prose" style="margin-top:16px">See today's <a href="/daily">live daily report</a> or the overall <a href="/rankings/trust">trust ranking</a>.</p>`
  return { title, description, html: layout({ title, description, canonical: url, breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Insights', url }], h1: 'Crypto casino insights — daily reports', updated: Date.now(), body }) }
}

// §5.3 — indexable submission landing pages (keyword-optimised, form posts to
// /submit/:kind → recorded as a reviewed submission). Free, editorial, no pay-for-rank.
function submitPage(kind: 'casino' | 'kol'): { title: string; description: string; html: string } {
  const isCasino = kind === 'casino'
  const url = `${SITE}/submit/${kind}`
  const title = isCasino
    ? 'Submit Your Crypto Casino — Get Listed on WCOIN.CASINO (Free)'
    : 'Submit a Crypto Casino Streamer or KOL — WCOIN.CASINO'
  const description = isCasino
    ? 'Run a crypto casino? Submit your operator and on-chain wallets to be tracked on WCOIN.CASINO — independent, on-chain, free. We verify attribution before listing; we never sell rankings.'
    : 'Submit a crypto-gambling streamer or KOL to WCOIN.CASINO’s public streamer index. Free, no login — reviewed before listing.'
  const inputStyle = 'width:100%;background:#ffffff08;border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--fg);font-size:14px;margin:6px 0'
  const form = `<form method="POST" action="/submit/${kind}" style="max-width:520px;margin:14px 0">
  <input name="name" required maxlength="120" placeholder="${isCasino ? 'Casino / operator name' : 'Streamer handle + platform (e.g. Kick / Xposed)'}" style="${inputStyle}">
  <input name="email" type="email" maxlength="200" placeholder="Email (optional — for follow-up only)" style="${inputStyle}">
  ${isCasino ? `<input name="evidence" maxlength="500" placeholder="On-chain wallet address(es) or block-explorer link" style="${inputStyle}">` : ''}
  <textarea name="message" required minlength="5" maxlength="3500" rows="4" placeholder="${isCasino ? 'Chains you settle on, which wallets are deposit vs hot, anything that helps us verify.' : 'Why they fit, links to their channels, affiliated casino.'}" style="${inputStyle}"></textarea>
  <button type="submit" style="background:linear-gradient(135deg,#ffe27a,#f5b100);border:0;border-radius:9px;padding:11px 22px;font-weight:700;font-size:14px;color:#1a1205;cursor:pointer">Submit for review</button>
</form>`
  const body = isCasino
    ? `<p class="sub">Get your crypto casino tracked with verified on-chain data — independent and free. <strong>We never sell rankings; submitting does not buy placement or a higher score.</strong></p>
<h2>How submission works</h2>
<div class="prose"><p>Submit your operator name and the on-chain hot/deposit wallets you want associated with it. Before anything appears as <em>verified</em>, we check the attribution against public block-explorer name-tags and on-chain behaviour — claimed data is never shown as verified, and we never state a verdict on your solvency, legality or safety. Listing is editorial: it reflects what the chain shows, not what you pay.</p><p>Once verified, your operator gets an on-chain page with tracked deposit/withdrawal volume, all-chain mapped reserves (proof-of-reserves), net flow and a blended independent-trust score, plus eligibility for the per-chain and metric leaderboards and the daily report. Everything updates roughly every 30 minutes from public on-chain data.</p><p>Already listed and something looks wrong? Use the same form to file a correction — corrections are reviewed and, where valid, applied. See our <a href="/methodology/address-attribution">attribution methodology</a> and <a href="/methodology/proof-of-reserves">proof-of-reserves methodology</a> for exactly how figures are produced.</p></div>
${form}
<p class="prose">Submissions are reviewed by hand and are <strong>not a guarantee of listing</strong>. We list operators we can attribute on-chain or that carry credible third-party ratings. Read more <a href="/about">about us</a>. 18+ only — see <a href="/responsible-gambling">responsible gambling</a>.</p>`
    : `<p class="sub">Add a crypto-casino streamer or KOL to our <a href="/streamers">public streamer index</a> — free, no login.</p>
<h2>How it works</h2>
<div class="prose"><p>Tell us the streamer’s handle and platform (Kick, Twitch or YouTube) and, if you know it, the casino they most visibly promote. We review the submission and, where it fits our coverage, add them to the public index with their live status, follower count and affiliated casino — cross-linked to that casino’s on-chain data so readers can sanity-check promotion against verified reserves and trust.</p><p>We track streamers as part of the crypto-casino information landscape; inclusion is editorial and is not an endorsement of the streamer or the casinos they promote. Public stats only — we don’t publish private information.</p></div>
${form}
<p class="prose">Submissions are reviewed and are <strong>not a guarantee of listing</strong>. See <a href="/streamers">all tracked streamers</a> and our <a href="/about">about page</a>. 18+ only.</p>`
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: isCasino ? 'Submit a casino' : 'Submit a streamer', url }], h1: isCasino ? 'Submit your crypto casino' : 'Submit a streamer or KOL', updated: Date.now(), body }),
  }
}

// §4.2 — flagship hub. The central "Best Crypto Casinos {year}" page that targets
// the top head term and hub-spokes out to per-casino, per-chain and metric pages.
// Educational guide — evergreen content that explains our data/methodology and
// targets informational queries. FAQPage schema when Q&A is supplied.
function guidePage(cfg: {
  path: string
  h1: string
  title: string
  description: string
  intro: string
  sections: { h: string; body: string }[]
  faqs?: { q: string; a: string }[]
  related: string
}): { title: string; description: string; html: string } {
  const url = SITE + cfg.path
  const body =
    `<p class="sub">${cfg.intro}</p>` +
    cfg.sections.map((s) => `<h2>${esc(s.h)}</h2><div class="prose">${s.body}</div>`).join('') +
    (cfg.faqs?.length ? `<h2>FAQ</h2>${cfg.faqs.map((f) => `<div class="prose"><strong>${esc(f.q)}</strong><br>${f.a}</div>`).join('')}` : '') +
    `<div class="prose" style="margin-top:16px">${cfg.related}</div>`
  const jsonLd: object[] = []
  if (cfg.faqs?.length) jsonLd.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: cfg.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } })) })
  // Article schema for E-E-A-T + freshness: org-authored, continuously updated. Stable
  // publish date; dateModified tracks the live refresh (consistent with the site's
  // "updated continuously" framing).
  const updated = Date.now()
  jsonLd.push({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: cfg.h1,
    description: cfg.description,
    datePublished: GUIDE_PUBLISHED,
    dateModified: new Date(updated).toISOString(),
    author: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
    publisher: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE, logo: { '@type': 'ImageObject', url: SITE + '/og.svg' } },
    mainEntityOfPage: url,
    isAccessibleForFree: true,
  })
  return {
    title: cfg.title,
    description: cfg.description,
    html: layout({ title: cfg.title, description: cfg.description, canonical: url, jsonLd, breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Guides', url: SITE + '/guide' }, { name: cfg.h1, url }], h1: cfg.h1, updated, body }),
  }
}

// Data-story page — the credible cross-chain deposit/withdrawal breakdown (external-
// only, wash/treasury excluded). Unique on-chain data → linkable. Dataset schema.
function currencyReportPage(chainRows: { chain: string; v: number }[], total: number): { title: string; description: string; html: string } {
  const path = '/data/crypto-casino-deposit-currencies'
  const url = SITE + path
  const title = `What Currencies & Chains Do Crypto Casinos Use? On-Chain Data ${YEAR} | WCOIN.CASINO`
  const description = `On-chain breakdown of where crypto-casino money actually moves in ${YEAR}: stablecoins (USDT on Tron + Ethereum) dominate deposits & withdrawals; native BTC is a small share. Verified, wash/treasury-churn excluded.`
  const rows = chainRows
    .map((c) => `<tr><td><span class="pill">${esc(chainName(c.chain))}</span></td><td class="n">${fmtUsd(c.v)}</td><td class="n">${total > 0 ? ((100 * c.v) / total).toFixed(1) : '0'}%</td></tr>`)
    .join('')
  const lead = chainRows[0] ? `${chainName(chainRows[0].chain)} leads with ${((100 * chainRows[0].v) / (total || 1)).toFixed(0)}% of tracked flow` : ''
  const body =
    `<p class="sub">Where does crypto-casino money actually move on-chain? We tracked <strong>${fmtUsd(total)}</strong> of external deposits + withdrawals over the last 7 days across every major chain. ${lead}.</p>` +
    `<p class="upd">Verified external flow only — internal hot-wallet churn, double-counts and wash/treasury volume are excluded, so these shares reflect real player money. Live data, refreshed ~every 30 min.</p>` +
    `<table><thead><tr><th>Chain</th><th style="text-align:right">7d external flow</th><th style="text-align:right">Share</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<h2>The takeaway: crypto casinos run on stablecoins</h2><div class="prose"><p>The data is unambiguous — the overwhelming majority of crypto-casino deposit and withdrawal flow is <strong>stablecoins (USDT), settled on Tron and Ethereum</strong>. USDT-TRC20 in particular is the dominant rail: low fees, fast finality, dollar-stable. Native Bitcoin, despite its profile, is a small single-digit share of actual deposit flow — most BTC sits in treasury wallets rather than moving as player deposits.</p><p>This matters because most "volume" figures you'll see elsewhere are inflated by internal hot-wallet churn and a handful of operators' treasury/market-making transfers. We strip those out (see <a href="/methodology/address-attribution">methodology</a>), so the split above reflects money players actually move.</p></div>` +
    `<h2>Explore the data</h2><div class="chips"><a class="pill" href="/best-usdt-casinos">Best USDT casinos</a><a class="pill" href="/highest-volume-crypto-casinos">Highest verified volume</a><a class="pill" href="/crypto-casinos-with-proof-of-reserves">Proof of reserves</a><a class="pill" href="/daily">Daily report</a></div>`
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, jsonLd: [datasetLd('Crypto Casino Deposit Currency & Chain Breakdown', description, url, Date.now(), ['7d external on-chain flow by chain', 'chain share of deposits/withdrawals'])], breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Data', url }], h1: `What currencies & chains do crypto casinos use?`, updated: Date.now(), body }),
  }
}

// Reserves report — aggregate view of all-chain tracked reserves (total, by chain,
// top operators). Distinct from the per-operator PoR list; a linkable data story.
function reservesReportPage(chainRes: { chain: string; v: number; casinos: number }[], total: number, top: { v: CasinoView; slug: string }[]): { title: string; description: string; html: string } {
  const path = '/data/crypto-casino-reserves'
  const url = SITE + path
  const title = `Crypto Casino Reserves Report ${YEAR} — All-Chain On-Chain Reserves | WCOIN.CASINO`
  const description = `How much do crypto casinos actually hold? We track ${fmtUsd(total)} in all-chain on-chain reserves across the operators we map — by chain and by operator, independently verifiable.`
  const chainRows = chainRes
    .map((c) => `<tr><td><span class="pill">${esc(chainName(c.chain))}</span></td><td class="n">${fmtUsd(c.v)}</td><td class="n">${total > 0 ? ((100 * c.v) / total).toFixed(1) : '0'}%</td><td class="n">${c.casinos}</td></tr>`)
    .join('')
  const opRows = top
    .map((x, i) => `<tr><td class="n">${i + 1}</td><td><a href="/casino/${x.slug}">${esc(x.v.name)}</a></td><td class="n">${fmtUsd(x.v.onchain?.reserves ?? 0)}</td></tr>`)
    .join('')
  const body =
    `<p class="sub">Proof of reserves, aggregated. Across the casinos we map on-chain, we currently track <strong>${fmtUsd(total)}</strong> in reserves — wallet balances anyone can verify on a block explorer, not self-reported claims.</p>` +
    `<p class="upd">Reserves are mapped from public wallet attribution and read live across every chain. Best-effort and partial by brand. Refreshed continuously.</p>` +
    `<h2>Reserves by chain</h2><table><thead><tr><th>Chain</th><th style="text-align:right">Tracked reserves</th><th style="text-align:right">Share</th><th style="text-align:right">Operators</th></tr></thead><tbody>${chainRows}</tbody></table>` +
    `<h2>Top operators by tracked reserves</h2><table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">Mapped reserves</th></tr></thead><tbody>${opRows}</tbody></table>` +
    `<p class="prose" style="margin-top:14px">Reserves show assets, not liabilities — they signal an operator can likely honour withdrawals today, but aren't a full solvency proof. See <a href="/guide/crypto-casino-proof-of-reserves">how proof of reserves works</a>, the full <a href="/crypto-casinos-with-proof-of-reserves">operator list</a>, and our <a href="/methodology/proof-of-reserves">methodology</a>.</p>`
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, jsonLd: [datasetLd('Crypto Casino On-Chain Reserves', description, url, Date.now(), ['all-chain tracked reserves (USD)', 'reserves by chain', 'reserves by operator'])], breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Data', url }], h1: `Crypto casino reserves report ${YEAR}`, updated: Date.now(), body }),
  }
}

// Net-flow report — external deposits minus withdrawals per operator over 7d. A
// neutral on-chain liquidity signal (not a verdict), shown as data.
function netFlowReportPage(rows: { v: CasinoView; slug: string; net: number; inflow: number; outflow: number }[]): { title: string; description: string; html: string } {
  const path = '/data/crypto-casino-net-flow'
  const url = SITE + path
  const title = `Crypto Casino Net Flow Report ${YEAR} — On-Chain Deposits vs Withdrawals | WCOIN.CASINO`
  const description = `Which crypto casinos are net-receiving vs net-paying-out on-chain in ${YEAR}. 7-day external deposits minus withdrawals per operator — a neutral liquidity signal, verified and wash/treasury-excluded.`
  const body =
    `<p class="sub">Net on-chain flow = external <strong>deposits − withdrawals</strong> over 7 days. Positive means more money flowed in than out; negative means the operator paid out more than it took in. It's a liquidity signal, not a verdict — read it alongside <a href="/proof-of-reserves">reserves</a>.</p>` +
    `<p class="upd">External-facing flow only (internal churn, double-counts and wash/treasury volume excluded). Live data, refreshed ~every 30 min.</p>` +
    `<table><thead><tr><th>Operator</th><th style="text-align:right">Deposits (7d)</th><th style="text-align:right">Withdrawals (7d)</th><th style="text-align:right">Net flow (7d)</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td><a href="/casino/${r.slug}">${esc(r.v.name)}</a></td><td class="n">${fmtUsd(r.inflow)}</td><td class="n">${fmtUsd(r.outflow)}</td><td class="n ${r.net >= 0 ? 'mint' : 'rose'}">${r.net >= 0 ? '+' : '−'}${fmtUsd(Math.abs(r.net))}</td></tr>`).join('') +
    `</tbody></table>` +
    `<p class="prose" style="margin-top:14px">How to read this: sustained net <em>outflow</em> usually means an operator is honouring withdrawals (healthy) — but combined with falling <a href="/data/crypto-casino-reserves">reserves</a> it can signal drain. Sustained net <em>inflow</em> can mean growth or that withdrawals are being throttled. Context matters; see <a href="/guide/how-to-verify-a-crypto-casino">how to verify a casino on-chain</a>.</p>`
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, jsonLd: [datasetLd('Crypto Casino On-Chain Net Flow', description, url, Date.now(), ['7d external deposits (USD)', '7d external withdrawals (USD)', '7d net flow (USD)'])], breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Data', url }], h1: `Crypto casino net flow report ${YEAR}`, updated: Date.now(), body }),
  }
}

// /data hub — indexes the on-chain data stories (hub-spoke for the data cluster).
// Wallet-attribution transparency data page — a differentiated "show your work" story
// no affiliate tracker has: how many casino wallets we attribute, by evidence class,
// and the honesty rules around it. Backed by the live watchlist + open-data repo.
function attributionDataPage(): { title: string; description: string; html: string } {
  const path = '/data/crypto-casino-wallet-attribution'
  const url = SITE + path
  const bySource = db
    .prepare("SELECT COALESCE(source,'curated') src, COUNT(*) wallets, COUNT(DISTINCT label) brands FROM watchlist WHERE active=1 AND category='casino' GROUP BY src ORDER BY wallets DESC")
    .all() as { src: string; wallets: number; brands: number }[]
  const totalWallets = bySource.reduce((s, r) => s + r.wallets, 0)
  const namedBrands = (
    db.prepare("SELECT COUNT(DISTINCT label) n FROM watchlist WHERE active=1 AND category='casino' AND label NOT LIKE 'Casino-pattern%' AND label NOT LIKE '0x%' AND label NOT LIKE 'Service %'").get() as any
  ).n as number
  // map collector source → public evidence class + strength
  const EV: Record<string, { label: string; note: string }> = {
    curated: { label: 'Block-explorer name-tags + confirmed deposits', note: 'Strongest public evidence — the operator tag is visible on the address page itself.' },
    dune: { label: 'Public label sets (Dune institution labels)', note: 'Curated public labels, cross-checked before import.' },
    arkham: { label: 'Entity intelligence (Arkham)', note: 'Discovery leads, corroborated before use.' },
    'btc-cluster': { label: 'Behavioural clustering (common-input-ownership)', note: 'Expanded from a confirmed seed address; heuristic, not proof.' },
  }
  const evFor = (s: string) => EV[s] ?? (s.startsWith('arkham') ? EV.arkham : EV.curated)
  const rows = bySource
    .map((r) => {
      const e = evFor(r.src)
      return `<tr><td>${esc(e.label)}</td><td class="n">${fmtNum(r.wallets)}</td><td class="n">${fmtNum(r.brands)}</td><td style="font-size:12px;color:var(--dim)">${esc(e.note)}</td></tr>`
    })
    .join('')
  const title = `How Crypto Casino Wallets Are Attributed — Evidence & Coverage ${YEAR} | WCOIN.CASINO`
  const description = `The evidence behind every crypto-casino wallet we track: ${fmtNum(totalWallets)} attributed wallets across ${fmtNum(namedBrands)} named operators, broken down by public evidence class. Fully auditable — every address is verifiable on a block explorer.`
  const body =
    `<p class="sub">A trust-data site should show its work. We attribute <strong>${fmtNum(totalWallets)}</strong> casino wallets to <strong>${fmtNum(namedBrands)}</strong> named operators — and here is exactly what evidence stands behind each, by class.</p>` +
    `<p class="upd">Every address is independently verifiable on its chain's block explorer. The full wallet set, evidence types and methodology are published for audit in our <a href="https://github.com/chenny2023/wcoin-casino-data" rel="noopener" target="_blank">open-data repository (GitHub)</a>.</p>` +
    `<table><thead><tr><th>Evidence class</th><th style="text-align:right">Wallets</th><th style="text-align:right">Operators</th><th>What it means</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<h2>Seed vs derived — and what we exclude</h2><div class="prose"><p>Wallets carrying <strong>direct public evidence</strong> (a block-explorer name-tag, a public label set, a confirmed deposit) are <em>seed</em> wallets. Wallets reached by expanding a seed through <a href="/guide/crypto-casino-hot-wallet-vs-cold-wallet">common-input-ownership clustering</a> are <em>derived</em> — they inherit a brand only because the seed evidence is strong. Casino-like wallets we <strong>cannot</strong> tie to a named operator stay <em>unattributed</em> and are excluded from every verified figure — never guessed into a brand. Known non-casino infrastructure (DEX routers, settlement contracts) is explicitly denylisted so a mis-tag can't inflate any operator.</p></div>` +
    `<h2>Why this matters</h2><div class="prose"><p>Most "on-chain casino" numbers are unfalsifiable — you're asked to trust a dashboard. Ours are the opposite: pick any wallet, open it on a block explorer, and check the balance and flow yourself. That verifiability is the entire point, and it's why we publish the <a href="https://github.com/chenny2023/wcoin-casino-data/blob/main/DATA_DICTIONARY.md" rel="noopener" target="_blank">exact rules and thresholds</a> behind every figure. See also <a href="/guide/how-on-chain-casino-tracking-works">how on-chain tracking works</a> and the <a href="/methodology/address-attribution">attribution methodology</a>.</p></div>` +
    `<h2>Explore</h2><div class="chips"><a class="pill" href="/proof-of-reserves">Proof of reserves</a><a class="pill" href="/rankings/trust">Trust ranking</a><a class="pill" href="/guide/why-on-chain-data-beats-complaint-boards">Why on-chain data beats reviews</a><a class="pill" href="/data">All data</a></div>`
  const upd = Date.now()
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, jsonLd: [datasetLd('Crypto Casino Wallet Attribution by Evidence Class', description, url, upd, ['attributed wallets by evidence source', 'named operators covered'])], breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Data', url }], h1: `How crypto casino wallets are attributed`, updated: upd, body }),
  }
}

function dataHubPage(): { title: string; description: string; html: string } {
  const url = SITE + '/data'
  const title = `Crypto Casino On-Chain Data & Reports ${YEAR} | WCOIN.CASINO`
  const description = `Unique on-chain data on the crypto-casino industry: deposit currencies, reserves, and net flow — verified, wash/treasury-excluded. Independent reports you can cite.`
  const body =
    `<p class="sub">Original, verifiable on-chain data on the crypto-casino industry — not affiliate marketing. Every figure is external-facing flow with wash and treasury churn excluded, so it reflects money players actually move.</p>` +
    `<h2>Reports</h2><div class="prose">` +
    `<p><strong><a href="/data/crypto-casino-deposit-currencies">Deposit currency breakdown</a></strong> — where crypto-casino money actually moves across chains. The headline finding: stablecoins (USDT on Tron and Ethereum) dominate deposits and withdrawals, while native Bitcoin is a small share of real deposit flow.</p>` +
    `<p><strong><a href="/data/crypto-casino-reserves">Reserves report</a></strong> — how much operators hold on-chain, aggregated and broken down by chain and by operator. Proof of reserves at an industry level: wallet balances anyone can verify, not self-reported claims.</p>` +
    `<p><strong><a href="/data/crypto-casino-net-flow">Net flow report</a></strong> — external deposits minus withdrawals per operator over 7 days, a neutral liquidity signal that helps spot operators paying out versus taking in.</p>` +
    `<p><strong><a href="/data/crypto-casino-tokens">Casino tokens report</a></strong> — the native tokens crypto casinos issue, by market cap: live price, change and which run buyback-and-burn.</p>` +
    `<p><strong><a href="/data/crypto-casino-wallet-attribution">Wallet attribution</a></strong> — how many casino wallets we attribute and the public evidence behind each, by class. A "show your work" breakdown, fully auditable on-chain and in our open-data repo.</p>` +
    `</div>` +
    `<h2>What makes this data different</h2><div class="prose"><p>Most "crypto casino volume" figures you'll see elsewhere are inflated several times over by internal hot-wallet churn, double-counting (a transfer recorded under both watched sides), and a handful of operators' treasury and market-making movements. We strip all of that out — counting only flow whose counterparty is an external user or exchange — and flag anomalous-volume operators rather than featuring them. The result is a smaller but honest number you can actually cite.</p></div>` +
    `<h2>Rankings & live data</h2><div class="chips"><a class="pill" href="/best-crypto-casinos">Best casinos</a><a class="pill" href="/highest-volume-crypto-casinos">Verified volume</a><a class="pill" href="/crypto-casinos-with-proof-of-reserves">Proof of reserves</a><a class="pill" href="/daily">Daily report</a><a class="pill" href="/methodology/address-attribution">Methodology</a></div>` +
    `<p class="prose" style="margin-top:14px">Want to cite this data? It updates continuously from public on-chain activity; see our <a href="/methodology/proof-of-reserves">methodology</a> for exactly how each figure is produced.</p>`
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Data', url }], h1: `Crypto casino on-chain data & reports`, updated: Date.now(), body }),
  }
}

// Casino-token report — operators that issue their own token (CoinGecko market data).
// Unique market data + high-intent ("crypto casino tokens", "{TOKEN} price").
function casinoTokensPage(rows: { v: CasinoView; slug: string; t: TokenInfo }[]): { title: string; description: string; html: string } {
  const path = '/data/crypto-casino-tokens'
  const url = SITE + path
  const title = `Crypto Casino Tokens ${YEAR} — Prices, Market Caps & Buybacks | WCOIN.CASINO`
  const description = `The native tokens of crypto casinos, ranked by market cap: live price, 24h/7d change, fully-diluted valuation and which run buyback-and-burn. Independent market data, updated continuously.`
  const totalMcap = rows.reduce((s, r) => s + (r.t.marketCap || 0), 0)
  const body =
    `<p class="sub">Many crypto casinos issue their own token — for rewards, rakeback, revenue-share or governance. Here are the ones we track, ranked by market cap (<strong>${fmtUsd(totalMcap)}</strong> combined), with live market data.</p>` +
    `<p class="upd">Market data via CoinGecko, refreshed continuously. A token's market cap is not the casino's reserves or revenue — treat it as a separate, speculative asset.</p>` +
    `<table><thead><tr><th>Token</th><th>Casino</th><th style="text-align:right">Price</th><th style="text-align:right">Market cap</th><th style="text-align:right">24h</th><th style="text-align:right">Buyback</th></tr></thead><tbody>` +
    rows
      .map((r) => {
        const ch = r.t.change24h
        const chCell = ch == null ? '—' : `<span class="${ch >= 0 ? 'mint' : 'rose'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</span>`
        const price = r.t.price >= 1 ? fmtUsd(r.t.price) : `$${r.t.price.toPrecision(2)}`
        return `<tr><td><span class="pill">${esc(r.t.symbol)}</span></td><td><a href="/casino/${r.slug}">${esc(r.v.name)}</a></td><td class="n">${price}</td><td class="n">${fmtUsd(r.t.marketCap)}</td><td class="n">${chCell}</td><td class="n">${r.t.buyback ? '✓' : '—'}</td></tr>`
      })
      .join('') +
    `</tbody></table>` +
    `<p class="prose" style="margin-top:14px">A casino token's value reflects market speculation about that operator — it is <strong>not</strong> proof of solvency or a claim on reserves. For solvency, see the <a href="/data/crypto-casino-reserves">reserves report</a>; "Buyback ✓" marks tokens with a known buyback-and-burn or revenue-share mechanism. Not investment advice.</p>`
  return {
    title,
    description,
    html: layout({ title, description, canonical: url, jsonLd: [datasetLd('Crypto Casino Native Tokens', description, url, Date.now(), ['token price (USD)', 'market cap (USD)', '24h/7d change', 'buyback mechanism'])], breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: 'Data', url }], h1: `Crypto casino tokens ${YEAR}`, updated: Date.now(), body }),
  }
}

// High-intent topic leaderboards — each a distinct angle (verified volume / proof of
// reserves / multi-chain) over the same ≥medium-confidence operator set, so they
// don't duplicate the trust hub. Each ranks by its own metric and shows the column
// that matters for that search intent.
function topicListPage(cfg: {
  path: string
  h1: string
  title: string
  description: string
  intro: string
  metricHead: string
  rows: { v: CasinoView; metric: string }[]
  slugOfView: (v: CasinoView) => string
  note?: string
}): { title: string; description: string; html: string } {
  const url = SITE + cfg.path
  const rowsHtml = cfg.rows
    .map((r, i) => {
      const bt = blendedTrust(r.v)
      return `<tr><td class="n">${i + 1}</td><td><a href="/casino/${cfg.slugOfView(r.v)}">${esc(r.v.name)}</a></td><td class="n">${r.metric}</td><td class="n gold">${bt ? `${bt.score} / 100` : '—'}</td></tr>`
    })
    .join('')
  const body =
    `<p class="sub">${cfg.intro}</p>` +
    `<p class="upd">${cfg.rows.length} operators with ≥medium-confidence data · live on-chain data, refreshed ~every 30 min</p>` +
    `<table><thead><tr><th>#</th><th>Casino</th><th style="text-align:right">${cfg.metricHead}</th><th style="text-align:right">Blended trust</th></tr></thead><tbody>${rowsHtml}</tbody></table>` +
    (cfg.note ? `<p class="prose" style="margin-top:14px">${cfg.note}</p>` : '') +
    `<h2>More rankings</h2><div class="chips"><a class="pill" href="/best-crypto-casinos">Best overall</a><a class="pill" href="/best-usdt-casinos">Best USDT</a><a class="pill" href="/highest-volume-crypto-casinos">Highest volume</a><a class="pill" href="/crypto-casinos-with-proof-of-reserves">Proof of reserves</a><a class="pill" href="/multi-chain-crypto-casinos">Multi-chain</a><a class="pill" href="/data/crypto-casino-deposit-currencies">Currency data</a></div>`
  return {
    title: cfg.title,
    description: cfg.description,
    html: layout({
      title: cfg.title,
      description: cfg.description,
      canonical: url,
      jsonLd: [itemListLd(cfg.rows.map((r) => ({ url: `${SITE}/casino/${cfg.slugOfView(r.v)}`, name: r.v.name })))],
      breadcrumb: [{ name: 'Home', url: SITE + '/' }, { name: cfg.h1, url }],
      h1: cfg.h1,
      updated: Date.now(),
      body,
    }),
  }
}

function bestCasinosHubPage(views: CasinoView[], slugOfView: (v: CasinoView) => string, chains: string[]): { title: string; description: string; html: string } {
  const url = `${SITE}/best-crypto-casinos`
  const top = views
    .filter((v) => dataConfidence(v) !== 'low')
    .sort((a, b) => (blendedTrust(b)?.score ?? 0) - (blendedTrust(a)?.score ?? 0) || (b.onchain?.volume7d ?? 0) - (a.onchain?.volume7d ?? 0))
    .slice(0, 30)
  const title = `Best Crypto Casinos ${YEAR} — Ranked by On-Chain Data & Independent Trust | WCOIN.CASINO`
  const lead = top.slice(0, 5).map((v) => v.name).join(', ')
  const description = `The best crypto casinos in ${YEAR}, ranked by independent trust and verified on-chain data — not affiliate payouts. Top operators: ${lead || '—'}. On-chain volume and reserves shown. Updated continuously.`
  const rows = top
    .map((v, i) => {
      const bt = blendedTrust(v)
      const oc = v.onchain
      // anomalous (wash/treasury-pattern) volume is never shown as a normal figure —
      // same "Under review" treatment as the operator's own profile page.
      return `<tr><td class="n">${i + 1}</td><td><a href="/casino/${slugOfView(v)}">${esc(v.name)}</a></td><td class="n gold">${bt ? `${bt.score} / 100` : '—'}</td><td class="n">${oc ? (oc.volumeSuspect ? '<span style="color:var(--dim)">Under review</span>' : fmtUsd(oc.volume7d)) : '—'}</td><td class="n">${oc ? fmtUsd(oc.reserves) : '—'}</td></tr>`
    })
    .join('')
  const chainChips = chains.map((c) => `<a class="pill" href="/rankings/best-on-${c}">Best on ${esc(chainName(c))}</a>`).join('')
  const body =
    `<p class="sub">The definitive ranking of crypto casinos by what the blockchain actually shows — <strong>independent trust plus verified on-chain volume and reserves</strong>, never affiliate payouts. This is a data ranking, not an endorsement.</p>` +
    `<p class="upd">${top.length} operators · ranked by blended independent trust · live on-chain data, refreshed ~every 30 min</p>` +
    `<table><thead><tr><th>#</th><th>Casino</th><th style="text-align:right">Blended trust</th><th style="text-align:right">7d on-chain vol</th><th style="text-align:right">Reserves</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<h2>Best crypto casinos by blockchain</h2><div class="chips">${chainChips}</div>` +
    `<h2>Best crypto casinos by deposit asset</h2><div class="chips"><a class="pill" href="/best-bitcoin-casinos">Bitcoin</a><a class="pill" href="/best-ethereum-casinos">Ethereum</a><a class="pill" href="/best-tron-casinos">Tron</a><a class="pill" href="/best-solana-casinos">Solana</a><a class="pill" href="/best-polygon-casinos">Polygon</a><a class="pill" href="/best-usdt-casinos">USDT</a><a class="pill" href="/best-usdc-casinos">USDC</a></div>` +
    `<h2>More ways to rank</h2><div class="chips"><a class="pill" href="/rankings/trust">Most trusted</a><a class="pill" href="/highest-volume-crypto-casinos">Highest volume</a><a class="pill" href="/crypto-casinos-with-proof-of-reserves">Proof of reserves</a><a class="pill" href="/multi-chain-crypto-casinos">Multi-chain</a><a class="pill" href="/rankings">All rankings</a></div>` +
    `<p class="prose" style="margin-top:18px">Why trust over volume? On-chain volume is trivially wash-traded, so we lead with an independent <a href="/rankings/trust">trust ranking</a> and verify reserves on-chain (<a href="/proof-of-reserves">proof-of-reserves</a>). See <a href="/methodology/trust">how trust is scored</a> and the daily <a href="/daily">market report</a>.</p>`
  return {
    title,
    description,
    html: layout({
      title,
      description,
      canonical: url,
      jsonLd: [itemListLd(top.map((v) => ({ url: `${SITE}/casino/${slugOfView(v)}`, name: v.name })))],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Best crypto casinos', url },
      ],
      h1: `Best crypto casinos ${YEAR}`,
      updated: Date.now(),
      body,
    }),
  }
}

export async function generateSeoPages(): Promise<void> {
  const views = await buildViews()
  const sorted = views.slice().sort((a, b) => {
    const av = a.onchain?.volume7d ?? 0
    const bv = b.onchain?.volume7d ?? 0
    if (bv !== av) return bv - av
    return (b.tpReviews ?? 0) - (a.tpReviews ?? 0)
  })
  // VERIFIED only on public surfaces: auto-detected 'Casino-pattern 0x…' wallets are
  // never shown as verified casinos (no profile, no ranking) — they get a separate,
  // clearly-labelled Unattributed Casino Flow page instead.
  const ranked = sorted.filter((v) => !v.onchain || v.onchain.attributed)
  const unattributed = sorted.filter((v) => v.onchain && !v.onchain.attributed).map((v) => v.onchain!)

  // stable, collision-free slug map keyed by brandKey (verified brands only)
  const slugByKey = new Map<string, string>()
  const used = new Set<string>()
  let seq = 0
  for (const v of ranked) {
    let s = slugify(v.name) || `casino-${++seq}`
    if (used.has(s)) s = `${s}-${++seq}`
    used.add(s)
    slugByKey.set(v.key, s)
  }
  const slugOfView = (v: CasinoView) => slugByKey.get(v.key) ?? slugify(v.name)
  const slugOfBrand = (b: BrandAgg) => slugByKey.get(brandKey(b.brand)) ?? slugify(b.brand)

  const onchainBrands = ranked.filter((v) => v.onchain).map((v) => v.onchain!) // verified, for metric rankings / chains
  const chainSet = new Set<string>()
  for (const b of onchainBrands) for (const c of b.byChain ?? []) if (c.value > 0) chainSet.add(slugify(c.chain))

  // daily report snapshots (newest first), build prev/next links
  const snaps = (db.prepare('SELECT * FROM daily_market_snapshot ORDER BY snapshot_date DESC LIMIT ?').all(MAX_REPORTS) as any[]).map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json || '{}'),
  }))

  const now = Date.now()
  const written = new Set<string>()
  const yieldLoop = () => new Promise<void>((r) => setImmediate(r))

  // page lifecycle: high-confidence on-chain brand → featured_core; low confidence →
  // limited_public_noindex (generated, accessible, noindex, NOT in sitemap, queued
  // for enrichment); otherwise public_indexable. We never delete a thin page.
  const lifecycleOf = (v: CasinoView): string => {
    const c = dataConfidence(v)
    if (c === 'low') return 'limited_public_noindex'
    if (c === 'high' && v.onchain) return 'featured_core'
    return 'public_indexable'
  }

  // ── Phase 1: BUILD every page off the write path ───────────────────────────
  // Building ~400 HTML pages AND upserting them inside ONE synchronous
  // db.transaction() froze Node's single event loop for the whole run (health
  // checks + the read-worker pool got no loop time → the post-deploy / every-30min
  // hard freeze). We now build into an array, yielding to the loop every chunk, then
  // write in small chunked transactions (below) — the loop stays responsive throughout.
  type Built = { path: string; kind: string; pg: { title: string; description: string; html: string }; lifecycle: string }
  const built: Built[] = []
  const enrich: { brand_key: string; label: string; slug: string; confidence: string; missing: string; now: number }[] = []
  // §3.4 thin-content gate: a page below the unique-text threshold is forced to
  // limited_public_noindex (robots noindex + excluded from sitemap), regardless of
  // its data-confidence lifecycle — a safety net so no thin/sparse page dilutes the
  // site. Threshold is configurable. lifecycle is the auditable indexable flag.
  const SEO_MIN_WORDS = Number(process.env.SEO_MIN_WORDS ?? 250)
  const mainWords = (html: string): number => {
    const m = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)
    return (m ? m[1] : html).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').split(/\s+/).filter(Boolean).length
  }
  const add = (path: string, kind: string, pg: { title: string; description: string; html: string }, lifecycle = 'public_indexable') => {
    let lc = lifecycle
    let html = pg.html
    if (lc !== 'limited_public_noindex' && mainWords(html) < SEO_MIN_WORDS) {
      lc = 'limited_public_noindex'
      html = html.replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex,follow">')
    }
    built.push({ path, kind, pg: html === pg.html ? pg : { ...pg, html }, lifecycle: lc })
    written.add(path)
  }

  // ── high-intent expansion: comparison ("X vs Y") + best-on-chain pages ───────
  // Quality-gated: built only from operators with ≥medium-confidence data, so a new
  // page is never thin. Comparison = every pair among the top-K strongest operators;
  // best-on-chain = a trust-ranked shortlist per network that has ≥3 such operators.
  const cap = ranked.slice(0, MAX_CASINOS)
  const pushMap = (m: Map<string, { slug: string; label: string }[]>, k: string, val: { slug: string; label: string }) => {
    const a = m.get(k)
    if (a) a.push(val)
    else m.set(k, [val])
  }
  const COMPARE_TOP_K = Number(process.env.SEO_COMPARE_TOP_K ?? 22)
  const strong = cap.filter((v) => dataConfidence(v) !== 'low')
  const qScore = (v: CasinoView) => (blendedTrust(v)?.score ?? 0) * 1e12 + (v.onchain?.volume7d ?? 0)
  const topK = strong.slice().sort((a, b) => qScore(b) - qScore(a)).slice(0, COMPARE_TOP_K)
  const comparePairs: { a: CasinoView; b: CasinoView; slugA: string; slugB: string }[] = []
  const comparesByKey = new Map<string, { slug: string; label: string }[]>()
  for (let i = 0; i < topK.length; i++)
    for (let j = i + 1; j < topK.length; j++) {
      const x = topK[i]
      const y = topK[j]
      const [slugA, slugB] = [slugOfView(x), slugOfView(y)].sort() // canonical: one page per pair
      const a = slugOfView(x) === slugA ? x : y
      const b = a === x ? y : x
      comparePairs.push({ a, b, slugA, slugB })
      pushMap(comparesByKey, x.key, { slug: `${slugA}-vs-${slugB}`, label: `vs ${y.name}` })
      pushMap(comparesByKey, y.key, { slug: `${slugA}-vs-${slugB}`, label: `vs ${x.name}` })
    }
  // "{brand} alternatives" — computed up-front so casino profiles can link INTO them
  // (inbound internal links) and the generator can emit the pages from the same map.
  const chainsOf = (v: CasinoView) => new Set((v.onchain?.byChain ?? []).filter((c) => c.value > 0).map((c) => c.chain))
  const altByKey = new Map<string, { target: CasinoView; slug: string; alts: { v: CasinoView; slug: string; shared: string[] }[] }>()
  for (const t of topK) {
    if (!blendedTrust(t)) continue
    const tChains = chainsOf(t)
    if (tChains.size === 0) continue
    const tSlug = slugOfView(t)
    const alts = strong
      .filter((v) => v !== t && blendedTrust(v))
      .map((v) => ({ v, slug: slugOfView(v), shared: [...chainsOf(v)].filter((c) => tChains.has(c)) }))
      .filter((x) => x.shared.length > 0)
      .sort((a, b) => (blendedTrust(b.v)?.score ?? 0) - (blendedTrust(a.v)?.score ?? 0) || (b.v.onchain?.reserves ?? 0) - (a.v.onchain?.reserves ?? 0))
      .slice(0, 8)
    if (alts.length < 4) continue
    altByKey.set(t.key, { target: t, slug: tSlug, alts })
  }
  const chainBestGroups: { chain: string; entries: { v: CasinoView; slug: string }[] }[] = []
  const bestChainsByKey = new Map<string, { slug: string; label: string }[]>()
  for (const cs of chainSet) {
    const entries = strong
      .filter((v) => (v.onchain?.byChain ?? []).some((c) => slugify(c.chain) === cs && c.value > 0))
      .sort((a, b) => (blendedTrust(b)?.score ?? 0) - (blendedTrust(a)?.score ?? 0) || (b.onchain?.volume7d ?? 0) - (a.onchain?.volume7d ?? 0))
      .map((v) => ({ v, slug: slugOfView(v) }))
    if (entries.length >= 3) {
      chainBestGroups.push({ chain: cs, entries })
      for (const e of entries) pushMap(bestChainsByKey, e.v.key, { slug: cs, label: chainName(cs) })
    }
  }

  // ALL verified brands get a profile (10-year build: noindex thin ones, never
  // delete). Low-confidence pages are limited_public_noindex + queued to enrich.
  for (let idx = 0; idx < cap.length; idx++) {
    const v = cap[idx]
    const peers = [cap[idx - 2], cap[idx - 1], cap[idx + 1], cap[idx + 2]].filter(Boolean).map((x) => ({ slug: slugOfView(x), label: x.name }))
    const fallback = cap.filter((x) => x.key !== v.key).slice(0, 4).map((x) => ({ slug: slugOfView(x), label: x.name }))
    const lc = lifecycleOf(v)
    const noindex = lc === 'limited_public_noindex'
    add(`/casino/${slugOfView(v)}`, 'casino', casinoPage(v, slugOfView(v), peers.length ? peers : fallback, noindex, { compares: comparesByKey.get(v.key), bestChains: bestChainsByKey.get(v.key), alternatives: altByKey.has(v.key) ? slugOfView(v) : undefined }), lc)
    if (noindex) {
      const missing = [!v.onchain && 'onchain', !(v.onchain && v.onchain.reserves > 0) && 'reserves', trustSources(v).length < 2 && 'trust-sources']
        .filter(Boolean)
        .join(',')
      enrich.push({ brand_key: v.key, label: v.name, slug: slugOfView(v), confidence: 'low', missing, now })
    }
    if (idx % 15 === 14) await yieldLoop() // hand the loop back every 15 page-builds
  }
  // ── entity review pages — answer-first per operator (is-safe / does-pay / PoR) ──
  // The highest explicit-intent, most AI-citable surface. Built off the matched view's
  // real data; thin operators fall to noindex via the word-count gate + lifecycle.
  const asOf = new Date(now).toISOString().slice(0, 10)
  const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const answerDone = new Set<string>()
  const emitAnswers = (v: CasinoView, slug: string) => {
    if (answerDone.has(slug)) return
    answerDone.add(slug)
    const lc = dataConfidence(v) === 'low' ? 'limited_public_noindex' : 'public_indexable'
    add(`/is-${slug}-safe`, 'casino', entityAnswerPage(v, `is-${slug}-safe`, 'is_safe', asOf, slug), lc)
    add(`/does-${slug}-pay-out`, 'casino', entityAnswerPage(v, `does-${slug}-pay-out`, 'does_pay', asOf, slug), lc)
    add(`/${slug}-proof-of-reserves`, 'casino', entityAnswerPage(v, `${slug}-proof-of-reserves`, 'proof_of_reserves', asOf, slug), lc)
  }
  // curated brands first (hand-picked keyword slugs)
  for (const e of ENTITY_REVIEW) {
    const v = ranked.find((x) => normName(x.name) === normName(e.name) || normName(x.key) === normName(e.name))
    if (v) emitAnswers(v, e.slug)
  }
  // ── expand the answer-page surface to the rest of the data-rich roster ──────────
  // rollout #1 = highest explicit intent + most AI-citable. Every ≥medium-confidence
  // operator gets the same is-safe / does-pay / proof-of-reserves trio off its real
  // on-chain data; thin operators fall to noindex via the word gate, so credibility
  // holds. Keyword-slug routing is handled by the SSR fallback (seo_page lookup), so
  // no per-operator route registration is needed.
  const ANSWER_TOP_N = Number(process.env.SEO_ANSWER_TOP_N ?? 40)
  const answerExtra = strong.slice().sort((a, b) => qScore(b) - qScore(a)).slice(0, ANSWER_TOP_N)
  for (const v of answerExtra) emitAnswers(v, slugOfView(v))
  await yieldLoop()
  // rankings: metric leaderboards + trust board + index
  for (const key of Object.keys(METRICS)) {
    const pg = metricRankingPage(key, onchainBrands, slugOfBrand)
    if (pg) add(`/rankings/${key}`, 'rankings', pg)
  }
  add('/rankings/trust', 'rankings', trustRankingPage(ranked, slugOfView))
  add('/rankings', 'rankings', rankingsIndexPage([...chainSet], unattributed.length > 0))
  add('/best-crypto-casinos', 'rankings', bestCasinosHubPage(ranked, slugOfView, chainBestGroups.map((g) => g.chain)), 'featured_core') // §4.2 flagship hub

  // high-intent topic leaderboards (distinct angles; credible post de-distortion)
  const topicBase = ranked.filter((v) => dataConfidence(v) !== 'low')
  const volTop = topicBase
    .filter((v) => !v.onchain?.volumeSuspect && (v.onchain?.volume7d ?? 0) > 0)
    .sort((a, b) => (b.onchain?.volume7d ?? 0) - (a.onchain?.volume7d ?? 0))
    .slice(0, 30)
  if (volTop.length >= 5)
    add('/highest-volume-crypto-casinos', 'rankings', topicListPage({
      path: '/highest-volume-crypto-casinos', h1: `Highest-volume crypto casinos ${YEAR}`, slugOfView,
      title: `Highest-Volume Crypto Casinos ${YEAR} — Verified On-Chain Deposits | WCOIN.CASINO`,
      description: `Crypto casinos ranked by verified on-chain deposit/withdrawal volume in ${YEAR}. Internal hot-wallet churn, double-counts and wash/treasury flow are excluded, so the figures are real — not the inflated throughput most trackers publish.`,
      intro: `Ranked by <strong>verified external on-chain volume</strong> — real deposits and withdrawals. We strip out internal hot-wallet churn, double-counts and treasury/market-making flow, so this is volume you can actually trust.`,
      metricHead: '7d volume (verified)', rows: volTop.map((v) => ({ v, metric: fmtUsd(v.onchain?.volume7d ?? 0) })),
      note: `Operators with anomalous (wash / treasury) volume are held <em>under review</em> and excluded here. See <a href="/methodology/address-attribution">how volume is measured</a>.`,
    }), 'featured_core')
  const porTop = topicBase
    .filter((v) => (v.onchain?.reserves ?? 0) > 0)
    .sort((a, b) => (b.onchain?.reserves ?? 0) - (a.onchain?.reserves ?? 0))
    .slice(0, 30)
  if (porTop.length >= 5)
    add('/crypto-casinos-with-proof-of-reserves', 'rankings', topicListPage({
      path: '/crypto-casinos-with-proof-of-reserves', h1: `Crypto casinos with proof of reserves ${YEAR}`, slugOfView,
      title: `Crypto Casinos With Proof of Reserves ${YEAR} — On-Chain Reserves Tracked | WCOIN.CASINO`,
      description: `Crypto casinos whose on-chain reserves we map and track, ranked by total all-chain reserves in ${YEAR}. Independently verifiable wallet balances — solvency you can check, not claims.`,
      intro: `Crypto casinos whose reserves we map on-chain, ranked by <strong>total all-chain tracked reserves</strong>. These are wallet balances anyone can verify on the blockchain — solvency evidence, not marketing claims.`,
      metricHead: 'Mapped reserves', rows: porTop.map((v) => ({ v, metric: fmtUsd(v.onchain?.reserves ?? 0) })),
      note: `Reserves are a best-effort estimate from mapped wallets and may be partial by brand. See <a href="/proof-of-reserves">proof-of-reserves</a> and <a href="/methodology/proof-of-reserves">methodology</a>.`,
    }), 'featured_core')
  const mcTop = topicBase
    .filter((v) => (v.onchain?.byChain?.length ?? 0) >= 2)
    .sort((a, b) => (b.onchain?.byChain?.length ?? 0) - (a.onchain?.byChain?.length ?? 0) || (blendedTrust(b)?.score ?? 0) - (blendedTrust(a)?.score ?? 0))
    .slice(0, 30)
  if (mcTop.length >= 5)
    add('/multi-chain-crypto-casinos', 'rankings', topicListPage({
      path: '/multi-chain-crypto-casinos', h1: `Multi-chain crypto casinos ${YEAR}`, slugOfView,
      title: `Multi-Chain Crypto Casinos ${YEAR} — Most Blockchains Supported | WCOIN.CASINO`,
      description: `Crypto casinos settling across the most blockchains in ${YEAR}, by tracked on-chain activity — Bitcoin, Ethereum, Tron, Solana and more. Updated continuously.`,
      intro: `Crypto casinos we observe settling across <strong>the most blockchains</strong> — a signal of operational scale and payment flexibility. Ranked by number of chains with tracked on-chain activity.`,
      metricHead: 'Chains tracked', rows: mcTop.map((v) => ({ v, metric: String(v.onchain?.byChain?.length ?? 0) })),
      note: `Chain count reflects networks where we currently track wallet activity for the operator; coverage expands over time.`,
    }), 'featured_core')

  // ── currency page + data-story + guides (all on the credible external-only,
  // suspect/churn-excluded basis, consistent with the rest of the site) ─────────
  const D7w = Date.now() - 7 * 86_400_000
  const EXT_SEO = externalFlowClause()
  const suspectSeo = new Set<string>()
  for (const b of onchainBrands) if (b.volumeSuspect) { suspectSeo.add(b.brand); for (const m of b.members ?? []) suspectSeo.add(m.label) }
  const labelToView = new Map<string, CasinoView>()
  for (const v of ranked) for (const m of v.onchain?.members ?? []) labelToView.set(m.label, v)
  // Run via the read worker — the NOT EXISTS scan over millions of casino transfers
  // is heavy and better-sqlite3 is synchronous, so on the main thread it blocked the
  // event loop for seconds during each regen (health latency spikes). Off-loop now.
  const tokRows = (await workerAll(
    `SELECT chain, label, token, SUM(usd) v, COUNT(*) n FROM transfers WHERE category='casino' AND ts>=? ${EXT_SEO} GROUP BY chain, label, token`,
    [D7w],
  )) as { chain: string; label: string; token: string; v: number; n: number }[]
  const chainFlow = new Map<string, number>()
  const byTokenView = new Map<string, Map<CasinoView, number>>() // token → (view → 7d external settled)
  const byChainView = new Map<string, Map<CasinoView, number>>() // chain → (view → 7d external settled)
  for (const r of tokRows) {
    if (suspectSeo.has(r.label)) continue
    if (r.n > 0 && r.v / r.n > 50_000) continue // treasury-churn gate (consistent with snapshot)
    chainFlow.set(r.chain, (chainFlow.get(r.chain) ?? 0) + (r.v ?? 0))
    const vv = labelToView.get(r.label)
    if (vv) {
      const cm = byChainView.get(r.chain) ?? new Map<CasinoView, number>()
      cm.set(vv, (cm.get(vv) ?? 0) + (r.v ?? 0))
      byChainView.set(r.chain, cm)
      if (r.token === 'USDT' || r.token === 'USDC') {
        const m = byTokenView.get(r.token) ?? new Map<CasinoView, number>()
        m.set(vv, (m.get(vv) ?? 0) + (r.v ?? 0))
        byTokenView.set(r.token, m)
      }
    }
  }
  const chainFlowRows = [...chainFlow.entries()].map(([chain, v]) => ({ chain, v })).sort((a, b) => b.v - a.v)
  const chainFlowTotal = chainFlowRows.reduce((s, c) => s + c.v, 0)
  if (chainFlowTotal > 0)
    add('/data/crypto-casino-deposit-currencies', 'data', currencyReportPage(chainFlowRows, chainFlowTotal), 'featured_core')
  // reserves report (data story) — all-chain reserves total, by chain, top operators
  const chainResRows = db
    .prepare('SELECT chain, SUM(usd) v, COUNT(DISTINCT key) casinos FROM arkham_chain_reserves GROUP BY chain ORDER BY v DESC')
    .all() as { chain: string; v: number; casinos: number }[]
  const resTotal = chainResRows.reduce((s, c) => s + (c.v ?? 0), 0)
  const resTop = ranked
    .filter((v) => (v.onchain?.reserves ?? 0) > 0)
    .sort((a, b) => (b.onchain?.reserves ?? 0) - (a.onchain?.reserves ?? 0))
    .slice(0, 20)
    .map((v) => ({ v, slug: slugOfView(v) }))
  if (resTotal > 0 && resTop.length >= 3)
    add('/data/crypto-casino-reserves', 'data', reservesReportPage(chainResRows, resTotal, resTop), 'featured_core')
  // net-flow report + /data hub
  const netRows = ranked
    .filter((v) => !v.onchain?.volumeSuspect && ((v.onchain?.inflow7d ?? 0) > 0 || (v.onchain?.outflow7d ?? 0) > 0))
    .map((v) => ({ v, slug: slugOfView(v), inflow: v.onchain?.inflow7d ?? 0, outflow: v.onchain?.outflow7d ?? 0, net: (v.onchain?.inflow7d ?? 0) - (v.onchain?.outflow7d ?? 0) }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 30)
  if (netRows.length >= 5) add('/data/crypto-casino-net-flow', 'data', netFlowReportPage(netRows), 'featured_core')
  // casino-token report — operators with their own token (CoinGecko market data)
  const tokenRows = ranked
    .filter((v) => v.onchain?.token && (v.onchain.token.marketCap || 0) > 0)
    .map((v) => ({ v, slug: slugOfView(v), t: v.onchain!.token as TokenInfo }))
    .sort((a, b) => (b.t.marketCap || 0) - (a.t.marketCap || 0))
    .slice(0, 40)
  if (tokenRows.length >= 5) add('/data/crypto-casino-tokens', 'data', casinoTokensPage(tokenRows), 'featured_core')
  add('/data/crypto-casino-wallet-attribution', 'data', attributionDataPage(), 'featured_core')
  add('/data', 'data', dataHubPage(), 'featured_core')
  // Programmatic currency pages — one "Best {stablecoin} Casinos" per token with ≥5
  // operators (stablecoins are cross-chain, so not covered by the per-chain pages).
  const CURRENCIES: { token: string; slug: string; name: string; blurb: string }[] = [
    { token: 'USDT', slug: 'usdt', name: 'USDT (Tether)', blurb: `USDT (Tether) is the <strong>#1 crypto-casino deposit currency</strong> — most player money moves as USDT on Tron and Ethereum.` },
    { token: 'USDC', slug: 'usdc', name: 'USDC (USD Coin)', blurb: `USDC (USD Coin) is the regulated, fully-reserved dollar stablecoin — a transparent alternative to USDT, used on Ethereum, Base, Solana and beyond.` },
  ]
  for (const cur of CURRENCIES) {
    const top = [...(byTokenView.get(cur.token) ?? new Map<CasinoView, number>()).entries()]
      .filter(([v]) => dataConfidence(v) !== 'low')
      .sort((a, b) => (blendedTrust(b[0])?.score ?? 0) - (blendedTrust(a[0])?.score ?? 0) || b[1] - a[1])
      .slice(0, 30)
    if (top.length < 5) continue
    add(`/best-${cur.slug}-casinos`, 'rankings', topicListPage({
      path: `/best-${cur.slug}-casinos`, h1: `Best ${cur.name} casinos ${YEAR}`, slugOfView,
      title: `Best ${cur.name} Casinos ${YEAR} — Ranked by Trust & On-Chain Data | WCOIN.CASINO`,
      description: `The most trusted crypto casinos accepting ${cur.name} in ${YEAR}, with verified on-chain ${cur.token} settlement. Ranked by independent trust, not volume — updated continuously.`,
      intro: `${cur.blurb} These operators have verified on-chain ${cur.token} settlement, ranked by independent trust (not volume).`,
      metricHead: `7d ${cur.token} settled`, rows: top.map(([v, vol]) => ({ v, metric: fmtUsd(vol) })),
      note: `${cur.token} figures are external-facing flow (deposits/withdrawals) with wash/treasury volume excluded. See the full <a href="/data/crypto-casino-deposit-currencies">currency breakdown</a>.`,
    }), 'featured_core')
  }
  // Programmatic chain/asset pages — the highest-intent "best {asset} casinos" terms
  // (bitcoin, ethereum, tron, solana). Deposit/consumer-framed and ranked by 7d
  // settlement ON THAT NETWORK; deliberately distinct from the network-activity
  // /rankings/best-on-{chain} pages (different angle + copy), and they cross-link.
  // Only emitted when ≥5 ≥medium-confidence operators actually settle on the chain.
  const CHAIN_ASSETS: { chain: string; cslug: string; slug: string; name: string; blurb: string }[] = [
    { chain: 'BTC', cslug: 'btc', slug: 'bitcoin', name: 'Bitcoin', blurb: `Bitcoin (BTC) is the original crypto-casino deposit asset — no account, no bank, just an on-chain transfer. These operators have <strong>verified Bitcoin settlement</strong> we can read on-chain.` },
    { chain: 'ETH', cslug: 'eth', slug: 'ethereum', name: 'Ethereum', blurb: `Ethereum (ETH) settles the largest share of crypto-casino deposit flow we track — native ETH plus ERC-20 stablecoins (USDT/USDC). These operators have <strong>verified on-chain Ethereum settlement</strong>.` },
    { chain: 'TRON', cslug: 'tron', slug: 'tron', name: 'Tron', blurb: `Tron is the low-fee rail behind most stablecoin casino deposits — USDT-TRC20 confirms in seconds for cents. These operators have <strong>verified on-chain Tron settlement</strong>.` },
    { chain: 'SOL', cslug: 'sol', slug: 'solana', name: 'Solana', blurb: `Solana (SOL) offers near-instant, sub-cent settlement that a growing set of crypto casinos support. These operators have <strong>verified on-chain Solana settlement</strong>.` },
    { chain: 'POLYGON', cslug: 'polygon', slug: 'polygon', name: 'Polygon', blurb: `Polygon is a low-fee Ethereum scaling network where casinos settle USDC/USDT and POL for a fraction of mainnet gas. These operators have <strong>verified on-chain Polygon settlement</strong>.` },
    { chain: 'BSC', cslug: 'bsc', slug: 'bnb', name: 'BNB Chain', blurb: `BNB Chain (BSC) offers ~3-second blocks and cent-level fees — a common low-cost rail for BEP-20 stablecoin casino deposits. These operators have <strong>verified on-chain BNB Chain settlement</strong>.` },
    { chain: 'BASE', cslug: 'base', slug: 'base', name: 'Base', blurb: `Base is Coinbase's Ethereum L2 — cheap, fast and USDC-native, a fast-growing venue for low-fee stablecoin casino play. These operators have <strong>verified on-chain Base settlement</strong>.` },
    { chain: 'ARB', cslug: 'arb', slug: 'arbitrum', name: 'Arbitrum', blurb: `Arbitrum is an Ethereum L2 with deep USDC/USDT liquidity at low fees, used by casinos that want Ethereum-ecosystem assets without mainnet gas. These operators have <strong>verified on-chain Arbitrum settlement</strong>.` },
    { chain: 'AVAX', cslug: 'avax', slug: 'avalanche', name: 'Avalanche', blurb: `Avalanche offers sub-second finality and low fees with USDT/USDC support. These operators have <strong>verified on-chain Avalanche settlement</strong>.` },
  ]
  for (const ca of CHAIN_ASSETS) {
    const top = [...(byChainView.get(ca.chain) ?? new Map<CasinoView, number>()).entries()]
      .filter(([v]) => dataConfidence(v) !== 'low')
      .sort((a, b) => (blendedTrust(b[0])?.score ?? 0) - (blendedTrust(a[0])?.score ?? 0) || b[1] - a[1])
      .slice(0, 30)
    if (top.length < 5) continue
    add(`/best-${ca.slug}-casinos`, 'rankings', topicListPage({
      path: `/best-${ca.slug}-casinos`, h1: `Best ${ca.name} casinos ${YEAR}`, slugOfView,
      title: `Best ${ca.name} Casinos ${YEAR} — Ranked by Trust & On-Chain Data | WCOIN.CASINO`,
      description: `The most trusted crypto casinos that accept ${ca.name} in ${YEAR}, with settlement we verify on-chain. Ranked by independent trust, not volume — updated continuously.`,
      intro: `${ca.blurb} Ranked by independent trust (not deposit volume), so the order reflects solvency and reputation rather than how much money churns through.`,
      metricHead: `7d settled on ${ca.name}`, rows: top.map(([v, vol]) => ({ v, metric: fmtUsd(vol) })),
      note: `Figures are external-facing flow on ${ca.name} (real deposits/withdrawals, wash/treasury excluded). For network-level activity see the <a href="/rankings/best-on-${ca.cslug}">best-on-${ca.name} ranking</a> and the <a href="/chains/${ca.cslug}">${ca.name} activity page</a>.`,
    }), 'featured_core')
  }
  add('/guide/crypto-casino-proof-of-reserves', 'guide', guidePage({
    path: '/guide/crypto-casino-proof-of-reserves', h1: 'Crypto casino proof of reserves, explained',
    title: `Crypto Casino Proof of Reserves Explained (${YEAR}) | WCOIN.CASINO`,
    description: `What proof of reserves means for a crypto casino, why it matters for solvency, how on-chain reserves are measured and verified, and the limits of the approach.`,
    intro: `"Proof of reserves" is the closest thing a crypto casino has to a public balance sheet — on-chain wallet balances anyone can verify. This guide explains what it actually proves, what it doesn't, the critical difference between proof of reserves and proof of custody, and how to read a reserve figure without fooling yourself.`,
    sections: [
      { h: 'What is proof of reserves?', body: `<p>Proof of reserves (PoR) means showing, on-chain, that an operator holds enough crypto to cover what it owes players. Because public blockchains let anyone read the balance of any address, once a casino's hot and cold wallets are identified, their total balance is independently verifiable — no need to trust the operator's word, a press release, or a screenshot. It is the single most objective solvency signal available for an industry that is otherwise opaque and largely unregulated.</p><p>The idea was popularised by crypto exchanges after several high-profile collapses, where customers discovered too late that the funds they thought were custodied simply weren't there. The same failure mode applies to a casino: your deposit sits in the operator's wallet until you withdraw, and nothing on the website tells you whether that wallet is actually funded.</p>` },
      { h: 'Proof of reserves vs proof of custody', body: `<p>This distinction is the one most players miss, and it matters. <strong>Proof of reserves</strong> shows that assets <em>exist</em> at a set of addresses. <strong>Proof of custody</strong> would additionally show that the operator <em>exclusively controls</em> those assets and that they are not double-counted, borrowed for the snapshot, or pledged elsewhere. On-chain balances alone cannot prove custody: a wallet can be funded with borrowed crypto minutes before a snapshot and emptied afterwards.</p><p>So a reserve figure answers "do the funds exist right now?" — not "are they really the operator's, free and clear, and enough to cover everyone?" That gap is why we never present reserves as a clean bill of health, and why a single snapshot should never be the only thing you look at.</p>` },
      { h: 'Why it matters for players', body: `<p>Crypto casinos are unregulated in most markets, so there is no deposit insurance, no ombudsman, and no auditor of last resort. The dominant risk to a player is not a rigged game — provably-fair systems are common — it is the operator becoming insolvent, throttling withdrawals, or exit-scamming. Visible, stable on-chain reserves that comfortably exceed near-term withdrawal demand are the strongest available signal that withdrawals can be honoured today. Thin reserves, or reserves that only appear around withdrawal times, are the opposite.</p>` },
      { h: 'How reserves are measured here', body: `<p>We map wallets to operators from public block-explorer name-tags and on-chain behaviour (a confirmed deposit address is expanded to a wallet cluster using the standard common-input-ownership heuristic), then read their balances of stablecoins and major assets across every chain we track and price them in USD. Crucially, we publish a <strong>coverage level</strong> — how complete our wallet mapping is for that brand — instead of a single "fully reserved" claim, and we never present an operator's self-reported figure as verified. Reserves are an all-chain, best-effort estimate and are partial by brand. The full process is documented in our <a href="/methodology/proof-of-reserves">proof-of-reserves methodology</a>.</p>` },
      { h: 'How to read a reserve figure', body: `<p>Don't read the dollar amount in isolation — read it three ways. <strong>Relative to flow:</strong> reserves should comfortably exceed recent withdrawal volume, not just be "a big number". <strong>Over time:</strong> a stable or rising reserve trend is reassuring; a balance that spikes right before known payout periods and drains afterwards is a classic dress-up pattern. <strong>Against coverage:</strong> a large figure at "low coverage" means we've mapped only part of the operator's wallets, so treat it as a floor, not a total. We pair every reserve figure with net flow and a trend precisely so it can't be read naively.</p>` },
      { h: 'The limits — what PoR cannot tell you', body: `<p>PoR proves assets, not liabilities: it cannot show how much an operator <em>owes</em> players, only what it holds. It is a point-in-time read on a moving target — balances change every block. It also can't see off-chain assets (fiat banking, custodial holdings) or off-chain debts. None of this makes it useless; it makes it one input. That is why we combine reserves with <a href="/data/crypto-casino-net-flow">net flow</a>, independent <a href="/rankings/trust">trust ratings</a>, complaint trends and continuous monitoring rather than treating any single snapshot as proof of solvency.</p>` },
    ],
    faqs: [
      { q: 'Does proof of reserves guarantee a casino is solvent?', a: 'No. It shows assets held on-chain at a moment in time, not total liabilities to players, and balances can be moved. It is a strong positive signal, not a guarantee — combine it with net-flow trends, trust ratings and complaint history.' },
      { q: 'What is the difference between proof of reserves and proof of custody?', a: 'Proof of reserves shows assets exist at known addresses. Proof of custody would additionally prove the operator exclusively controls them and that they are not borrowed or double-counted. On-chain balances prove the former, not the latter — a wallet can be funded temporarily to look healthy.' },
      { q: 'Can I verify a casino\'s reserves myself?', a: 'Yes — that is the point. Once the operator\'s wallets are known, you can open them on a block explorer (Etherscan, Tronscan, etc.) and read the balances directly. We surface the mapped wallets and figures to make that fast.' },
      { q: 'What is a healthy reserve level for a crypto casino?', a: 'There is no fixed number, but reserves should comfortably exceed near-term withdrawal demand and stay stable or grow over time — not spike only around withdrawals. Always compare reserves to net flow rather than viewing the dollar figure alone.' },
      { q: 'Why do the reserves shown have a "coverage" level?', a: 'Because wallet attribution is never guaranteed complete. Coverage tells you how much of an operator\'s on-chain footprint we have mapped. A figure at low coverage is a floor, not a total — we show it as a level rather than a percentage to avoid implying false precision.' },
    ],
    related: `See casinos ranked by mapped reserves on <a href="/crypto-casinos-with-proof-of-reserves">our proof-of-reserves list</a>, the <a href="/proof-of-reserves">reserves hub</a>, the <a href="/methodology/proof-of-reserves">measurement methodology</a>, or learn to check it yourself in <a href="/guide/how-to-verify-a-crypto-casino">how to verify a crypto casino on-chain</a>.`,
  }), 'featured_core')
  add('/guide/usdt-vs-bitcoin-casino-deposits', 'guide', guidePage({
    path: '/guide/usdt-vs-bitcoin-casino-deposits', h1: 'USDT vs Bitcoin for crypto casino deposits',
    title: `USDT vs Bitcoin for Crypto Casino Deposits (${YEAR}) — On-Chain Data | WCOIN.CASINO`,
    description: `USDT (Tether) vs Bitcoin for crypto-casino deposits: fees, speed, volatility and what the on-chain data shows about which players actually use. USDT-TRC20 dominates — here's why.`,
    intro: `Should you deposit to a crypto casino in USDT or Bitcoin? Our on-chain data answers it clearly — and it's not close.`,
    sections: [
      { h: 'What the data shows', body: `<p>Across the operators we track, the overwhelming majority of external deposit and withdrawal flow is <strong>stablecoins — USDT, settled mostly on Tron and Ethereum</strong>. Native Bitcoin is a small single-digit share of actual deposit flow. See the live <a href="/data/crypto-casino-deposit-currencies">currency breakdown</a>.</p>` },
      { h: 'Why USDT-TRC20 dominates', body: `<p>USDT on Tron (TRC20) is fast (seconds), cheap (cents or free), and dollar-stable — so the amount you deposit is the amount you can wager, with no price swing between deposit and play. For high-frequency casino play that combination is hard to beat, which is why it has become the default rail.</p>` },
      { h: 'Where Bitcoin still fits', body: `<p>Bitcoin makes sense if you already hold BTC and don't want to convert, value its censorship-resistance, or are making large, infrequent transfers where the on-chain fee is negligible relative to size. The trade-offs are slower confirmations and price volatility between deposit and withdrawal.</p>` },
      { h: 'The volatility difference, made concrete', body: `<p>This is the deciding factor for most players. Deposit $1,000 of USDT and you have $1,000 to wager, win or lose, with the casino — the dollar value can't drift. Deposit $1,000 of Bitcoin and your <em>gambling</em> outcome now rides on top of BTC's price: a 5% BTC drop while you play quietly erases $50 of your balance before a single bet settles, and a rise can pad it. That's a second bet you didn't choose to make. Unless you specifically <em>want</em> price exposure on your bankroll, the stablecoin removes a variable, which is exactly why the on-chain data skews so heavily toward it.</p>` },
      { h: 'Privacy, custody and counterparty trade-offs', body: `<p>Bitcoin isn't only slower — it differs in trust model. BTC carries <strong>no issuer</strong>: nobody can freeze it or fail to back it, which appeals to players who distrust centralized stablecoin issuers. USDT carries <strong>issuer risk</strong> (you trust Tether's reserves) but removes price risk. On privacy, both are pseudonymous and traceable on-chain; neither is anonymous. Practically: choose Bitcoin if censorship-resistance and no-issuer matter most to you and you accept volatility; choose USDT if dollar-stability and low fees matter most — which, for routine casino play, is the more common priority.</p>` },
      { h: 'Practical tips', body: `<p>Match the network to the asset: USDT-TRC20 for low-fee stablecoin play, USDT-ERC20 only if the casino lacks Tron support (higher fees). Always send on the exact network the casino specifies — sending USDT-ERC20 to a TRC20 address (or vice versa) can lose funds. 18+ only; gamble responsibly — see <a href="/responsible-gambling">responsible gambling</a>.</p>` },
    ],
    faqs: [
      { q: 'Is USDT or Bitcoin better for casino deposits?', a: 'For most players, USDT (especially TRC20) — it is faster, cheaper and dollar-stable, which is why on-chain data shows it dominates casino deposit flow. Bitcoin suits those who already hold BTC or make large, infrequent transfers.' },
      { q: 'Which USDT network is cheapest for casinos?', a: 'USDT-TRC20 (on Tron) has the lowest fees and fastest confirmations and is the most widely supported casino deposit option. USDT-ERC20 (Ethereum) works but costs more in gas.' },
      { q: 'Does Bitcoin\'s price affect my casino balance?', a: 'Yes — if you deposit BTC, your balance\'s dollar value moves with Bitcoin\'s price while you play, adding a market bet on top of your gambling. A stablecoin like USDT removes that: the amount you deposit is the amount you can wager, unchanged by the market.' },
      { q: 'Why do most players use USDT over Bitcoin at casinos?', a: 'Dollar-stability and low TRC20 fees. The amount deposited stays the amount wagerable, and Tron transfers are fast and nearly free, so the on-chain data shows stablecoins dominate deposit flow while native Bitcoin is a small single-digit share.' },
    ],
    related: `Browse the <a href="/best-usdt-casinos">best USDT casinos</a>, read <a href="/guide/best-crypto-for-casino-deposits">best crypto for deposits</a> and <a href="/guide/stablecoin-casinos-explained">stablecoin casinos explained</a>, or see the full <a href="/data/crypto-casino-deposit-currencies">on-chain currency breakdown</a>.`,
  }), 'featured_core')
  add('/guide/are-crypto-casinos-safe', 'guide', guidePage({
    path: '/guide/are-crypto-casinos-safe', h1: 'Are crypto casinos safe?',
    title: `Are Crypto Casinos Safe? How to Judge One With On-Chain Data (${YEAR}) | WCOIN.CASINO`,
    description: `Are crypto casinos safe? The honest answer and a practical framework: what actually puts your funds at risk, and the on-chain + third-party signals that separate solid operators from risky ones.`,
    intro: `"Are crypto casinos safe?" has no single answer — safety is per-operator, and you can measure it instead of guessing. This guide lays out what actually puts your funds at risk, what licensing does and doesn't protect, why "provably fair" is not the same as solvent, and a concrete pre-deposit checklist built on signals you can verify yourself.`,
    sections: [
      { h: 'The real risks (and the ones people worry about for nothing)', body: `<p>Most crypto casinos are unlicensed or licensed in light-touch jurisdictions, so there is rarely a regulator who will recover funds for you. The dominant risk is not a rigged game — provably-fair systems are common and mathematically checkable — it is <strong>operator solvency and conduct</strong>: an exit scam, quiet insolvency, or withdrawals that get frozen, throttled, or buried under impossible verification demands. Players tend to over-worry about game fairness and under-worry about whether the operator can actually pay them. Your due diligence should focus on the second.</p>` },
      { h: 'What a licence does and does not mean', body: `<p>A Curaçao or Anjouan licence is cheap to obtain and offers players little practical recourse — it is closer to a business registration than to the consumer protection of a UK or Malta licence. A licence is not nothing (it implies some KYC/AML process and a revocable permit) but treat it as a weak signal, not a guarantee. Do not let a licence badge substitute for checking whether the operator holds funds and pays out. The strongest protections in this space are not regulatory; they are <strong>transparency and verifiable on-chain behaviour</strong>.</p>` },
      { h: 'Provably fair ≠ solvent', body: `<p>Provably-fair cryptography lets you verify that a specific bet outcome was not tampered with. That is genuinely useful, but it says nothing about whether the casino can fund your withdrawal. An operator can run perfectly fair games and still go insolvent or refuse to pay. Fairness and solvency are independent axes — see <a href="/guide/provably-fair-explained">provably fair explained</a> for the cryptography, and keep it mentally separate from the money question.</p>` },
      { h: 'Signals that an operator is safer', body: `<p>Healthy, verifiable <a href="/proof-of-reserves">on-chain reserves</a> that comfortably cover recent withdrawal flow; a long operating history with consistent withdrawal reports; multiple independent trust ratings (casino.guru, Trustpilot, AskGamblers) that broadly <em>agree</em>; balanced two-way on-chain flow (deposits and withdrawals both moving); and the absence of a recent complaint spike. We blend the third-party ratings into one independent <a href="/rankings/trust">trust score</a> so you do not have to weigh them by hand.</p>` },
      { h: 'Red flags', body: `<p>Reserves that cannot be verified or that spike only around withdrawal periods; on-chain volume wildly out of line with the operator's reputation (a wash/treasury pattern we hold <em>under review</em> rather than featuring); a sudden flood of withdrawal complaints; deposits with almost no corresponding outflow (players may not be getting paid); and bonus terms with wagering requirements so high that funds are effectively locked. No single flag is conclusive — risk lives in <strong>clusters</strong>. One stale complaint is noise; falling reserves plus one-way outflow plus a complaint wave is a pattern.</p>` },
      { h: 'A pre-deposit checklist', body: `<p>Before funding any account: (1) check the operator has mapped, stable <a href="/crypto-casinos-with-proof-of-reserves">on-chain reserves</a>; (2) confirm two or more independent review sources broadly agree; (3) scan recent complaints for an <em>unresolved withdrawal</em> theme specifically; (4) read the bonus/wagering terms before opting in; (5) start with a small test deposit and a test withdrawal before committing real size. None of this is exotic — it is the same five minutes that separates most avoidable losses from avoided ones.</p>` },
      { h: 'How to use WCOIN', body: `<p>We deliberately do not label any operator "safe" or "scam" — that is not something data can certify, and a false certification would be worse than none. Instead we surface verifiable signals and let you judge: <a href="/rankings/trust">trust rankings</a>, <a href="/crypto-casinos-with-proof-of-reserves">proof-of-reserves</a>, per-operator <a href="/guide/how-to-verify-a-crypto-casino">on-chain verification</a>, and a neutral, sourced <a href="/risk">risk registry</a>. Read them together and decide for yourself. 18+ only; <a href="/responsible-gambling">gamble responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Are crypto casinos safe to use?', a: 'It depends entirely on the operator. The biggest risk is solvency and conduct (exit scams, frozen withdrawals), not game fairness. Favour operators with verifiable on-chain reserves, long track records and consistent independent ratings, and always run a small test withdrawal first.' },
      { q: 'How can I check if a crypto casino is legit?', a: 'Verify its on-chain reserves on a block explorer, check that multiple independent review sources agree, scan recent complaints for unresolved-withdrawal themes, and watch for anomalous volume. We aggregate these signals so you can assess at a glance.' },
      { q: 'Does a Curaçao or Anjouan licence make a casino safe?', a: 'Only weakly. These licences are cheap and offer players little practical recourse compared with UK or Malta regulation. Treat a licence as a minor positive, not a guarantee — verifiable on-chain reserves and a payout track record matter far more.' },
      { q: 'Is a provably-fair casino automatically safe?', a: 'No. Provably-fair proves individual game outcomes were not tampered with; it says nothing about whether the operator can fund your withdrawal. Fairness and solvency are separate — a fair casino can still become insolvent or refuse to pay.' },
      { q: 'What is the single best check before depositing?', a: 'Run a small test deposit and an immediate test withdrawal. Combined with verifying the operator holds stable on-chain reserves, it catches most payout problems before you commit real money.' },
    ],
    related: `See the <a href="/rankings/trust">most-trusted ranking</a>, <a href="/crypto-casinos-with-proof-of-reserves">casinos with proof of reserves</a>, the <a href="/risk">risk registry</a>, and <a href="/guide/crypto-casino-withdrawal-times">crypto casino withdrawal times</a>.`,
  }), 'featured_core')
  add('/guide/how-to-verify-a-crypto-casino', 'guide', guidePage({
    path: '/guide/how-to-verify-a-crypto-casino', h1: 'How to verify a crypto casino on-chain',
    title: `How to Verify a Crypto Casino On-Chain (${YEAR}) — Step by Step | WCOIN.CASINO`,
    description: `A step-by-step guide to checking a crypto casino yourself using public blockchain data: finding its wallets, reading reserves, sanity-checking volume, and spotting wash/treasury churn.`,
    intro: `You don't have to take a casino's word for anything — the blockchain is public. This is the exact process we use to verify an operator: finding its wallets, reading reserves on the right explorer for each chain, telling real player flow from treasury churn, and the mistakes that lead people to wrong conclusions.`,
    sections: [
      { h: 'Step 1 — find the wallets', body: `<p>Identify the operator's hot/deposit wallets from public block-explorer name-tags (Etherscan's "Public Name Tag", Tronscan labels) and from on-chain behaviour — the addresses a casino's cashier sends to and receives from. A single confirmed deposit address can be expanded to a wallet <em>cluster</em> using common-input-ownership: addresses that are repeatedly co-spent in the same transaction are almost always controlled by the same entity. We publish the wallets we map per operator so you can start from a known-good address rather than guessing.</p>` },
      { h: 'Step 2 — pick the right explorer for the chain', body: `<p>Each chain has its own explorer: <strong>Ethereum</strong> → Etherscan; <strong>Tron</strong> (where most USDT casino flow settles) → Tronscan; <strong>BSC</strong> → BscScan; <strong>Polygon</strong> → Polygonscan; <strong>Bitcoin</strong> → mempool.space or Blockstream; <strong>Solana</strong> → Solscan. Casino reserves are almost always multi-chain, so checking only one network undercounts. Paste the wallet address into the explorer's search and open the "Token holdings" / balance view.</p>` },
      { h: 'Step 3 — read the reserves', body: `<p>On each explorer, read the wallet's balance of stablecoins (USDT, USDC) and major assets, and sum them across all the operator's mapped wallets and chains — that total is the tracked <a href="/proof-of-reserves">reserves</a>. Two reads matter more than the headline number: the <strong>trend</strong> (is the balance stable/growing, or does it only appear around payout times?) and the size <strong>relative to withdrawal flow</strong>. A big balance that drains right after a withdrawal window is a dress-up pattern, not solvency.</p>` },
      { h: 'Step 4 — sanity-check the volume', body: `<p>Look at deposit/withdrawal <em>flow</em>, not gross "volume". Genuine player flow is many small transfers — on the order of a couple of thousand dollars on average. A high average transfer size, or two addresses shuffling near-identical amounts back and forth, signals treasury rebalancing or market-making churn, not players. We strip that churn (and internal hot-wallet movement and double-counts) out of our figures; most trackers don't, which is why their headline volumes look inflated by an order of magnitude. If a casino's "volume" dwarfs its reputation, treat it as a wash/treasury signal, not popularity.</p>` },
      { h: 'Step 5 — corroborate, don\'t trust one number', body: `<p>On-chain attribution carries inherent uncertainty — a wallet can be mislabelled, and clustering is heuristic, not proof. So cross-check: do independent ratings (casino.guru, Trustpilot, AskGamblers) broadly agree? Is there a recent <em>unresolved-withdrawal</em> complaint theme? Does the reserve picture match the operator's claims? Corroboration across independent sources is the whole point — any single signal, on-chain or off, can mislead. Our <a href="/methodology/address-attribution">attribution methodology</a> documents exactly how each figure is produced and where the uncertainty lives.</p>` },
      { h: 'Common mistakes when verifying', body: `<p>The errors that produce wrong conclusions: checking only one chain (undercounts reserves); reading gross volume as player activity (overcounts by including churn); trusting a name-tag without sanity-checking the behaviour behind it; treating a single snapshot as permanent (balances move every block); and confusing a related-but-distinct product with the main brand (e.g. a ".us" sister site is a different operator). When in doubt, widen the window and look at the trend, not the instant.</p>` },
    ],
    faqs: [
      { q: 'Can I verify a crypto casino myself?', a: 'Yes. Once its wallets are known, you can read balances and flows directly on a public block explorer — Etherscan for Ethereum, Tronscan for Tron, and so on. We surface the mapped wallets and figures to make it fast.' },
      { q: 'Which block explorer should I use for a crypto casino?', a: 'Match the explorer to the chain: Etherscan (Ethereum), Tronscan (Tron — where most USDT casino flow settles), BscScan (BSC), Polygonscan (Polygon), Solscan (Solana), mempool.space (Bitcoin). Reserves are usually multi-chain, so check every chain the operator uses.' },
      { q: 'What is a healthy reserve level for a crypto casino?', a: 'There is no fixed number, but reserves should comfortably exceed near-term withdrawal demand and stay stable or grow over time — not spike only around withdrawals. Compare reserves to net flow rather than viewing them in isolation.' },
      { q: 'Why is a casino\'s on-chain volume so much higher than expected?', a: 'Most trackers report gross volume, which includes internal hot-wallet churn, double-counts and treasury/market-making movement. Real player flow is many small transfers. A high average transfer size signals churn, not players — we exclude it, which is why our volumes are lower and more realistic.' },
      { q: 'How do I know a wallet really belongs to the casino?', a: 'Start from a confirmed deposit address (e.g. a public name-tag or your own deposit), then expand via common-input-ownership and check the behaviour matches a cashier. Attribution is heuristic, so corroborate with independent sources rather than trusting a single label.' },
    ],
    related: `Use our <a href="/crypto-casinos-with-proof-of-reserves">proof-of-reserves list</a>, <a href="/highest-volume-crypto-casinos">verified volume ranking</a>, <a href="/methodology/address-attribution">attribution methodology</a>, and the deeper <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves explainer</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-withdrawal-times', 'guide', guidePage({
    path: '/guide/crypto-casino-withdrawal-times', h1: 'Crypto casino withdrawal times by network',
    title: `Crypto Casino Withdrawal Times by Network (${YEAR}) | WCOIN.CASINO`,
    description: `How long crypto-casino withdrawals actually take by network — USDT-TRC20, USDT-ERC20, Bitcoin, Solana — and the operator-side factors (approval, reserves) that matter more than the chain.`,
    intro: `"How long does a crypto casino withdrawal take?" splits into two parts: the operator's approval time, and the network's confirmation time. This guide breaks down realistic timings per network, the operator-side factors that matter more than the chain, how to tell a benign delay from a solvency warning, and exactly what to do when a withdrawal is stuck.`,
    sections: [
      { h: 'Network confirmation times', body: `<p>Once an operator releases a withdrawal, the chain decides how fast it lands. <strong>USDT-TRC20 (Tron)</strong> and <strong>Solana</strong> confirm in seconds for cents or less. <strong>USDT-ERC20 / Ethereum</strong> is usually under a minute but costs more in gas, and can slow during network congestion. <strong>Bitcoin</strong> is the slowest — one confirmation averages ~10 minutes, and casinos often wait for 1–3 (so 10–30 minutes), more if you underpay the fee. <strong>Polygon / BSC</strong> sit between, a few seconds to a minute. For pure speed, withdraw to TRC20 or Solana.</p>` },
      { h: 'The part that actually varies: operator approval', body: `<p>Confirmation time is consistent and predictable; <em>approval</em> time is where casinos differ wildly. Some auto-approve small withdrawals instantly; others manual-review anything above a threshold, which can take minutes to days. A solvent operator with healthy <a href="/proof-of-reserves">on-chain reserves</a> can pay instantly around the clock; one that's stretched may batch payouts, impose daily limits, or stall withdrawals entirely. When people say a casino is "slow to pay", they almost always mean slow <em>approval</em>, not slow blockchain.</p>` },
      { h: 'KYC and first-withdrawal delays', body: `<p>A first withdrawal, or a large one, often triggers identity verification (KYC). This is normal even at good operators and can add hours to a couple of days. What is <em>not</em> normal: KYC demands that keep escalating after you comply, verification used as a reason to indefinitely withhold a confirmed win, or limits that quietly shrink as your balance grows. Reasonable, one-time KYC is a compliance step; KYC weaponised to delay payout is a conduct red flag.</p>` },
      { h: 'Benign delay vs solvency warning', body: `<p>How to tell them apart: a <strong>benign</strong> delay is one-off, affects you specifically (a flagged transaction, a verification step), and resolves when you engage support. A <strong>solvency</strong> warning is systemic — many users reporting slow or partial payouts at once, payouts that only go out in small batches, withdrawal minimums or "maintenance" appearing suddenly, and on-chain <a href="/data/crypto-casino-net-flow">outflow</a> drying up while deposits continue. One slow withdrawal is noise; a cluster across users plus shrinking on-chain outflow is a pattern.</p>` },
      { h: 'How to read the on-chain signal', body: `<p>You can sanity-check an operator's withdrawal health on-chain without waiting for complaints to pile up: steady outflows to many distinct counterparties suggest withdrawals are genuinely flowing; reserves that only top up right around withdrawal periods, or outflow that thins out while deposits keep coming, are warning signs. We track net flow and reserves continuously, so slow-payout problems tend to show up in the data before they dominate the review sites.</p>` },
      { h: 'What to do if your withdrawal is stuck', body: `<p>Work through the fixable causes first, in order: (1) confirm you withdrew on the <strong>correct network</strong> the casino specified — a TRC20/ERC20 mismatch is the most common self-inflicted failure; (2) check whether the transaction has a hash yet (no hash = the operator hasn't released it, so it's an approval/KYC issue, not a chain issue); (3) if there is a hash, paste it into the right block explorer — if it's confirmed to your address, the funds are yours and any "not received" is a wallet/UI issue on your side; (4) complete any pending verification; (5) contact support <em>with the transaction hash</em>. If the on-chain transfer is confirmed to the right address and still not credited, or if non-payment persists across many users, treat it as a serious red flag — see <a href="/guide/crypto-casino-red-flags">crypto casino red flags</a>.</p>` },
    ],
    faqs: [
      { q: 'What is the fastest crypto casino withdrawal network?', a: 'USDT-TRC20 (Tron) and Solana are fastest — seconds to confirm, near-zero fees. Bitcoin is slowest (~10 minutes per confirmation, often 1–3 required). Operator approval time usually matters more than the chain.' },
      { q: 'Why is my crypto casino withdrawal slow?', a: 'Almost always operator-side: manual review, KYC on a first or large withdrawal, daily limits, or — in the worst case — solvency strain. Network confirmation is fast on most chains. If there is no transaction hash yet, the operator simply hasn\'t released it.' },
      { q: 'How long should a crypto casino withdrawal take?', a: 'At a healthy operator: instant to a few minutes for auto-approved amounts, plus seconds of chain confirmation on TRC20/Solana. A first withdrawal may add hours to a day or two for one-time KYC. Days of unexplained delay, especially across many users, is a warning sign.' },
      { q: 'My withdrawal has no transaction hash — what does that mean?', a: 'It means the casino has not yet broadcast the payout on-chain, so the delay is on the operator side (approval, limits or KYC), not the blockchain. Only once a hash exists is the network involved.' },
      { q: 'Is a slow withdrawal always a scam sign?', a: 'No. One-off delays from KYC or manual review are normal. It becomes a red flag when delays are systemic — many users affected at once, payouts only trickling out, sudden new limits, and on-chain outflow drying up.' },
    ],
    related: `Check operators' on-chain health in the <a href="/crypto-casinos-with-proof-of-reserves">proof-of-reserves list</a>, the <a href="/data/crypto-casino-net-flow">net-flow report</a>, the <a href="/rankings/trust">trust ranking</a>, and the <a href="/guide/crypto-casino-red-flags">red-flags checklist</a>.`,
  }), 'featured_core')
  add('/guide/provably-fair-explained', 'guide', guidePage({
    path: '/guide/provably-fair-explained', h1: 'Provably fair, explained',
    title: `Provably Fair Crypto Casinos Explained (${YEAR}) — How It Works | WCOIN.CASINO`,
    description: `What "provably fair" actually means at a crypto casino, how the cryptographic check works in plain terms, what it does and doesn't protect against, and why it's separate from solvency.`,
    intro: `"Provably fair" is one of the few things at a crypto casino you can verify mathematically. Here's how it works — and what it doesn't cover.`,
    sections: [
      { h: 'How provably fair works', body: `<p>Before a bet, the casino commits to a secret <em>server seed</em> by publishing its hash. You contribute a <em>client seed</em>. The outcome is computed from both seeds, so neither side can change the result after the fact. Afterwards the casino reveals the server seed, and you can hash it to confirm it matches the earlier commitment — proving the game wasn't rigged against you.</p>` },
      { h: 'What it protects against', body: `<p>It protects against the operator manipulating individual game outcomes — the classic "is the dice loaded?" worry. For provably-fair games (dice, crash, plinko and similar), you can independently verify every result. That's a genuine, meaningful guarantee that most traditional online casinos can't offer.</p>` },
      { h: 'Verifying a result, step by step', body: `<p>The check is concrete enough to do by hand. <strong>Before</strong> betting, note the published hash of the server seed (a fingerprint that can't be reversed). <strong>Place</strong> your bet with your client seed and a nonce (a counter). <strong>After</strong>, the casino reveals the actual server seed; you hash that revealed seed yourself and confirm it equals the fingerprint shown earlier — if it matches, the seed existed before your bet and couldn't have been chosen to make you lose. Then you re-run the casino's published formula (server seed + client seed + nonce) and confirm it produces the exact outcome you got. Most provably-fair sites ship a one-click verifier and let you rotate your client seed so you control half the input.</p>` },
      { h: 'Provably fair vs RNG slots', body: `<p>An important boundary: provably fair typically covers a casino's <em>in-house originals</em> (dice, crash, plinko, mines). Third-party studio <strong>slots</strong> (Pragmatic, Hacksaw, etc.) run on the provider's certified RNG, not the casino's seed scheme, so you usually can't run the same seed-hash check on them. That doesn't mean slots are rigged — reputable providers are independently audited (eCOGRA, iTech Labs) — but the trust model is different: provably-fair is "verify it yourself", audited-RNG is "trust an independent lab". Know which one a game uses before assuming you can verify it.</p>` },
      { h: 'What it does NOT protect against', body: `<p>Provably fair says nothing about whether the casino will <strong>pay your winnings</strong>. It doesn't prove solvency, doesn't stop withdrawal freezes, and doesn't apply to third-party slots (which use the provider's RNG, not the casino's). The house edge is still built into the math. So fairness ≠ safety — pair it with <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves</a> and trust signals.</p>` },
    ],
    faqs: [
      { q: 'Does provably fair mean a crypto casino is safe?', a: 'No. It proves individual game outcomes were not manipulated, but says nothing about solvency or whether you can withdraw. Combine it with on-chain reserves and trust ratings to judge safety.' },
      { q: 'Can I verify provably fair results myself?', a: 'Yes — that is the point. After a bet the casino reveals the server seed; you hash it and confirm it matches the commitment published before the bet, then re-run the formula to reproduce your outcome. Most provably-fair casinos provide a one-click verifier tool.' },
      { q: 'Are provably-fair slots a thing?', a: 'Usually not in the same way. Provably fair typically covers a casino\'s in-house originals (dice, crash, plinko). Third-party studio slots run on the provider\'s certified RNG audited by independent labs, so you trust the audit rather than verify a seed hash yourself.' },
    ],
    related: `See why fairness is separate from solvency in <a href="/guide/are-crypto-casinos-safe">are crypto casinos safe?</a>, the maths in <a href="/guide/crypto-casino-rtp-and-house-edge">RTP & house edge</a>, and the <a href="/rankings/trust">trust ranking</a>.`,
  }), 'featured_core')
  add('/guide/what-is-a-crypto-casino', 'guide', guidePage({
    path: '/guide/what-is-a-crypto-casino', h1: 'What is a crypto casino?',
    title: `What Is a Crypto Casino? How They Work (${YEAR}) | WCOIN.CASINO`,
    description: `What a crypto casino is, how it differs from a traditional online casino, how deposits and provably-fair games work, and the on-chain trade-offs — explained simply.`,
    intro: `A crypto casino is an online casino that takes deposits and pays winnings in cryptocurrency rather than fiat. That one change has big consequences — here's how they actually work.`,
    sections: [
      { h: 'How a crypto casino works', body: `<p>You deposit crypto (most often <a href="/best-usdt-casinos">USDT</a>, sometimes Bitcoin or Ethereum) to an address the casino gives you, play games credited in that balance, and withdraw back on-chain. Because settlement is on a public blockchain, deposits and payouts are <strong>independently visible</strong> — the basis for the on-chain transparency this site is built on.</p>` },
      { h: 'How it differs from a traditional online casino', body: `<p>Traditional casinos use banks and card processors, so they're tied to regulated payment rails, KYC and chargebacks. Crypto casinos settle peer-to-blockchain: faster payouts, fewer payment blocks, often lighter KYC — but also <strong>less regulatory protection</strong>. There's usually no deposit insurance and no regulator to recover funds from, which shifts the burden of due diligence onto you.</p>` },
      { h: 'Provably fair', body: `<p>Many crypto casinos offer <a href="/guide/provably-fair-explained">provably-fair</a> games, where a cryptographic commitment lets you verify each outcome wasn't manipulated. That's a genuine advantage over traditional online casinos — though it proves game fairness, not that the operator will pay you.</p>` },
      { h: 'What you can play', body: `<p>The game menu mirrors a regular online casino plus a crypto-native category. <strong>Slots</strong> from major studios; <strong>live dealer</strong> tables (blackjack, roulette, baccarat) streamed in real time; classic <strong>table games</strong>; and the crypto-native <strong>originals</strong> — crash, dice, plinko, mines — which are usually <a href="/guide/provably-fair-explained">provably fair</a>, meaning you can verify each result. Many also run a <strong>sportsbook</strong>. The defining extra over a fiat casino isn't the games themselves but that the money rail and (for originals) the fairness are both on-chain-verifiable.</p>` },
      { h: 'Who runs them and how they make money', body: `<p>A crypto casino is a business like any other: it profits from the <a href="/guide/crypto-casino-rtp-and-house-edge">house edge</a> built into every game, so over time the operator wins and players' balances trend down — the games being fair doesn't change that. Most operators sit behind offshore holding companies with a light-touch licence (commonly Curaçao), and they fund growth heavily through affiliates and streamer promotion. Understanding the model matters because it explains the two things to watch: whether the operator stays solvent enough to pay you, and why so much marketing ("best casino", "biggest bonus") is paid placement rather than independent assessment.</p>` },
      { h: 'The trade-off', body: `<p>The core trade-off is freedom for self-responsibility. You get fast, global, low-friction play; you give up the safety net. That's why verifiable signals — <a href="/proof-of-reserves">on-chain reserves</a>, independent trust ratings, real withdrawal activity — matter so much. 18+ only; <a href="/responsible-gambling">gamble responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is a crypto casino?', a: 'An online casino that accepts deposits and pays winnings in cryptocurrency (commonly USDT) instead of fiat, settling on a public blockchain. This makes deposits and payouts independently verifiable.' },
      { q: 'Are crypto casinos legal?', a: 'It varies by jurisdiction. Most operate under offshore licences (Curaçao, Anjouan) and many restrict certain countries. Legality depends on where you are — check your local rules.' },
      { q: 'How do crypto casinos make money?', a: 'From the house edge built into every game — over time the operator profits and player balances trend down, regardless of whether games are provably fair. Many also rely heavily on affiliate and streamer marketing, which is why a lot of "best casino" content is paid placement.' },
    ],
    related: `Next: <a href="/guide/how-to-choose-a-crypto-casino">how to choose a crypto casino</a>, <a href="/guide/crypto-casino-vs-online-casino">crypto vs traditional online casino</a>, or browse the <a href="/best-crypto-casinos">best crypto casinos</a>.`,
  }), 'featured_core')
  add('/guide/how-to-choose-a-crypto-casino', 'guide', guidePage({
    path: '/guide/how-to-choose-a-crypto-casino', h1: 'How to choose a crypto casino',
    title: `How to Choose a Crypto Casino (${YEAR}) — A Data-Driven Checklist | WCOIN.CASINO`,
    description: `A practical, data-driven checklist for choosing a crypto casino: solvency and reserves, independent trust, withdrawal track record, deposit currency, and bonus fine print.`,
    intro: `Choosing a crypto casino comes down to one question — will it still pay you next month? Here's a checklist that puts solvency and evidence first.`,
    sections: [
      { h: '1. Solvency first', body: `<p>Before anything else, check the operator can cover what it owes. Look for verifiable <a href="/crypto-casinos-with-proof-of-reserves">on-chain reserves</a> that comfortably exceed withdrawal demand and stay stable over time. An operator with thin or opaque reserves is the single biggest risk, regardless of its bonuses.</p>` },
      { h: '2. Independent trust, not affiliate hype', body: `<p>Weigh ratings that aren't paid for — casino.guru, Trustpilot, AskGamblers — and prefer operators where multiple sources agree. We blend these into one <a href="/rankings/trust">independent trust score</a>. Be skeptical of "top casino" lists that are really affiliate placements.</p>` },
      { h: '3. Withdrawal track record', body: `<p>Fast, consistent withdrawals are the truest test. Check <a href="/guide/crypto-casino-withdrawal-times">withdrawal-time</a> reports and on-chain outflow activity — steady payouts to many counterparties are a good sign; stalled outflows or a wave of complaints are not.</p>` },
      { h: '4. Practical fit', body: `<p>Then the practical bits: does it support your preferred deposit currency and network (<a href="/best-usdt-casinos">USDT-TRC20</a> for low fees), are the games provably fair, and read the bonus fine print — high wagering requirements can lock funds. Match the casino to how you actually play. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
      { h: '5. Disqualifying red flags', body: `<p>Some signals should remove an operator from your shortlist regardless of how good the rest looks: <a href="/proof-of-reserves">reserves</a> you can't verify or that spike only around payouts; on-chain volume wildly out of line with reputation (a wash/treasury signal); a fresh cluster of <em>unresolved</em> withdrawal complaints; KYC sprung only at cash-out with escalating demands; and bonus terms engineered so winnings can never be withdrawn. A strong bonus or slick site does not offset these — see the full <a href="/guide/crypto-casino-red-flags">red-flags checklist</a>.</p>` },
      { h: 'Putting the checklist together', body: `<p>Work it top-down, because the order encodes the priority: solvency first (can it pay?), then independent trust (do neutral sources agree?), then payout record (is it paying now?), then practical fit (does it suit how you play?), with red flags as a veto at any stage. An operator only advances if it clears each gate — a great bonus never promotes a casino that fails the solvency check. Then de-risk the execution: stablecoin on a low-fee network, a small test deposit and withdrawal, and withdraw winnings rather than letting a balance sit. The whole process is ten minutes that prevents the large majority of avoidable losses.</p>` },
    ],
    faqs: [
      { q: 'What is the most important thing when choosing a crypto casino?', a: 'Solvency — whether the operator can actually pay withdrawals. Verifiable on-chain reserves and a consistent payout history matter more than bonus size or game selection.' },
      { q: 'How do I avoid crypto casino scams?', a: 'Favour operators with verifiable reserves, agreement across independent rating sources, and a clean recent withdrawal record. Avoid those with anomalous on-chain volume or unverifiable reserves.' },
      { q: 'In what order should I evaluate a crypto casino?', a: 'Top-down by priority: solvency and reserves first, then independent trust ratings, then the withdrawal track record, then practical fit (currency, games, bonus terms) — with red flags as a veto at any stage. A good bonus should never promote a casino that fails the solvency check.' },
    ],
    related: `Use the <a href="/best-crypto-casinos">best crypto casinos</a> ranking, <a href="/crypto-casinos-with-proof-of-reserves">proof-of-reserves list</a>, the <a href="/guide/crypto-casino-red-flags">red-flags checklist</a>, and <a href="/data/crypto-casino-reserves">reserves report</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-bonuses-explained', 'guide', guidePage({
    path: '/guide/crypto-casino-bonuses-explained', h1: 'Crypto casino bonuses & wagering requirements explained',
    title: `Crypto Casino Bonuses & Wagering Requirements Explained (${YEAR}) | WCOIN.CASINO`,
    description: `How crypto casino bonuses really work: deposit matches, rakeback, no-deposit offers — and the wagering requirements, max-bet and game-weighting fine print that decides whether a bonus is worth taking.`,
    intro: `A "200% bonus" can be worth a lot or nothing — the headline number rarely matters; the terms do. Here's how to read a crypto casino bonus before you take it.`,
    sections: [
      { h: 'The main bonus types', body: `<p><strong>Deposit match</strong> (e.g. 100% up to $1,000) adds bonus funds proportional to your deposit. <strong>No-deposit</strong> bonuses give a small amount to try the site. <strong>Rakeback / cashback</strong> returns a % of your wagering or losses — often the most honest value because it has fewer strings. <strong>Reload / VIP</strong> offers reward ongoing play.</p>` },
      { h: 'Wagering requirements — the part that matters', body: `<p>A wagering requirement (e.g. "35×") is how many times you must bet the bonus (sometimes bonus + deposit) before you can withdraw. A $100 bonus at 35× means $3,500 of wagering. The higher the multiple, the less the bonus is really worth — anything above ~40× is steep. Always compute the real wagering before opting in.</p>` },
      { h: 'The fine print that voids bonuses', body: `<p>Watch for <strong>max-bet caps</strong> while wagering (bet over it and the bonus is voided), <strong>game weighting</strong> (slots usually count 100%, table games 10% or less — so "wager $3,500" can mean far more on blackjack), <strong>time limits</strong>, and <strong>max cashout</strong> limits on winnings from no-deposit bonuses.</p>` },
      { h: 'Sticky vs cashable bonuses', body: `<p>One distinction decides whether a bonus can ever become real money. A <strong>cashable (non-sticky)</strong> bonus lets you withdraw the bonus and winnings once wagering is met. A <strong>sticky</strong> bonus is play-only: it funds your bets but the bonus amount itself is removed when you withdraw — you keep only winnings above it, and a sticky bonus often locks your own deposit alongside it until the playthrough clears. A generous-looking sticky bonus with a high requirement can mean your real deposit is frozen for a long stretch of forced wagering. Always check which type you're accepting.</p>` },
      { h: 'How to calculate a bonus\'s real value', body: `<p>Estimate before you opt in, not after. Effective wagering = bonus (or bonus + deposit, check which) × the requirement, adjusted upward for game weighting if you don't play 100%-weighted slots. Then weigh that against the game's house edge: each pass through the wagering loses, on average, roughly the house edge × the amount wagered. A $100 bonus at 40× on a 3%-edge game means ~$4,000 wagered and ~$120 of expected loss <em>just to clear it</em> — so a $100 bonus can have negative expected value before you ever try to withdraw. Low-wagering and rakeback offers usually survive this maths; headline 200% matches with 50×+ usually don't.</p>` },
      { h: 'A simple rule', body: `<p>Prefer low-wagering or rakeback offers from operators that actually pay out — a great bonus from an insolvent casino is worthless. Check the operator's <a href="/proof-of-reserves">reserves</a> and <a href="/guide/crypto-casino-withdrawal-times">withdrawal record</a> first, then weigh the bonus terms. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What does 35x wagering mean at a crypto casino?', a: 'You must wager the bonus 35 times before withdrawing — a $100 bonus at 35× requires $3,500 of bets. Game weighting can make the effective requirement even higher on table games.' },
      { q: 'Are crypto casino bonuses worth it?', a: 'Only if the wagering requirement is reasonable (ideally under ~40×) and the operator reliably pays withdrawals. Low-wagering and rakeback offers usually beat big headline match percentages.' },
      { q: 'What is a sticky bonus?', a: 'A play-only bonus: it funds your bets but is removed when you withdraw, so you keep only winnings above the bonus amount. Sticky bonuses often also lock your own deposit until wagering is met — meaning your real money can be frozen during forced playthrough.' },
      { q: 'How do I know if a bonus is actually worth taking?', a: 'Multiply the bonus by the wagering requirement (and adjust for game weighting) to get effective wagering, then subtract roughly the house edge × that amount as expected loss. If the expected loss to clear it approaches or exceeds the bonus, it has little or negative value. Rakeback and low-wagering offers usually pass; high-multiple match bonuses usually don\'t.' },
    ],
    related: `Check operators first: <a href="/crypto-casinos-with-proof-of-reserves">proof of reserves</a> and <a href="/rankings/trust">trust ranking</a>. Understand the maths in <a href="/guide/crypto-casino-rtp-and-house-edge">RTP & house edge</a>.`,
  }), 'featured_core')
  add('/guide/crypto-gambling-glossary', 'guide', guidePage({
    path: '/guide/crypto-gambling-glossary', h1: 'Crypto gambling glossary',
    title: `Crypto Gambling Glossary (${YEAR}) — Key Terms Explained | WCOIN.CASINO`,
    description: `Plain-English definitions of the crypto-casino terms that matter: proof of reserves, provably fair, hot/cold wallet, RTP, house edge, wagering requirement, rakeback, on-chain volume and more.`,
    intro: `The crypto-casino world mixes gambling and blockchain jargon. Here are the terms that actually matter, in plain English.`,
    sections: [
      { h: 'On-chain & solvency terms', body: `<p><strong>Proof of reserves</strong> — verifiable on-chain wallet balances showing what an operator holds (<a href="/guide/crypto-casino-proof-of-reserves">explainer</a>). <strong>Hot wallet</strong> — the operator's online wallet that processes deposits/withdrawals. <strong>Cold wallet</strong> — offline storage for reserves. <strong>On-chain volume</strong> — value moved through an operator's wallets; only meaningful when internal churn and wash/treasury flow are excluded (which is why most trackers overstate it).</p>` },
      { h: 'Fairness & game terms', body: `<p><strong>Provably fair</strong> — a cryptographic scheme letting you verify a game outcome wasn't manipulated (<a href="/guide/provably-fair-explained">explainer</a>). <strong>RTP (return to player)</strong> — the % of wagers a game pays back over time. <strong>House edge</strong> — the casino's built-in mathematical advantage (100% − RTP). <strong>RNG</strong> — random number generator behind game outcomes.</p>` },
      { h: 'Money & bonus terms', body: `<p><strong>Wagering requirement</strong> — how many times a bonus must be bet before withdrawal (<a href="/guide/crypto-casino-bonuses-explained">explainer</a>). <strong>Rakeback / cashback</strong> — a % of wagers or losses returned. <strong>Sticky bonus</strong> — a play-only bonus removed when you withdraw. <strong>Max cashout</strong> — a cap on winnings withdrawable from a bonus. <strong>Stablecoin</strong> — a dollar-pegged crypto (USDT, USDC) that's the dominant casino deposit currency. <strong>TRC20 / ERC20</strong> — the Tron and Ethereum token standards USDT runs on; TRC20 is cheaper and faster.</p>` },
      { h: 'Network & wallet terms', body: `<p><strong>Block explorer</strong> — a public website (Etherscan, Tronscan, Solscan) for reading any address's balance and transactions. <strong>Confirmation</strong> — a block that includes your transaction; casinos wait for a number of them before crediting. <strong>Gas / network fee</strong> — the cost to send a transaction; tiny on Tron/Solana, variable on Ethereum. <strong>Memo / destination tag</strong> — an identifier some deposits require; omitting it can strand funds. <strong>Wallet cluster</strong> — a group of addresses inferred to share one owner via common-input-ownership, the basis of <a href="/methodology/address-attribution">attribution</a>.</p>` },
      { h: 'Market & risk terms', body: `<p><strong>Net flow</strong> — deposits minus withdrawals over a window; balanced two-way flow is healthier than one-way (<a href="/data/crypto-casino-net-flow">report</a>). <strong>Coverage level</strong> — how complete our wallet mapping is for a brand; a reserve figure at low coverage is a floor, not a total. <strong>Wash trading</strong> — fake volume from addresses cycling funds to inflate activity. <strong>Exit scam</strong> — an operator vanishing with player funds; see neutral <a href="/guide/on-chain-signs-of-a-casino-exit-scam">on-chain distress signals</a>. <strong>KYC</strong> — identity verification, often required before large withdrawals.</p>` },
    ],
    faqs: [
      { q: 'What is the difference between RTP and house edge?', a: 'They are two sides of the same number: RTP (return to player) is the percentage of wagers a game pays back over time; the house edge is the casino\'s advantage, equal to 100% minus the RTP. A 97% RTP game has a 3% house edge.' },
      { q: 'What does TRC20 mean for casino deposits?', a: 'TRC20 is the Tron token standard that USDT (Tether) runs on. USDT-TRC20 is the most popular casino deposit rail because it is fast (seconds) and cheap (cents or free), unlike USDT-ERC20 on Ethereum which costs more in gas.' },
    ],
    related: `Put it to use: <a href="/guide/how-to-choose-a-crypto-casino">how to choose a crypto casino</a>, <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves</a>, and the <a href="/data/crypto-casino-deposit-currencies">on-chain data</a>.`,
  }), 'featured_core')
  add('/guide/are-crypto-casinos-legal', 'guide', guidePage({
    path: '/guide/are-crypto-casinos-legal', h1: 'Are crypto casinos legal?',
    title: `Are Crypto Casinos Legal? Jurisdiction & Licensing Explained (${YEAR}) | WCOIN.CASINO`,
    description: `Whether crypto casinos are legal depends entirely on where you live and how the operator is licensed. A neutral overview of jurisdictions, licensing and what to check — not legal advice.`,
    intro: `"Is it legal?" has no single answer — it depends on your jurisdiction and the operator's licence. Here's a neutral framework for thinking about it. This is general information, not legal advice.`,
    sections: [
      { h: 'It depends on your jurisdiction', body: `<p>Online gambling law is set country by country (and often state by state). Some jurisdictions licence and regulate online casinos, some prohibit them, and many simply don't address crypto specifically — leaving a grey area. The same operator can be perfectly legal for one player and prohibited for another. Always check the rules where <em>you</em> are.</p>` },
      { h: 'How operators are licensed', body: `<p>Most crypto casinos operate under an offshore licence — Curaçao is the most common, with Anjouan and others also seen. These licences impose far lighter requirements than regulators like the UK Gambling Commission or Malta Gaming Authority. A licence is a baseline signal, not a guarantee of player protection, and offshore licences offer limited recourse if a dispute goes wrong.</p>` },
      { h: 'What this means for players', body: `<p>Practically: a licence tells you the operator made some effort to be accountable, but it doesn't replace your own checks. Because crypto settlement is on a public blockchain, on-chain evidence — reserves, net flow, payout behaviour — is often a stronger real-world signal of whether an operator can honour withdrawals than the licence badge alone. That's the gap this site exists to fill.</p>` },
      { h: 'Geo-blocking, VPNs and terms of service', body: `<p>Operators usually geo-block players from countries where they aren't licensed, or where they choose not to operate (often including the operator's own jurisdiction and tightly-regulated markets like the US or UK). Using a VPN to bypass a geo-block may break the casino's terms of service — and that matters practically: operators routinely cite "prohibited jurisdiction" or VPN use as grounds to <strong>void winnings and refuse withdrawals</strong>, even from a balance you built fairly. So circumventing a block isn't just a legal question; it hands the operator a ready excuse not to pay. If you're blocked, that's information worth respecting.</p>` },
      { h: 'Is "crypto" gambling treated differently?', body: `<p>Legally, most jurisdictions regulate the <em>gambling activity</em>, not the payment method — so a crypto casino is generally treated the same as any online casino under local gambling law, regardless of whether you fund it with USDT or a card. What crypto changes is enforceability and reach: borderless settlement makes offshore operators easy to access but hard for any single regulator to police, which is why the practical protection comes from transparency and on-chain verification rather than the licence. A few jurisdictions also have specific rules on crypto itself; when crypto law and gambling law both apply, the stricter one governs.</p>` },
      { h: 'KYC, taxes and access', body: `<p>Many operators restrict players from certain countries and may require identity verification (KYC) before large withdrawals. Gambling winnings can also be taxable depending on where you live — some countries tax winnings, others don't, and reporting obligations vary. None of this is decided by the casino's licence — it's your local law. When in doubt, consult a qualified professional in your country.</p>` },
    ],
    faqs: [
      { q: 'Are crypto casinos legal?', a: 'There is no universal answer — it depends entirely on your jurisdiction. Some countries license online casinos, others prohibit them, and many have no specific crypto rule. Check the gambling law where you live; this page is general information, not legal advice.' },
      { q: 'What licence do most crypto casinos have?', a: 'Most hold an offshore licence, commonly from Curaçao. These are lighter-touch than UK or Malta regulation and offer limited dispute recourse, so treat a licence as one baseline signal rather than a guarantee.' },
      { q: 'Can I use a VPN to access a blocked crypto casino?', a: 'It may breach the casino\'s terms of service, and operators frequently use prohibited-jurisdiction or VPN use as grounds to void winnings and refuse withdrawals. Beyond the legal question in your country, bypassing a geo-block gives the operator a ready excuse not to pay you.' },
      { q: 'Are crypto casinos taxed differently from regular casinos?', a: 'Generally no — most jurisdictions tax the gambling activity, not the payment method, so the same rules apply whether you use crypto or fiat. Whether winnings are taxable depends on your country. Consult a qualified professional for your situation.' },
    ],
    related: `See <a href="/guide/are-crypto-casinos-safe">are crypto casinos safe?</a>, <a href="/guide/crypto-casino-kyc-and-anonymity">KYC & anonymity</a>, <a href="/guide/crypto-casino-red-flags">crypto casino red flags</a>, and how to <a href="/guide/how-to-verify-a-crypto-casino">verify an operator on-chain</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-red-flags', 'guide', guidePage({
    path: '/guide/crypto-casino-red-flags', h1: 'Crypto casino red flags: warning signs to check',
    title: `Crypto Casino Red Flags — Warning Signs Before You Deposit (${YEAR}) | WCOIN.CASINO`,
    description: `The warning signs that a crypto casino may not pay out: thin or falling reserves, one-way net flow, opaque ownership, slow-withdrawal patterns and bonus traps. How to spot them with on-chain data.`,
    intro: `No single signal proves an operator is bad — but a cluster of red flags is a reason to slow down. This checklist covers the warning signs worth checking before you deposit: the on-chain solvency signals, the volume tricks, the bonus and conduct traps, how to weigh flags as clusters rather than singles, and — just as important — what is <em>not</em> actually a red flag so you don't scare yourself off a sound operator.`,
    sections: [
      { h: 'Reserves that don\'t add up', body: `<p>If an operator's mapped on-chain reserves are tiny relative to its deposit volume — or visibly falling while deposits keep arriving — that's a solvency warning. Healthy operators generally hold reserves that comfortably cover near-term withdrawals. The catch: reserves can be moved or topped up temporarily to look healthy for a snapshot, so read the <strong>trend over time</strong>, not one instant. A balance that appears right before known payout windows and drains afterwards is worse than a smaller but stable one. Check it on the <a href="/proof-of-reserves">proof-of-reserves hub</a>.</p>` },
      { h: 'One-way net flow', body: `<p>Sustained, heavy net <em>outflow</em> from an operator's wallets (more leaving than coming in, over weeks) can indicate stress or a wind-down. The inverse is just as telling: deposits arriving with almost no withdrawals going back out can mean players aren't being paid. Balanced, two-way flow — money moving in <em>and</em> out to many counterparties — is the healthier pattern. See live figures in the <a href="/data/crypto-casino-net-flow">net-flow report</a>.</p>` },
      { h: 'Volume that doesn\'t match reputation', body: `<p>A casino whose on-chain "volume" dwarfs its actual brand presence is waving a flag. Inflated headline volume usually comes from wash trading or treasury/market-making churn — two addresses cycling near-identical amounts — not real players. Genuine player flow is many small transfers. We hold operators with anomalous volume <em>under review</em> and exclude that churn from our figures rather than featuring it; a number that looks too big to be real usually is. Learn to separate the two in <a href="/guide/how-to-verify-a-crypto-casino">how to verify a casino on-chain</a>.</p>` },
      { h: 'Bonus and wagering traps', body: `<p>The most common way a casino keeps your money legally is the bonus. Watch for extreme wagering requirements (e.g. 50–60× the bonus <em>plus</em> deposit), max-cashout caps that quietly void big wins, game-weighting that makes the requirement near-impossible, and "sticky" bonuses that lock your own deposit until the playthrough is met. A headline "200% bonus" with terms designed so you can never withdraw is worse than no bonus. Always read the wagering terms before opting in — and prefer low-wagering or rakeback offers from operators that actually pay.</p>` },
      { h: 'Opacity and pressure', body: `<p>Be wary of operators with no identifiable ownership, no licence information, no working support channel, or terms that change without notice. High-pressure tactics — countdown timers on deposits, "VIP manager" pushing you to deposit more, fake urgency — are designed to short-circuit due diligence. Legitimate operators don't need to rush you. A brand-new site with no history and aggressive promotion deserves extra caution: there is no track record to lean on, so weight the verifiable on-chain signals more heavily.</p>` },
      { h: 'Payout and reputation signals', body: `<p>Patterns of delayed or denied withdrawals, voided winnings, or a wave of <em>unresolved</em> complaints across independent review sites are strong negative signals. The word "unresolved" matters — every operator has some complaints; what separates them is whether disputes get resolved. We surface complaint counts and unresolved-dispute flags where third-party data exists. One angry review means little; a consistent, recent pattern across multiple independent sources means a lot.</p>` },
      { h: 'How to weigh flags — clusters, not singles', body: `<p>The single most important rule: risk lives in <strong>clusters</strong>, not individual flags. A Curaçao licence alone, one stale complaint alone, or a single slow withdrawal alone tells you almost nothing. The signal is correlation — falling reserves <em>and</em> one-way outflow <em>and</em> a fresh wave of unresolved withdrawal complaints, arriving together, is a real pattern. Conversely, what is <em>not</em> a red flag: a normal one-time KYC request, a Curaçao licence on an otherwise transparent and well-reserved operator, occasional negative reviews amid mostly resolved ones, or Bitcoin withdrawals simply being slower than TRC20. Don't let a single benign signal scare you off, and don't let a single reassuring one override a cluster of warnings.</p>` },
    ],
    faqs: [
      { q: 'What is the biggest red flag for a crypto casino?', a: 'Solvency signals — thin or falling on-chain reserves relative to deposit volume, and sustained one-way outflow — are the most important, because the core risk is an operator that cannot or will not honour withdrawals. Pair them with unresolved-payout-complaint patterns from independent sources.' },
      { q: 'Can I check these red flags myself?', a: 'Several are on-chain and public: once an operator\'s wallets are known you can read reserves and flow on a block explorer. We map and surface those figures, plus third-party reputation signals, so you can cross-check before depositing.' },
      { q: 'Is a Curaçao licence a red flag?', a: 'Not on its own. Curaçao licences are cheap and offer weak recourse, so they are a weak signal — but a Curaçao-licensed operator that is transparent and well-reserved can be fine, while an unlicensed one with hidden ownership is worse. Weigh it alongside on-chain and reputation signals, not in isolation.' },
      { q: 'What bonus terms are red flags?', a: 'Extreme wagering requirements (50–60×+), max-cashout caps that void large wins, restrictive game weighting, and "sticky" bonuses that lock your own deposit. A big advertised bonus with terms engineered so you can never withdraw is worse than none — read the playthrough terms before opting in.' },
      { q: 'How many red flags before I should avoid a casino?', a: 'There is no magic count — it is about correlation, not quantity. A single benign flag (one-time KYC, a lone old complaint) is noise. Several reinforcing flags arriving together — falling reserves plus one-way outflow plus a fresh complaint wave — is a clear reason to stay away.' },
    ],
    related: `Use the <a href="/proof-of-reserves">proof-of-reserves hub</a>, the <a href="/data/crypto-casino-net-flow">net-flow report</a>, the neutral <a href="/risk">risk registry</a>, and <a href="/guide/how-to-verify-a-crypto-casino">how to verify an operator on-chain</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-vs-online-casino', 'guide', guidePage({
    path: '/guide/crypto-casino-vs-online-casino', h1: 'Crypto casino vs traditional online casino',
    title: `Crypto Casino vs Traditional Online Casino — Key Differences (${YEAR}) | WCOIN.CASINO`,
    description: `How crypto casinos differ from traditional online casinos: deposits, speed, regulation, privacy, transparency and risk. A balanced comparison, with the on-chain angle that's unique to crypto.`,
    intro: `Crypto casinos and traditional online casinos look similar but differ in ways that matter for safety and convenience. Here's a balanced comparison of the trade-offs.`,
    sections: [
      { h: 'Deposits and speed', body: `<p>Traditional casinos use cards, bank transfers and e-wallets, with deposits and especially withdrawals often taking days and subject to bank involvement. Crypto casinos settle on-chain — deposits and payouts can clear in seconds to minutes (USDT-TRC20, Solana) with no bank in the loop. That speed is the headline draw, but it cuts both ways: on-chain transfers are irreversible.</p>` },
      { h: 'Regulation and recourse', body: `<p>Traditional online casinos are usually licensed by national regulators (UK, Malta, etc.) with real dispute mechanisms and player-protection rules. Most crypto casinos run under lighter offshore licences with limited recourse. If protection and a clear complaints process matter most to you, regulated traditional operators have the edge here — see <a href="/guide/are-crypto-casinos-legal">are crypto casinos legal?</a></p>` },
      { h: 'Transparency: the on-chain edge', body: `<p>This is where crypto is genuinely different. Because settlement is on a public blockchain, an operator's reserves and money flow can be independently verified — something impossible with a traditional casino's private banking. You don't have to trust a marketing claim; you can read the chain. That transparency is the entire basis of this site.</p>` },
      { h: 'Privacy and access', body: `<p>Crypto casinos often need only a wallet to start, offering more privacy and broader access, though many still require KYC for larger withdrawals. Traditional casinos require full identity and payment details up front. Neither model removes the underlying risks of gambling — set limits and <a href="/responsible-gambling">play responsibly</a> regardless.</p>` },
      { h: 'Games, providers and bonuses', body: `<p>Game libraries overlap heavily — both run slots and live tables from the same major studios (Pragmatic, Evolution, etc.) — but crypto casinos add a category traditional ones rarely have: in-house <a href="/guide/provably-fair-explained">provably-fair</a> originals like crash, dice and plinko, where you can cryptographically verify each result. On bonuses, crypto operators tend toward aggressive headline matches and rakeback, while regulated casinos face advertising and bonus-fairness rules that cap the worst terms. The flip side: a regulated bonus is more likely to be honoured as written, where an offshore one leans more on you reading the <a href="/guide/crypto-casino-bonuses-explained">wagering fine print</a>.</p>` },
      { h: 'Irreversibility cuts both ways', body: `<p>A traditional card deposit can be charged back if something goes wrong; a bank can intervene. An on-chain transfer cannot be reversed by anyone once confirmed. That removes a payment-fraud vector and speeds payouts, but it also means a mistake — wrong network, wrong address — is permanent, and you have no card issuer to appeal to. The transparency that lets you verify an operator is the same property that gives you no undo button, so the due diligence has to happen <em>before</em> you send.</p>` },
    ],
    faqs: [
      { q: 'Are crypto casinos safer than traditional online casinos?', a: 'Not inherently. Traditional casinos usually have stronger regulation and dispute recourse; crypto casinos offer faster settlement and unique on-chain transparency you can verify yourself. The safest choice depends on which protections you value — and on the specific operator.' },
      { q: 'What is the main advantage of a crypto casino?', a: 'Fast, bank-free on-chain settlement and public verifiability of reserves and flow. The main trade-offs are lighter regulation, limited recourse and the irreversibility of on-chain transactions.' },
      { q: 'Can I reverse a crypto casino deposit like a card payment?', a: 'No. On-chain transactions are irreversible once confirmed — there is no chargeback and no bank to appeal to. This removes payment-fraud risk and speeds payouts, but means a wrong-network or wrong-address mistake is permanent, so verify details before sending.' },
    ],
    related: `See <a href="/guide/what-is-a-crypto-casino">what is a crypto casino?</a>, <a href="/guide/are-crypto-casinos-legal">are they legal?</a>, <a href="/guide/are-crypto-casinos-safe">are they safe?</a>, and the <a href="/best-crypto-casinos">best crypto casinos</a> ranking.`,
  }), 'featured_core')
  add('/guide/best-crypto-for-casino-deposits', 'guide', guidePage({
    path: '/guide/best-crypto-for-casino-deposits', h1: 'Best crypto for casino deposits',
    title: `Best Crypto for Casino Deposits — USDT, BTC, ETH, SOL Compared (${YEAR}) | WCOIN.CASINO`,
    description: `Which cryptocurrency is best for casino deposits? Fees, speed and stability compared across USDT, Bitcoin, Ethereum and Solana — with what the on-chain data actually shows players use.`,
    intro: `The best deposit asset depends on fees, speed and whether you want price stability. Here's how the main options compare — and what our on-chain data shows players actually pick.`,
    sections: [
      { h: 'Stablecoins (USDT, USDC) — the default', body: `<p>For most players a dollar stablecoin is the best deposit asset: the amount you deposit is the amount you can wager, with no price swing between deposit and play. <strong>USDT on Tron (TRC20)</strong> is the most popular by far — seconds to confirm, fees of cents or free — and dominates the deposit flow we track. USDC is the regulated, fully-reserved alternative. Browse the <a href="/best-usdt-casinos">best USDT casinos</a>.</p>` },
      { h: 'Bitcoin (BTC)', body: `<p>Bitcoin suits players who already hold BTC, value censorship-resistance, or make large, infrequent transfers where the on-chain fee is negligible relative to size. Trade-offs: slower confirmations and price volatility between deposit and withdrawal. See the <a href="/best-bitcoin-casinos">best Bitcoin casinos</a>.</p>` },
      { h: 'Ethereum (ETH) and Solana (SOL)', body: `<p>Native ETH works everywhere but mainnet gas can be high for small deposits; it shines for players already in the Ethereum ecosystem. Solana offers near-instant, sub-cent settlement and growing casino support. Both also carry price volatility unless you deposit the chain's stablecoin instead. See <a href="/best-ethereum-casinos">Ethereum</a> and <a href="/best-solana-casinos">Solana casinos</a>.</p>` },
      { h: 'Fees and speed, side by side', body: `<p>The practical differences are large. <strong>USDT-TRC20 (Tron)</strong> and <strong>Solana</strong>: seconds to confirm, fees of a cent or free — ideal for frequent play. <strong>Polygon</strong>: similar, very cheap. <strong>USDT-ERC20 / Ethereum mainnet</strong>: under a minute but gas can run a few dollars and spikes with congestion, so it only makes sense for larger deposits. <strong>Bitcoin</strong>: ~10–30 minutes (1–3 confirmations) and fees that swing with the mempool — fine for big, infrequent transfers, painful for small ones. For a $20 deposit, the wrong network can cost more in fees than the play; for a $5,000 transfer, the fee is noise and confirmation time matters more.</p>` },
      { h: 'Match the network to the goal', body: `<p>A quick decision rule: <strong>frequent, smaller play → USDT-TRC20</strong> (cheapest, instant, dollar-stable). <strong>You already hold BTC/ETH/SOL and want to use it → that coin on its native network</strong>, accepting the price volatility. <strong>Large one-off transfer → fee matters least, so pick whatever the casino confirms fastest and most reliably.</strong> Above all, deposit a dollar stablecoin rather than a volatile coin unless you specifically want market exposure on your balance while you play — most players don't.</p>` },
      { h: 'How to choose', body: `<p>Want stability and the lowest fees? USDT-TRC20. Already hold a coin and making a big transfer? Use that coin's network. Whatever you pick, always send on the <em>exact</em> network the casino specifies — sending USDT-ERC20 to a TRC20 address (or vice versa) can lose funds permanently. See the live <a href="/data/crypto-casino-deposit-currencies">currency breakdown</a>.</p>` },
    ],
    faqs: [
      { q: 'What is the best cryptocurrency for casino deposits?', a: 'For most players, USDT on Tron (TRC20) — fast, near-free, and dollar-stable, which is why it dominates the deposit flow we track. Use Bitcoin, Ethereum or Solana mainly if you already hold them or want that network specifically.' },
      { q: 'Which crypto has the lowest casino deposit fees?', a: 'USDT-TRC20 (Tron) and Solana have the lowest fees and fastest confirmations. Ethereum mainnet gas can be high for small deposits; Bitcoin fees vary with network congestion.' },
      { q: 'Should I deposit Bitcoin or a stablecoin?', a: 'For most players a stablecoin (USDT/USDC), because the amount you deposit is the amount you can wager — no price swing between deposit and cash-out. Use Bitcoin mainly if you already hold it, want censorship-resistance, or are making a large infrequent transfer where the fee is negligible.' },
    ],
    related: `Compare <a href="/guide/usdt-vs-bitcoin-casino-deposits">USDT vs Bitcoin</a> in depth, read <a href="/guide/stablecoin-casinos-explained">stablecoin casinos explained</a>, or see the <a href="/data/crypto-casino-deposit-currencies">live deposit-currency breakdown</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-rtp-and-house-edge', 'guide', guidePage({
    path: '/guide/crypto-casino-rtp-and-house-edge', h1: 'RTP and house edge at crypto casinos, explained',
    title: `Crypto Casino RTP & House Edge Explained (${YEAR}) | WCOIN.CASINO`,
    description: `What RTP and house edge mean at a crypto casino, typical values by game, why provably-fair does not mean better odds, and how the math guarantees the house wins over time.`,
    intro: `RTP and house edge are the two numbers that decide how much a game pays back over time. Here's what they mean, typical values, and why "provably fair" is about honesty, not odds.`,
    sections: [
      { h: 'What RTP and house edge are', body: `<p>RTP ("return to player") is the percentage of all wagered money a game pays back over millions of rounds — a 97% RTP slot returns $97 per $100 wagered on average. The house edge is simply the rest: 100% − RTP. So that slot has a 3% house edge. These are long-run averages, not what happens in any single session, where variance dominates.</p>` },
      { h: 'Typical values by game', body: `<p>House edge varies widely by game: blackjack with correct strategy can be under 1%, baccarat ~1.06%, European roulette 2.7%, most crypto-casino slots 1–8%, and "crash"/dice games often 1–2% (configurable by the operator). Lower edge means slower average losses — but the edge is always positive for the house, which is how the business is funded.</p>` },
      { h: 'Provably fair ≠ better odds', body: `<p>A common misconception: "provably fair" games give you a better chance. They don't. <a href="/guide/provably-fair-explained">Provably fair</a> cryptographically proves the operator didn't tamper with a specific result — it verifies <em>honesty</em>, not generosity. A provably-fair dice game can still carry whatever house edge the operator sets. Always check the stated RTP/edge separately from the fairness mechanism.</p>` },
      { h: 'Why variance fools players (and gamblers\' fallacies)', body: `<p>RTP is a <em>long-run</em> average over millions of rounds; any single session is dominated by variance, which is why a 97% game can hand you a big win or wipe you out in an hour. Two mental traps follow. The <strong>gambler's fallacy</strong>: thinking a result is "due" because it hasn't happened recently — each round is independent, so red isn't more likely after ten blacks. And <strong>chasing</strong>: increasing bets to recover losses, which only increases the amount exposed to a negative edge. High-variance slots advertise big top prizes precisely because most spins lose; the headline RTP hides how lumpy the path to it is.</p>` },
      { h: 'Where the edge is set — and how to check it', body: `<p>For studio slots the RTP is fixed by the game maker, but some titles ship in multiple RTP versions (e.g. 96% and 94%) and the operator chooses which to run — so the same slot can pay differently at two casinos. For in-house crash/dice games the operator sets the edge directly. Reputable operators publish the RTP/house edge in the game info panel; if a casino hides it, that's its own small red flag. Always read the stated number rather than assuming the "default", and treat a missing RTP as a reason to be cautious.</p>` },
      { h: 'What it means for you', body: `<p>Over enough play, the house edge guarantees the operator profits and the player's balance trends down — no strategy changes that for negative-edge games. Treat the edge as the price of entertainment, pick lower-edge games if you want your bankroll to last longer, and set limits. 18+ only; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is a good RTP for a crypto casino game?', a: 'Higher is better for the player. 97%+ (house edge under 3%) is good for slots; table games like blackjack and baccarat can exceed 99% RTP with correct play. The edge is always positive for the house, so no game pays back more than 100% over time.' },
      { q: 'Does provably fair mean the game is not rigged?', a: 'It proves a specific result was not altered after your bet, which rules out one kind of cheating. It does not change the house edge — a provably-fair game still carries whatever RTP the operator configured, so check that number separately.' },
      { q: 'Can the same slot have different RTP at different casinos?', a: 'Yes. Some studios ship a game in multiple RTP versions (e.g. 96% vs 94%) and the operator picks which to run. Check the RTP in each casino\'s game info panel rather than assuming it is the same everywhere.' },
      { q: 'Is a game "due" for a win after a losing streak?', a: 'No — that is the gambler\'s fallacy. Rounds are independent, so past results do not change the next outcome. Variance makes streaks feel meaningful, but the house edge is unchanged regardless of what came before.' },
    ],
    related: `See <a href="/guide/provably-fair-explained">provably fair explained</a>, <a href="/guide/crypto-casino-bonuses-explained">bonuses & wagering</a>, <a href="/responsible-gambling">responsible gambling</a>, and <a href="/guide/how-to-choose-a-crypto-casino">how to choose a crypto casino</a>.`,
  }), 'featured_core')
  add('/guide/stablecoin-casinos-explained', 'guide', guidePage({
    path: '/guide/stablecoin-casinos-explained', h1: 'Stablecoin casinos explained (USDT & USDC)',
    title: `Stablecoin Casinos Explained — USDT & USDC Gambling (${YEAR}) | WCOIN.CASINO`,
    description: `Why dollar stablecoins (USDT, USDC) dominate crypto-casino deposits, the networks they run on, the trade-offs vs volatile coins, and what the on-chain data shows.`,
    intro: `Most crypto-casino money moves as dollar stablecoins, not Bitcoin. Here's why USDT and USDC dominate, the networks they use, and the trade-offs.`,
    sections: [
      { h: 'Why stablecoins dominate', body: `<p>A stablecoin is a token pegged 1:1 to the US dollar. For casino play that's a big advantage: the amount you deposit is the amount you can wager, with no price swing between deposit and payout. Our on-chain data shows the overwhelming majority of tracked deposit flow is stablecoins — see the live <a href="/data/crypto-casino-deposit-currencies">deposit-currency breakdown</a>. Volatile coins like BTC or ETH expose your balance to market moves while you play.</p>` },
      { h: 'USDT vs USDC', body: `<p><strong>USDT (Tether)</strong> is the most widely supported and most-used casino deposit asset by far. <strong>USDC (USD Coin)</strong> is the regulated, fully-reserved alternative, favoured by players who prioritise transparency of the issuer's backing. Both hold the dollar peg in normal conditions; the practical difference for players is which one a given casino supports and on which network. Browse the <a href="/best-usdt-casinos">best USDT</a> and <a href="/best-usdc-casinos">best USDC</a> casinos.</p>` },
      { h: 'Networks matter', body: `<p>The same stablecoin runs on several chains and the network changes the cost and speed dramatically. <strong>USDT-TRC20 on Tron</strong> is the most popular: seconds to confirm, fees of cents or free. USDT/USDC-ERC20 on Ethereum works everywhere but costs more in gas; <a href="/best-polygon-casinos">Polygon</a> and <a href="/best-solana-casinos">Solana</a> offer low-fee alternatives. Always send on the EXACT network the casino specifies — a mismatch can lose funds.</p>` },
      { h: 'Issuer and de-peg risk, honestly', body: `<p>The trade-off stablecoins make is swapping market risk for <strong>issuer risk</strong>: you're trusting Tether or Circle to actually hold the dollars backing the token. This isn't only theoretical — USDC briefly de-pegged to ~$0.88 in March 2023 when part of its reserves sat in a failed bank, recovering within days once the situation resolved. The lesson isn't "avoid stablecoins"; de-pegs have been rare and brief, and for the minutes-to-hours a casino balance is in play the exposure is tiny. But it's a real, different risk than holding BTC, and a reason not to <em>store</em> large sums in any single stablecoin long-term.</p>` },
      { h: 'Don\'t leave a balance on the casino', body: `<p>A subtler point specific to gambling: the stablecoin in your <em>casino account</em> carries a risk the same coin in your own wallet doesn't — operator risk. A dollar-stable token doesn't protect you if the operator becomes insolvent or won't pay; it only protects you from price swings. So the stability benefit is real for the deposit-to-cash-out window, but the discipline still applies: withdraw winnings to your own wallet promptly rather than treating an on-platform stablecoin balance as savings. Check the operator can pay via the <a href="/proof-of-reserves">proof-of-reserves hub</a> first.</p>` },
      { h: 'The trade-offs', body: `<p>Stablecoins remove price risk but introduce issuer risk: you're trusting the issuer to hold real dollar reserves. Major stablecoins publish attestations, and de-pegs have been rare and brief, but it's a different risk than holding BTC. For most casino players the stability and low fees outweigh it, which is why the on-chain data is so lopsided toward stablecoins. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Why do crypto casinos prefer USDT?', a: 'USDT is dollar-stable (no price swing between deposit and payout), and on Tron (TRC20) it is fast and nearly free to transfer. That combination makes it the default rail — our on-chain data shows stablecoins dominate casino deposit flow.' },
      { q: 'Is USDC safer than USDT for casinos?', a: 'Both hold the dollar peg in normal conditions. USDC is fully reserved and regulated with regular attestations, which some players prefer; USDT is more widely supported at casinos. For deposits, the bigger practical factor is which network you use (TRC20 is cheapest).' },
      { q: 'Can a stablecoin lose its dollar peg?', a: 'It can, briefly — USDC dipped to about $0.88 in March 2023 over a banking issue and recovered within days. De-pegs have been rare and short, and for the short window a casino balance is in play the exposure is small, but it is a real issuer risk, so avoid storing large sums long-term in any one stablecoin.' },
      { q: 'Does using a stablecoin protect me if a casino won\'t pay?', a: 'No. A stablecoin only removes price volatility between deposit and cash-out. It does nothing about operator risk — insolvency or refusal to pay. Verify the operator holds reserves and withdraw winnings to your own wallet promptly; the token\'s stability is not solvency.' },
    ],
    related: `Compare assets in <a href="/guide/best-crypto-for-casino-deposits">best crypto for casino deposits</a>, check operators on the <a href="/proof-of-reserves">proof-of-reserves hub</a>, or see the live <a href="/data/crypto-casino-deposit-currencies">currency breakdown</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-kyc-and-anonymity', 'guide', guidePage({
    path: '/guide/crypto-casino-kyc-and-anonymity', h1: 'KYC and anonymity at crypto casinos',
    title: `Crypto Casino KYC & Anonymity Explained (${YEAR}) | WCOIN.CASINO`,
    description: `What KYC means at a crypto casino, when operators ask for identity verification, the reality of "no-KYC" play, and the privacy and risk trade-offs. Neutral, not advice.`,
    intro: `Crypto casinos often let you start with just a wallet, but "anonymous" has limits. Here's what KYC is, when it kicks in, and the trade-offs. General information, not legal advice.`,
    sections: [
      { h: 'What KYC is', body: `<p>KYC ("know your customer") is identity verification — submitting ID, proof of address, sometimes a selfie. Regulated operators use it to meet anti-money-laundering rules. Many crypto casinos let you sign up and play with only a wallet, but that does not mean KYC never applies — it often triggers later, especially around withdrawals.</p>` },
      { h: 'When operators ask for it', body: `<p>Common triggers: large or frequent withdrawals, a bonus dispute, suspected multi-accounting, or a request from the operator's licensing/payment partners. An operator can ask for verification at any point in its terms. A frustrating pattern players report is being asked for KYC only when they try to cash out a win — read the terms before depositing so you know what's required.</p>` },
      { h: 'The reality of "no-KYC"', body: `<p>"No-KYC" usually means no verification to <em>deposit and play</em>, not a guarantee you'll never be asked. Because settlement is on a public blockchain, transactions are also pseudonymous, not anonymous — addresses can be clustered and analysed (that's the basis of this site). Treat "anonymous gambling" as "lower-friction", not invisible.</p>` },
      { h: 'KYC as a stalling tactic — and how to pre-empt it', body: `<p>The pattern players complain about most isn't KYC itself — it's KYC sprung <em>only</em> at withdrawal, with document demands that keep escalating as a way to delay or deny a payout. You can largely defuse this. Before depositing, read exactly what verification the operator can require and when; if you intend to win and withdraw, consider completing KYC up front so it can't be used as a cash-out roadblock. Keep clean copies of ID and proof of address ready. An operator that verifies you smoothly when asked is behaving normally; one that invents fresh requirements each time you comply is showing you a conduct red flag — see <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">how to spot a casino that won't pay</a>.</p>` },
      { h: 'The reality of on-chain privacy', body: `<p>"Anonymous" oversells it. Blockchains are <strong>pseudonymous</strong>: your identity isn't attached to an address, but every transaction is public and permanent, and addresses can be clustered and linked through analysis — the very technique this site uses to map casino wallets. If you funded a casino from an exchange that holds your KYC, or reuse an address linked to your identity elsewhere, the "anonymous" play is traceable in principle. Genuine privacy takes deliberate effort and is never absolute. Treat crypto-casino play as low-friction and discreet, not invisible — and never as a way to evade your local law.</p>` },
      { h: 'Privacy and risk trade-offs', body: `<p>Less KYC means more privacy and faster onboarding, but also weaker recourse: a regulated operator that holds your verified identity is also more accountable in a dispute. You're trading protection for privacy. Whatever you choose, your local law on online gambling still applies — see <a href="/guide/are-crypto-casinos-legal">are crypto casinos legal?</a> 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Do crypto casinos require KYC?', a: 'Many let you deposit and play with just a wallet, but most reserve the right to require identity verification later — commonly at withdrawal, on large amounts, or in a dispute. Read the operator\'s terms before depositing so a KYC request does not block a cash-out.' },
      { q: 'Is gambling at a crypto casino anonymous?', a: 'Pseudonymous, not anonymous. You may not submit ID up front, but on-chain transactions are public and wallets can be analysed, and operators can ask for verification under their terms. Treat it as lower-friction, not invisible.' },
      { q: 'Should I complete KYC before or after depositing?', a: 'If you plan to win and withdraw, completing it up front can stop an operator from using KYC as a cash-out stalling tactic. Have clean ID and proof-of-address ready. Smooth verification when asked is normal; escalating demands each time you comply is a conduct red flag.' },
      { q: 'Can a no-KYC casino still trace my activity?', a: 'In principle, yes. On-chain transactions are public and pseudonymous — addresses can be clustered and linked, and funding from a KYC\'d exchange or reusing identity-linked addresses makes activity traceable. No-KYC means less friction, not true anonymity.' },
    ],
    related: `See <a href="/guide/are-crypto-casinos-legal">are crypto casinos legal?</a>, <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">spotting a casino that won't pay</a>, <a href="/guide/crypto-casino-red-flags">red flags</a>, and <a href="/guide/how-to-verify-a-crypto-casino">how to verify an operator on-chain</a>.`,
  }), 'featured_core')
  add('/guide/how-on-chain-casino-tracking-works', 'guide', guidePage({
    path: '/guide/how-on-chain-casino-tracking-works', h1: 'How on-chain crypto casino tracking works',
    title: `How On-Chain Crypto Casino Tracking Works (${YEAR}) | WCOIN.CASINO`,
    description: `How WCOIN reads crypto-casino deposits, withdrawals and reserves directly from public blockchains — wallet attribution, external-flow filtering, and the limits of the method.`,
    intro: `Because crypto casinos settle on public blockchains, their money flow is independently observable. Here's how we turn raw on-chain data into the verified figures across this site.`,
    sections: [
      { h: 'Public settlement is the foundation', body: `<p>Every crypto-casino deposit and withdrawal is a transaction on a public blockchain. Anyone can read those transactions and the balances of the wallets involved — no permission from the operator needed. That single fact is what makes independent, verifiable casino data possible, unlike a traditional casino's private banking.</p>` },
      { h: 'Attributing wallets to operators', body: `<p>The hard part is knowing which wallets belong to which casino. We map them only from evidence we can defend: public block-explorer name-tags, operator disclosures, and on-chain behaviour patterns. Wallets we detect as casino-like but cannot tie to a named brand are labelled "unattributed" and kept out of verified figures — never guessed into a brand. See our <a href="/methodology/address-attribution">attribution methodology</a>.</p>` },
      { h: 'From raw flow to credible figures', body: `<p>Raw volume is misleading: it double-counts casino-to-casino transfers and includes internal treasury churn. We count only <strong>external-facing flow</strong> (real deposits and withdrawals with players/exchanges) and exclude wash/treasury-churn operators, so a headline number reflects player activity rather than money cycling internally. Reserves are read across every chain we track and shown with a coverage level, never as a claimed figure. See the live <a href="/proof-of-reserves">proof-of-reserves hub</a>.</p>` },
      { h: 'Wallet clustering in plain terms', body: `<p>The core technique for finding an operator's full wallet set is <strong>common-input-ownership</strong>. When a transaction spends from several addresses at once, whoever signed it must control all of them — so those addresses almost certainly share one owner. Starting from a single known casino address (a public name-tag, or a deposit you made yourself), we expand outward through these co-spending links to map the cluster of hot and cold wallets the operator uses. It's a heuristic, not a proof — mixers, shared custodians and exchange wallets can blur it — which is exactly why we corroborate before attributing a cluster to a named brand and label anything uncertain as unattributed.</p>` },
      { h: 'Why we publish coverage and confidence', body: `<p>Most trackers hand you a single number and imply certainty. We do the opposite: every figure carries a <strong>coverage level</strong> (how much of an operator's footprint we've mapped) and a <strong>confidence</strong> grade, because honest on-chain data has to admit what it doesn't know. A reserve figure at low coverage is a floor, not a total. A volume figure excludes flows we can't attribute. This is less tidy than a confident leaderboard, but it's the difference between data you can rely on and data that merely looks authoritative — and it's why we never feature an operator we can't stand behind. See <a href="/methodology/data-confidence">how we score confidence</a>.</p>` },
      { h: 'The limits', body: `<p>On-chain tracking is powerful but partial: wallet mapping is never 100% complete, an operator can use wallets we haven't found, and balances are a snapshot that can be funded temporarily. That's why we label coverage and confidence on everything and pair on-chain signals with third-party reputation data rather than treating any single number as the whole truth. See <a href="/methodology/data-confidence">how we score confidence</a>.</p>` },
    ],
    faqs: [
      { q: 'How can a site track a casino\'s deposits without its permission?', a: 'Crypto casinos settle on public blockchains, so their transactions and wallet balances are readable by anyone. Once a casino\'s wallets are identified from public name-tags and on-chain behaviour, its deposit/withdrawal flow and reserves can be measured independently.' },
      { q: 'Why is your volume lower than other sites?', a: 'We count only external-facing flow (real deposits and withdrawals) and exclude casino-to-casino internal transfers, double-counts and wash/treasury churn. Raw throughput figures look much larger but overstate real player activity.' },
      { q: 'How do you know which wallets belong to a casino?', a: 'We start from a known address (a public block-explorer name-tag or a confirmed deposit) and expand via common-input-ownership — addresses co-spent in one transaction share an owner. It is a heuristic, so we corroborate before tying a cluster to a named brand and label uncertain ones as unattributed.' },
      { q: 'Is on-chain casino data 100% accurate?', a: 'No, and we don\'t claim it is. Wallet mapping is never complete, operators can use addresses we haven\'t found, and balances are snapshots. That is why every figure carries a coverage level and confidence grade, and why we pair on-chain signals with third-party reputation data rather than trusting any single number.' },
    ],
    related: `See the <a href="/methodology/address-attribution">attribution methodology</a>, <a href="/methodology/data-confidence">data-confidence scoring</a>, <a href="/guide/why-on-chain-data-beats-complaint-boards">why on-chain data beats complaint boards</a>, and the <a href="/proof-of-reserves">proof-of-reserves hub</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-deposit-not-showing', 'guide', guidePage({
    path: '/guide/crypto-casino-deposit-not-showing', h1: 'Crypto casino deposit not showing up — what to check',
    title: `Crypto Casino Deposit Not Showing? Troubleshooting (${YEAR}) | WCOIN.CASINO`,
    description: `Why a crypto-casino deposit can be delayed or missing — wrong network, unconfirmed transaction, memo/tag omitted, wrong token — and how to check each on a block explorer.`,
    intro: `A deposit that hasn't arrived is usually one of a few fixable things. Here's how to diagnose it on-chain before contacting support — and the one mistake that can lose funds.`,
    sections: [
      { h: 'First: check the transaction on a block explorer', body: `<p>Copy your transaction hash and look it up on the relevant explorer (Etherscan, Tronscan, Solscan, etc.). Confirm it shows "Success" with enough confirmations, and that the <strong>recipient address exactly matches</strong> the one the casino gave you. If the transaction is still pending, you simply need to wait for network confirmations — congested networks or low fees mean longer waits.</p>` },
      { h: 'Wrong network — the costly mistake', body: `<p>The most common cause of a "lost" deposit is sending on the wrong network: e.g. sending USDT-ERC20 (Ethereum) to a USDT-TRC20 (Tron) address, or using BEP-20 when the casino expects ERC-20. The token can end up at an address the casino doesn't control on that chain. Always send on the EXACT network the deposit page specifies. Recovery is sometimes possible but never guaranteed — prevention is everything.</p>` },
      { h: 'Missing memo/tag or wrong token', body: `<p>Some chains (e.g. certain exchange-style deposits) require a <strong>memo/destination tag</strong>; omitting it can strand the deposit until support reconciles it manually. Also check you sent the exact token requested (USDT, not a similarly-named token) and met any minimum-deposit threshold — sub-minimum deposits are sometimes not credited automatically.</p>` },
      { h: 'Confirmations, congestion and underpaid fees', body: `<p>If the transaction simply shows "pending", the cause is usually the network, not the casino. Each chain needs a number of block confirmations before a casino credits a deposit — instant on Tron and Solana, seconds on most EVM chains, but on Bitcoin a casino often waits for 1–3 confirmations (~10–30 minutes). Two things slow this further: <strong>network congestion</strong> (a backlog of pending transactions) and an <strong>underpaid fee</strong> — if you set the gas/fee too low, miners deprioritise your transaction and it can sit unconfirmed for hours. The explorer shows the pending status and fee; you can sometimes "speed up" / replace-by-fee from your wallet if it supports it.</p>` },
      { h: 'Self-custody vs exchange-sent deposits', body: `<p>Where you sent <em>from</em> matters. Sending from your own wallet gives you the transaction hash immediately and full control of the network. Sending from a centralized exchange adds a layer: the exchange may batch withdrawals, take its own time to broadcast, restrict certain networks, or strip a required memo. If your deposit came from an exchange and hasn't appeared, check the exchange's withdrawal status first — the coins may not have left it yet. Exchanges also sometimes block direct sends to gambling addresses, which can bounce a deposit back.</p>` },
      { h: 'When to contact support', body: `<p>If the explorer shows a confirmed transaction to the correct address on the correct network and it still hasn't credited after a reasonable wait, contact the casino's support with your transaction hash and deposit details. Keep the hash — it's the proof, and reputable operators can trace a deposit from it within minutes. A pattern of unexplained non-credited deposits across many users is a reputation red flag (see <a href="/guide/crypto-casino-red-flags">red flags</a>). 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Why is my crypto casino deposit not showing up?', a: 'Usually one of: the transaction is still waiting for network confirmations; it was sent on the wrong network; a required memo/tag was omitted; or it was below the minimum deposit. Look up your transaction hash on a block explorer to see which applies before contacting support.' },
      { q: 'How long should a crypto casino deposit take to credit?', a: 'On Tron (TRC20) and Solana, seconds; on most EVM chains, under a minute once confirmed; on Bitcoin, often 10–30 minutes because casinos wait for 1–3 confirmations. Congestion or an underpaid fee can extend this. If it is still "pending" on the explorer, you are waiting on the network, not the casino.' },
      { q: 'I sent crypto on the wrong network — can I get it back?', a: 'Sometimes, but never guaranteed. If the casino controls the destination address on the network you used, support may be able to credit or return it; otherwise the funds may be unrecoverable. Always send on the exact network the deposit page specifies.' },
      { q: 'My deposit came from an exchange and is missing — what now?', a: 'Check the exchange withdrawal status first; the coins may not have been broadcast yet, or the exchange may have stripped a required memo or blocked the destination. Once you have a transaction hash, verify it on the right block explorer before contacting casino support.' },
    ],
    related: `See <a href="/guide/crypto-casino-withdrawal-times">withdrawal times</a>, <a href="/guide/best-crypto-for-casino-deposits">best crypto for deposits</a> (network tips), <a href="/guide/usdt-vs-bitcoin-casino-deposits">USDT vs Bitcoin</a>, and <a href="/guide/crypto-casino-red-flags">red flags</a>.`,
  }), 'featured_core')
  // ── Phase 2: competitor-gap authority pages (uncontested differentiation) ──────
  add('/guide/proof-of-reserves-vs-proof-of-custody', 'guide', guidePage({
    path: '/guide/proof-of-reserves-vs-proof-of-custody', h1: 'Proof of reserves vs proof of custody',
    title: `Proof of Reserves vs Proof of Custody — Crypto Casinos (${YEAR}) | WCOIN.CASINO`,
    description: `Proof of reserves shows assets exist on-chain; proof of custody shows the operator actually controls them and owes you. The critical distinction, with a comparison table.`,
    intro: `"Proof of reserves" is widely cited but widely misunderstood. It is not the same as proving an operator controls the funds, or that it can cover what it owes you. Here's the distinction that matters before you deposit.`,
    sections: [
      { h: 'Proof of reserves: assets exist', body: `<p>Proof of reserves (PoR) demonstrates, on-chain, that crypto sits at wallets associated with an operator. Because blockchains are public, anyone can read those balances — no trust in the operator's word required. It answers "do the assets exist?" It does <strong>not</strong> answer who controls them or how much is owed to players.</p>` },
      { h: 'Proof of custody & liabilities: the harder questions', body: `<p>Proof of <em>custody</em> would show the operator exclusively controls the keys to those wallets — a reserve wallet can be borrowed, shared, or shown temporarily to look healthy. And neither proves <strong>liabilities</strong>: the total balance owed to all players. An operator can hold real reserves and still be insolvent if it owes more than it holds. PoR is necessary but not sufficient.</p>` },
      { h: 'Side by side', body: `<table><thead><tr><th>Question</th><th>Proof of reserves</th><th>Proof of custody / solvency</th></tr></thead><tbody><tr><td>Do the assets exist on-chain?</td><td class="mint">Yes — verifiable</td><td>—</td></tr><tr><td>Does the operator exclusively control them?</td><td>No</td><td>Hard to prove on-chain</td></tr><tr><td>Do reserves exceed what players are owed?</td><td>No (liabilities unknown)</td><td>Requires audited liabilities</td></tr><tr><td>Can it be faked with temporary funding?</td><td>Partially (watch the trend)</td><td>Harder</td></tr></tbody></table><p class="prose" style="font-size:13px;margin-top:8px">This is why we show reserves as a <strong>coverage level</strong> over time, paired with net flow — never a single "fully reserved" claim.</p>` },
      { h: 'How exchanges learned this the hard way', body: `<p>The reserves-vs-custody gap is not theoretical — it is exactly how several large crypto exchanges failed. They showed (or implied) healthy balances while quietly lending out, double-counting, or commingling customer funds, so the assets "existed" on paper but were not really there for customers. After those collapses, Merkle-tree proof-of-reserves became standard for exchanges precisely to prove the assets exist <em>and</em> map to customer liabilities. Casinos are earlier on that curve: most show no proof at all, which is why independently reading their on-chain wallets is currently the best a player can do.</p>` },
      { h: 'Liabilities: the number nobody publishes', body: `<p>The hardest figure to get is the one that decides solvency: total player balances owed. It lives in the operator's private database, not on-chain, so no outside party can verify it directly. This is the structural limit of any casino "proof of reserves": you can see assets, never the full debt. The practical workaround is to read reserves <em>relative to observable activity</em> — if mapped reserves dwarf recent withdrawal flow and stay stable, the operator is very unlikely to be unable to pay near-term withdrawals, even though you cannot prove total solvency.</p>` },
      { h: 'What this means before you deposit', body: `<p>Treat a healthy reserve figure as a strong positive signal, not a guarantee. The most useful version is reserves <em>tracked over time</em> against withdrawal outflow, so a temporary top-up stands out and a steady decline is visible. See live mapped reserves in the <a href="/proof-of-reserves">proof-of-reserves hub</a> and the method in <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves explained</a>. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is the difference between proof of reserves and proof of custody?', a: 'Proof of reserves shows assets exist at on-chain wallets associated with an operator. Proof of custody would additionally show the operator exclusively controls those keys. Neither proves liabilities (what is owed to players), so neither alone proves solvency.' },
      { q: 'Does proof of reserves mean a casino is solvent?', a: 'No. It proves assets are held, not that they exceed total player liabilities or that the operator solely controls them. It is a strong positive signal best read as a trend over time alongside net flow, not a solvency guarantee.' },
      { q: 'Why can\'t on-chain data prove a casino is solvent?', a: 'Because solvency compares assets to liabilities, and liabilities — the total balances owed to all players — live in the operator\'s private database, not on-chain. You can verify what a casino holds, never the full amount it owes, so on-chain data establishes a strong floor on assets but not complete solvency.' },
      { q: 'Can a casino fake its reserves?', a: 'A wallet can be funded temporarily to look healthy for a snapshot, which is why a single reading is weak. Reading reserves as a trend over time against withdrawal outflow exposes temporary top-ups and steady declines, making a one-off dress-up much harder to pass off.' },
    ],
    related: `See <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves explained</a>, <a href="/guide/how-on-chain-casino-tracking-works">how on-chain tracking works</a>, <a href="/guide/why-on-chain-data-beats-complaint-boards">why on-chain data beats complaint boards</a>, and the live <a href="/proof-of-reserves">reserves hub</a>.`,
  }), 'featured_core')
  add('/guide/why-on-chain-data-beats-complaint-boards', 'guide', guidePage({
    path: '/guide/why-on-chain-data-beats-complaint-boards', h1: 'On-chain data vs complaint boards: verify before you play',
    title: `On-Chain Casino Data vs Complaint Boards (${YEAR}) | WCOIN.CASINO`,
    description: `Complaint boards log problems after players lose money; on-chain reserve and flow data lets you check an operator BEFORE depositing. Why proactive verification beats reactive review.`,
    intro: `Most casino "review" sites are reactive: they record complaints after funds are already lost. On-chain data is proactive — you can check an operator's reserves and money flow before you deposit a cent. Here's how the two compare and combine.`,
    sections: [
      { h: 'How complaint boards work', body: `<p>Sites like complaint forums and review boards aggregate player reports — unpaid withdrawals, voided wins, disputes. They're genuinely useful for reputation and resolution rates, but they're <strong>lagging</strong>: a complaint only exists after someone has already been harmed, and a brand-new or quietly-deteriorating operator may have a clean board right up until it isn't.</p>` },
      { h: 'What on-chain data adds', body: `<p>Because crypto casinos settle on public blockchains, their reserves and flow are observable in real time — before any complaint is filed. A falling reserve trend, sustained one-way outflow, or reserves that don't cover withdrawals are <strong>leading</strong> signals you can read yourself. This is the proactive, pre-deposit check complaint boards can't offer. See <a href="/guide/how-on-chain-casino-tracking-works">how the tracking works</a>.</p>` },
      { h: 'The strongest signal is both together', body: `<p>Neither source is complete alone. On-chain data shows assets and flow but not the operator's intentions or off-chain liabilities; complaint data shows lived player experience but lags. Combining them — e.g. a low complaint-resolution rate <em>and</em> a declining reserve trend — is a far stronger risk signal than either by itself, and is the basis of a data-driven risk view rather than a vote-based one.</p>` },
      { h: 'Why votes and awards fall short', body: `<p>"Best casino" awards and star ratings often rest on votes and subjective evaluation, which are manipulable. Rankings grounded in <strong>real on-chain transactions and reserves</strong> are much harder to game — though on-chain volume itself can be wash-traded, which is exactly why we rank by independent trust and reserves, not raw volume. See the <a href="/rankings/trust">trust ranking</a> and <a href="/methodology/trust">how it's scored</a>.</p>` },
      { h: 'The affiliate-incentive problem', body: `<p>There is a second reason to be wary of conventional review sites: most monetise through affiliate deals, earning a cut of the revenue from players they refer. That creates a structural incentive to rank highly the operators that pay best, not necessarily the ones that are safest. On-chain data has no such conflict — a wallet balance is what it is regardless of who is paid. We don't take affiliate placement for rankings, and the reserve and flow figures we publish can't be bought.</p>` },
      { h: 'Where complaint boards still win', body: `<p>This isn't on-chain triumphalism — complaint boards capture things the chain can't: the actual lived experience of dealing with support, voided-win disputes, predatory bonus enforcement, and the all-important <em>resolution rate</em> (does the operator fix problems when pushed?). On-chain data can't see intent or off-chain conduct. The honest position is that they're complementary: the chain tells you whether the money is there; the boards tell you how the operator behaves when a human has a problem.</p>` },
      { h: 'How to combine them in practice', body: `<p>Read the on-chain signal first as a fast filter — reserves covering outflow, balanced two-way flow — then use complaint data to judge conduct: is there a recent <em>unresolved</em> withdrawal pattern, and does the operator resolve disputes? Strong agreement (healthy reserves and a good resolution rate) is reassuring; disagreement (healthy reserves but a fresh complaint wave, or thin reserves despite a clean board) is your cue to dig deeper before depositing. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Why check on-chain data instead of casino reviews?', a: 'Reviews and complaint boards are reactive — they record problems after players lose money. On-chain reserves and flow can be checked before you deposit, giving a leading signal (e.g. a declining reserve trend) that complaints can\'t. Use both together for the strongest read.' },
      { q: 'Are vote-based casino rankings reliable?', a: 'They are easily manipulated, since they rest on votes and subjective evaluation. Rankings driven by verifiable on-chain reserves and independent trust signals are harder to game — though raw on-chain volume can be wash-traded, so it should never be the ranking basis on its own.' },
      { q: 'Do affiliate commissions bias casino review sites?', a: 'They can. Many review sites earn a referral cut from the casinos they list, creating an incentive to favour high-paying operators over the safest ones. On-chain reserve and flow data has no such conflict — the figures are what the blockchain shows, regardless of who pays whom.' },
      { q: 'Are complaint boards useless then?', a: 'No — they capture lived experience the chain cannot: support quality, dispute resolution rates, bonus enforcement. They are complementary to on-chain data, not replaced by it. The strongest read combines the chain (is the money there?) with the boards (how does the operator behave?).' },
    ],
    related: `See <a href="/guide/proof-of-reserves-vs-proof-of-custody">proof of reserves vs custody</a>, <a href="/guide/how-on-chain-casino-tracking-works">how tracking works</a>, the <a href="/rankings/trust">trust ranking</a>, and <a href="/methodology/trust">trust methodology</a>.`,
  }), 'featured_core')
  // ── Phase 3: intent-cluster guides (payout-failure / scam-detection / payment) ──
  add('/guide/how-to-spot-a-crypto-casino-that-wont-pay', 'guide', guidePage({
    path: '/guide/how-to-spot-a-crypto-casino-that-wont-pay', h1: 'How to spot a crypto casino that won\'t pay winners',
    title: `How to Spot a Crypto Casino That Won't Pay (${YEAR}) | WCOIN.CASINO`,
    description: `A pre-deposit checklist for identifying crypto casinos likely to block or stall withdrawals — using on-chain reserve/flow signals cross-checked with complaint data. Neutral, verifiable.`,
    intro: `The worst outcome at a crypto casino isn't a losing session — it's winning and not being able to withdraw. Here's a verifiable, pre-deposit checklist that combines on-chain signals with reputation data.`,
    sections: [
      { h: 'On-chain reserve & flow signals', body: `<p>Check whether mapped reserves comfortably cover withdrawal outflow, and which way money is moving. <strong>Thin or falling reserves</strong> against steady deposits, or <strong>deposits with almost no outflow</strong> (money in, nothing paid out), are the clearest leading signals that withdrawals may stall. See the <a href="/data/crypto-casino-net-flow">net-flow report</a> and per-operator <a href="/proof-of-reserves">reserves</a>.</p>` },
      { h: 'Complaint-pattern signals', body: `<p>One angry review means little; a <strong>cluster of unresolved withdrawal complaints</strong>, a low resolution rate, or many reports using the same phrasing ("verification only when I tried to cash out") is a strong negative pattern. Cross-check this against the on-chain picture — a falling reserve trend <em>and</em> rising withdrawal complaints together is the high-confidence warning.</p>` },
      { h: 'Operational red flags', body: `<p>Be wary of: no identifiable ownership or licence, support that goes silent around withdrawals, terms that let the operator void wins broadly, and bonus conditions with extreme wagering requirements that effectively lock funds. KYC demanded only at cash-out (not signup) is a common stalling tactic — see <a href="/guide/crypto-casino-kyc-and-anonymity">KYC & anonymity</a>.</p>` },
      { h: 'The tactics non-paying casinos actually use', body: `<p>Operators that don't intend to pay rarely say so — they manufacture a reason. The recurring playbook: <strong>KYC sprung only at cash-out</strong> (never at signup), with document demands that escalate each time you comply; <strong>"bonus abuse" or "irregular play" accusations</strong> used to void winnings retroactively; <strong>withdrawal limits</strong> so low that a big win takes months to drip out (long enough for you to gamble it back); <strong>sudden "maintenance"</strong> or account "review" that freezes the balance; and terms that reserve the operator's right to void wins at its sole discretion. Recognising the pattern is half the defence — none of these are normal at an operator that simply pays.</p>` },
      { h: 'The test-withdrawal method', body: `<p>The single most reliable practical check is cheap: deposit a modest amount, play a little, and <strong>withdraw before you commit real size</strong>. A smooth small withdrawal won't guarantee a smooth large one (limits and manual review often kick in higher up), but a small withdrawal that already stalls, triggers escalating KYC, or gets "reviewed" indefinitely is a clear signal to walk away before depositing more. Treat the first withdrawal as the real product test, not the games.</p>` },
      { h: 'The pre-deposit checklist', body: `<p>Before depositing: (1) confirm reserves cover near-term withdrawals; (2) confirm two-way flow, not one-way inflow; (3) scan independent complaints for an <em>unresolved</em> withdrawal pattern; (4) read the withdrawal terms and KYC triggers; (5) start small and test a withdrawal before scaling up. Use a brand's <a href="/rankings/trust">trust page</a> and the <a href="/guide/crypto-casino-red-flags">red-flags guide</a>. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'How can I tell if a crypto casino will refuse to pay winners?', a: 'No single sign is proof, but the high-confidence warning is a falling on-chain reserve trend or one-way inflow combined with a pattern of unresolved withdrawal complaints. Add operational red flags (no licence, KYC only at cash-out, silent support) and test a small withdrawal before depositing big.' },
      { q: 'What is the most reliable pre-deposit safety check?', a: 'Cross-checking verifiable on-chain reserves and net flow against the trend in unresolved complaints. On-chain data is a leading signal you can read before depositing; complaint data is lived experience. Together they beat either alone.' },
      { q: 'What excuses do non-paying casinos use to block withdrawals?', a: 'Common tactics: KYC demanded only at cash-out with escalating document requests; "bonus abuse" or "irregular play" claims used to void wins; very low withdrawal limits that stall big wins; sudden account "review" or "maintenance"; and terms letting the operator void winnings at its discretion. A reasonable one-time KYC is normal; these patterns are not.' },
      { q: 'Does a successful small withdrawal mean a casino is safe?', a: 'It is a good sign but not a guarantee — limits and manual review often only trigger on larger amounts. A small withdrawal that already stalls or triggers escalating KYC is a clear warning; a smooth one means test again at higher size before committing serious funds.' },
    ],
    related: `See <a href="/guide/crypto-casino-red-flags">red flags</a>, <a href="/guide/on-chain-signs-of-a-casino-exit-scam">on-chain exit-scam signs</a>, <a href="/guide/crypto-casino-withdrawal-times">withdrawal times</a>, and the <a href="/data/crypto-casino-net-flow">net-flow report</a>.`,
  }), 'featured_core')
  add('/guide/on-chain-signs-of-a-casino-exit-scam', 'guide', guidePage({
    path: '/guide/on-chain-signs-of-a-casino-exit-scam', h1: 'On-chain signs a crypto casino may be in distress',
    title: `On-Chain Signs of Crypto Casino Distress (${YEAR}) | WCOIN.CASINO`,
    description: `Verifiable on-chain warning signals worth watching — sudden reserve drain, sustained one-way outflow, wallet consolidation. Neutral, data-based signals, never an accusation.`,
    intro: `Some warning signs of operator distress are visible on-chain before any announcement. These are neutral, verifiable signals — not accusations against any operator — and any one can have an innocent explanation, so weigh them together.`,
    sections: [
      { h: 'Sudden reserve drain', body: `<p>A sharp, unexplained drop in mapped reserves — especially funds moving toward exchanges or fresh wallets rather than paying player withdrawals — is the signal that draws the most attention. Reserves move for normal reasons too (rebalancing, cold storage), so the meaningful pattern is a <strong>large, sustained drain that doesn't correspond to player payouts</strong>. Track it as a trend, not a single transaction.</p>` },
      { h: 'Sustained one-way outflow', body: `<p>Healthy operators show balanced two-way flow — deposits in, withdrawals out. Prolonged net <strong>outflow with shrinking deposits</strong> can indicate wind-down or stress; prolonged inflow with almost no outflow can indicate players aren't being paid. Either imbalance, sustained over weeks, is worth heeding. See the <a href="/data/crypto-casino-net-flow">net-flow report</a>.</p>` },
      { h: 'Wallet consolidation & movement to exchanges', body: `<p>A burst of consolidation — many wallets sweeping into one, then onward to exchange deposit addresses — can precede an exit. On its own it's also just routine treasury management, so it matters most <em>combined</em> with a reserve drain and a spike in unresolved withdrawal complaints. No single on-chain action is proof of intent.</p>` },
      { h: 'Why each signal has an innocent explanation', body: `<p>This is the part that keeps the analysis honest: every on-chain signal here is dual-use. Reserves move to cold storage for <strong>security</strong>, not just flight. Wallets consolidate during routine <strong>treasury management</strong>. Funds go to exchanges to <strong>rebalance or convert</strong>, not only to cash out and vanish. Net outflow can simply mean an operator is <strong>honouring lots of withdrawals</strong> — a healthy thing. This is exactly why no single transaction is evidence of intent, and why anyone presenting one as "proof of a scam" is overreaching. The signal is in the <em>combination and persistence</em>, never the isolated move.</p>` },
      { h: 'What raises the confidence of a signal', body: `<p>A drain matters more when it is <strong>large relative to the operator's normal balance</strong>, <strong>sustained over days or weeks</strong> rather than a one-off, <strong>not matched by outgoing player payouts</strong> (funds leaving toward exchanges/new wallets instead of to many withdrawal counterparties), and <strong>correlated with off-chain stress</strong> — a spike in unresolved withdrawal complaints, support going dark, or new withdrawal limits appearing. When several of these line up at once, the read shifts from "routine" to "elevated risk, verify before adding exposure".</p>` },
      { h: 'How to use these signals', body: `<p>Treat them as a reason to pause and verify, not as a verdict. Reduce exposure, withdraw test amounts, and watch the trend. Our automated <a href="/risk">risk registry</a> surfaces observed on-chain signals, and per-operator pages show reserve trends — but the responsible read is "elevated risk, verify further", never a bare accusation against a named operator. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What on-chain signs suggest a crypto casino is in trouble?', a: 'A large sustained reserve drain not matched by player payouts, prolonged one-way net flow, and wallet consolidation moving funds to exchanges. Each can be innocent alone; together, and alongside rising unresolved complaints, they signal elevated risk worth verifying before depositing.' },
      { q: 'Does a reserve drop mean a casino is exit-scamming?', a: 'Not on its own — reserves move for routine reasons like rebalancing or cold storage. The concerning pattern is a large, sustained drain that doesn\'t correspond to paying withdrawals, combined with other signals. We present these neutrally as data, never as an accusation.' },
      { q: 'What makes an on-chain warning signal more credible?', a: 'Scale (large relative to the normal balance), persistence (sustained over days/weeks, not a one-off), direction (funds going to exchanges or new wallets rather than to many withdrawal counterparties), and correlation with off-chain stress like a complaint spike or limits appearing. Several lining up at once is what matters.' },
      { q: 'Can on-chain data prove a casino intends to exit-scam?', a: 'No. On-chain data shows what moved, never why. Intent cannot be read from the chain, so the responsible conclusion is always "elevated risk, verify further", not a verdict. We flag observed signals neutrally and never accuse a named operator.' },
    ],
    related: `See <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">spotting a casino that won't pay</a>, the <a href="/risk">risk registry</a>, <a href="/guide/crypto-casino-red-flags">red flags</a>, and <a href="/guide/how-to-verify-a-crypto-casino">how to verify on-chain</a>.`,
  }), 'featured_core')
  add('/guide/predict-casino-payout-risk-before-depositing', 'guide', guidePage({
    path: '/guide/predict-casino-payout-risk-before-depositing', h1: 'Predict casino payout risk before you deposit',
    title: `Predict Crypto Casino Payout Risk Before Depositing (${YEAR}) | WCOIN.CASINO`,
    description: `Treat funding a crypto casino as a risk-control decision. A concrete self-check across on-chain reserves, net flow, complaint trend and payment network to gauge payout risk first.`,
    intro: `Your payment choice and pre-deposit checks are a risk-control decision, not an afterthought. Here's a concrete self-check to gauge payout risk before you fund an account.`,
    sections: [
      { h: '1. Reserves vs outflow', body: `<p>Does the operator hold mapped on-chain reserves that comfortably cover its withdrawal outflow? A healthy coverage level means near-term withdrawals are well-backed; thin or under-review coverage is a reason for caution. Check the operator's reserve page and the <a href="/proof-of-reserves">reserves hub</a>.</p>` },
      { h: '2. Net-flow trend', body: `<p>Is money flowing both ways (deposits and withdrawals), or one way? Balanced flow is healthy; sustained net outflow can signal stress, and inflow with little outflow can signal players aren't being paid. The <a href="/data/crypto-casino-net-flow">net-flow report</a> shows the current picture per operator.</p>` },
      { h: '3. Complaint trend', body: `<p>Scan independent sources for the <em>direction</em> of complaints, not just the count — a rising share of <strong>unresolved withdrawal</strong> disputes is the signal that matters. Pair it with the on-chain read: agreement between the two raises confidence either way.</p>` },
      { h: '4. Payment & network choice', body: `<p>Treat the asset and network as risk control: a dollar stablecoin removes price risk between deposit and cash-out, and the right network (USDT-TRC20, Solana, <a href="/best-polygon-casinos">Polygon</a>) keeps fees and delays low. Always send on the exact network specified, and test a small withdrawal before committing larger funds. See <a href="/guide/best-crypto-for-casino-deposits">best crypto for deposits</a>.</p>` },
      { h: '5. Size and stage your exposure', body: `<p>The most controllable variable is how much you put at risk at once. Even a low-risk read doesn't justify depositing your full bankroll on day one. Stage it: a small first deposit, a test withdrawal, then scale only if both clear smoothly — and keep no more on the platform than you'd accept losing if it went dark tomorrow. Crypto casinos are not custodians or banks; an on-platform balance is exposure, not savings, so withdraw winnings promptly rather than letting a balance accumulate.</p>` },
      { h: 'Turning the checks into a quick risk read', body: `<p>You don't need a formula — you need agreement. If reserves comfortably cover outflow, flow is two-way, complaints aren't trending toward unresolved withdrawals, and you're using a stable asset on a low-fee network, the payout risk read is <strong>low</strong> — proceed with staged exposure. If two or more point the wrong way (thin/falling reserves, one-way inflow, a fresh unresolved-complaint cluster), treat it as <strong>elevated</strong> and either skip it or keep exposure minimal. Disagreement between the on-chain read and the complaint trend is itself a reason to dig deeper before funding. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'How do I assess payout risk before depositing at a crypto casino?', a: 'Run a quick self-check: (1) do mapped reserves cover withdrawal outflow; (2) is net flow balanced or one-way; (3) is the unresolved-complaint trend rising; (4) are you using a stable asset on the right low-fee network. Agreement between the on-chain read and complaint trend is the strongest signal.' },
      { q: 'Does my choice of crypto reduce withdrawal risk?', a: 'Indirectly. A dollar stablecoin removes price volatility between deposit and cash-out, and a fast low-fee network (TRC20, Solana, Polygon) reduces delay and cost. It does not change the operator\'s willingness to pay — pair it with the reserve, flow and complaint checks.' },
      { q: 'How much should I keep in a crypto casino account?', a: 'As little as possible — an on-platform balance is exposure, not savings, with no deposit insurance behind it. Withdraw winnings promptly rather than letting a balance build, and never keep more than you would accept losing if the operator went dark.' },
      { q: 'Can payout risk be predicted with certainty?', a: 'No — you are estimating, not guaranteeing. But combining verifiable on-chain reserve and flow signals with the unresolved-complaint trend gives a far better pre-deposit read than reputation or marketing alone, and staging your exposure limits the downside when the estimate is wrong.' },
    ],
    related: `See <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">spotting a casino that won't pay</a>, <a href="/guide/stablecoin-casinos-explained">stablecoin casinos</a>, <a href="/guide/are-crypto-casinos-safe">are crypto casinos safe?</a>, and the <a href="/data/crypto-casino-net-flow">net-flow report</a>.`,
  }), 'featured_core')
  // ── Phase 3b: priority-topic guides (payout / multi-crypto / event traffic) ────
  add('/guide/stablecoin-casino-withdrawals-fast-and-safe', 'guide', guidePage({
    path: '/guide/stablecoin-casino-withdrawals-fast-and-safe', h1: 'How fast & safe are stablecoin casino withdrawals?',
    title: `Stablecoin Casino Withdrawals — How Fast & Safe? (${YEAR}) | WCOIN.CASINO`,
    description: `How fast stablecoin (USDT/USDC) casino withdrawals really are, what slows them, and how to check the money is there to pay you — a withdrawal safety self-check.`,
    intro: `Stablecoin withdrawals can be near-instant — or stuck for days. The network is rarely the bottleneck; the operator's process and solvency are. Here's how fast they really are and how to check the safety side.`,
    sections: [
      { h: 'How fast the network actually is', body: `<p>Once an operator releases a withdrawal, on-chain settlement is quick: <strong>USDT-TRC20 (Tron)</strong> and <strong>Solana</strong> confirm in seconds for cents; USDT/USDC-ERC20 (Ethereum) is minutes and costlier; <a href="/best-polygon-casinos">Polygon</a> is fast and cheap. So a multi-hour or multi-day "pending" almost never means the blockchain is slow — it means the operator hasn't released the payout yet.</p>` },
      { h: 'What actually slows a withdrawal', body: `<p>The real delays are operator-side: manual review queues, a KYC request triggered at cash-out (see <a href="/guide/crypto-casino-kyc-and-anonymity">KYC & anonymity</a>), bonus-wagering locks, or simply understaffed processing. A wrong-network send or missing memo can also strand funds — diagnose that first with <a href="/guide/crypto-casino-deposit-not-showing">the troubleshooting guide</a>.</p>` },
      { h: 'The safety question: is the money there?', body: `<p>Speed is moot if the funds to pay you aren't held. The pre-withdrawal safety check is whether mapped on-chain reserves cover withdrawal outflow and money is flowing both ways. Thin reserves or one-way inflow are the signals a payout may stall regardless of network. See the <a href="/data/crypto-casino-net-flow">net-flow report</a> and <a href="/proof-of-reserves">reserves hub</a>.</p>` },
      { h: 'What "instant withdrawal" marketing really means', body: `<p>"Instant withdrawals" is one of the most-advertised and least-reliable claims in the industry. It is usually true only for <em>small, auto-approved</em> amounts on an <em>undisputed</em> account — exactly the cases where speed matters least. The moment a withdrawal is large, tied to a bonus, or hits a KYC trigger, the same "instant" casino routes it to manual review, and the marketing word stops applying. Read "instant" as "instant when nothing needs checking", and judge an operator by how it handles the <em>flagged</em> withdrawal, not the easy one. Independent complaints describing "instant deposits, then days of silence on cash-out" are the tell.</p>` },
      { h: 'Stablecoin removes price risk, not operator risk', body: `<p>It's worth being precise about what "safe" means here. A stablecoin withdrawal protects the <em>value</em> — $500 of USDT is $500 when it lands, with no market swing in between. It does nothing about whether the operator will <em>release</em> that $500. Those are two different risks, and players conflate them. The dollar peg is the easy part; the operator's willingness and ability to pay is the part that fails. So the "safe" in a stablecoin withdrawal comes from the reserve/flow checks, not from the coin itself.</p>` },
      { h: 'A stablecoin withdrawal self-check', body: `<p>Before depositing where you plan to win big: (1) use a stablecoin on a fast low-fee network (TRC20/Solana/Polygon); (2) confirm reserves cover outflow; (3) confirm two-way flow; (4) read the KYC and bonus terms; (5) test a small withdrawal first. If a confirmed on-chain payout still doesn't credit, keep the transaction hash for support. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'How long do stablecoin casino withdrawals take?', a: 'On-chain settlement is seconds to minutes once released (USDT-TRC20, Solana fastest). Any longer delay is operator-side — review queues, KYC at cash-out, or bonus locks — not the network. Multi-day "pending" is an operator-processing or solvency question, not a blockchain one.' },
      { q: 'Are stablecoin withdrawals safe?', a: 'The asset is dollar-stable, so value is preserved, but safety depends on whether the operator actually holds funds to pay you. Check that mapped reserves cover outflow and flow is two-way before depositing, and test a small withdrawal first.' },
      { q: 'Do casinos really pay out instantly?', a: 'Usually only for small, auto-approved withdrawals on an undisputed account. Large amounts, bonus-linked wins, or anything triggering KYC get routed to manual review at the same "instant" casino. Judge an operator by how it handles a flagged withdrawal, not the easy one.' },
    ],
    related: `See <a href="/guide/crypto-casino-withdrawal-times">withdrawal times</a>, <a href="/guide/predict-casino-payout-risk-before-depositing">predict payout risk</a>, <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">spotting a casino that won't pay</a>, and <a href="/guide/stablecoin-casinos-explained">stablecoin casinos explained</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-payout-speed-vs-support', 'guide', guidePage({
    path: '/guide/crypto-casino-payout-speed-vs-support', h1: 'Payout speed vs support quality: which matters more?',
    title: `Crypto Casino Payout Speed vs Support Quality (${YEAR}) | WCOIN.CASINO`,
    description: `Fast payouts or responsive support — which should you prioritise at a crypto casino? The trade-offs, when each matters most, and how to evaluate both before depositing.`,
    intro: `Players often optimise for fast payouts and overlook support — until a withdrawal stalls and nobody answers. Here's how the two trade off and how to weigh them before you deposit.`,
    sections: [
      { h: 'Why payout speed matters', body: `<p>Fast, reliable payouts are the clearest sign an operator is solvent and willing to pay — money actually leaving to players, quickly, is hard to fake. When everything works, speed is what you feel. But headline "instant withdrawal" claims only hold while nothing is disputed; the real test is what happens when a payout is flagged for review.</p>` },
      { h: 'Why support quality matters', body: `<p>Support is the safety net for exactly that moment. A responsive, competent support channel resolves a stuck KYC, a missing memo, or a bonus-lock dispute; a silent one turns a fixable delay into a lost balance. The most common bad-experience pattern is fast deposits, "instant" marketing, then no reply when a withdrawal needs a human.</p>` },
      { h: 'The trade-off — when each wins', body: `<p>For small, frequent play, payout speed dominates the experience. For larger balances or anything that might trigger review (big wins, bonuses, KYC), support quality matters more — that's when funds get stuck. Ideally you want both, but if you must rank them, weight support higher the larger your potential withdrawal.</p>` },
      { h: 'Support red flags worth a test message', body: `<p>Before depositing, send support a real pre-sales question and watch <em>how</em> they answer. Warning signs: only a bot with no path to a human; answers that dodge specifics on withdrawal limits or KYC triggers; pressure to deposit instead of addressing your question; or no response at all within a reasonable window. A good sign: a clear, specific human answer about withdrawal terms. This five-minute test costs nothing and is one of the few support-quality checks you can run <em>before</em> you have money at stake.</p>` },
      { h: 'The combination that predicts trouble', body: `<p>The worst outcomes share a profile: heavy "instant payout" marketing, fast and frictionless deposits, then support that goes quiet exactly when a withdrawal needs a human. Speed and support aren't independent — an operator under solvency strain often shows <em>both</em> slowing withdrawals <em>and</em> deteriorating support at once, because both are downstream of the same pressure. So a fresh cluster of "can't reach support about my withdrawal" complaints, especially alongside a falling reserve trend, is a stronger signal than either alone. Read them together, not as separate boxes to tick.</p>` },
      { h: 'How to evaluate both before depositing', body: `<p>For speed: check on-chain that the operator shows steady two-way flow (it's paying people) — see the <a href="/data/crypto-casino-net-flow">net-flow report</a>. For support: test the channel with a real question before depositing, and scan independent complaints for a pattern of <em>unresolved</em> disputes (the signal support is failing). Pair both with the <a href="/guide/predict-casino-payout-risk-before-depositing">payout-risk self-check</a>. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Is fast payout or good support more important at a crypto casino?', a: 'Both, but weight support higher the larger your potential withdrawal. Speed defines the experience when everything works; support is what saves a stuck payout when a withdrawal is flagged for review, KYC or a dispute — the moment funds actually get lost.' },
      { q: 'How do I judge a crypto casino\'s support before depositing?', a: 'Test the support channel with a real question first, and scan independent reviews for a pattern of unresolved (not just total) complaints. Combine that with the on-chain check that the operator is paying players — steady two-way flow.' },
      { q: 'What support red flags should I watch for?', a: 'A bot with no route to a human, answers that dodge specifics on withdrawal limits or KYC, pressure to deposit instead of answering, or no reply at all. Test it with a real pre-sales question before depositing — a clear, specific human answer is a good sign.' },
    ],
    related: `See <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">spotting a casino that won't pay</a>, <a href="/guide/crypto-casino-withdrawal-times">withdrawal times</a>, <a href="/guide/crypto-casino-red-flags">red flags</a>, and <a href="/guide/predict-casino-payout-risk-before-depositing">predict payout risk</a>.`,
  }), 'featured_core')
  add('/guide/choosing-a-multi-crypto-casino-safely', 'guide', guidePage({
    path: '/guide/choosing-a-multi-crypto-casino-safely', h1: 'Choosing a multi-crypto casino safely',
    title: `Choosing a Multi-Crypto Casino Safely (${YEAR}) | WCOIN.CASINO`,
    description: `Casinos accepting the widest crypto range aren't automatically the safest. The safety dimensions that actually matter, and how to use coin/network choice as risk control.`,
    intro: `Supporting many coins is convenient, but "accepts everything" isn't a safety signal on its own. Here's what actually matters when picking a multi-crypto casino, and how your asset choice is itself risk control.`,
    sections: [
      { h: 'Why multi-coin support helps — and its limits', body: `<p>A wide coin range lets you fund from whatever you already hold and pick a fast, low-fee network. That's genuine convenience. But the number of supported coins says nothing about solvency or payout reliability — those depend on whether the operator holds funds and pays withdrawals, which you check the same way regardless of coin count.</p>` },
      { h: 'The safety dimensions that matter', body: `<p>For any operator, multi-coin or not, the load-bearing checks are: verifiable on-chain reserves that cover outflow, two-way money flow, an independent trust track record, and the trend in unresolved complaints. Run the <a href="/guide/predict-casino-payout-risk-before-depositing">payout-risk self-check</a> and read its <a href="/proof-of-reserves">reserves</a> — these don't change because the casino lists 20 coins.</p>` },
      { h: 'Asset & network choice as risk control', body: `<p>This is where multi-coin support pays off: choose a <strong>dollar stablecoin</strong> to remove price volatility between deposit and cash-out, on a <strong>fast low-fee network</strong> (USDT-TRC20, Solana, <a href="/best-polygon-casinos">Polygon</a>) to minimise delay and fees. See <a href="/guide/best-crypto-for-casino-deposits">best crypto for deposits</a>. Always send on the exact network the deposit page specifies.</p>` },
      { h: 'What wide coin support can quietly hide', body: `<p>A long list of accepted coins can create a false sense of legitimacy — "they support everything, they must be established." Treat that instinct with caution. Adding tokens is cheap and mostly automated; it signals engineering effort, not solvency or honesty. A brand-new operator can list 30 coins on day one. Worse, a sprawling deposit-asset list can <em>fragment</em> reserves across many chains and wallets, which can make the operator's true on-chain position harder to read — not a problem if you check per-chain coverage, but a reason not to mistake breadth for depth. Judge the operator on reserves and payout behaviour, exactly as you would a single-coin site.</p>` },
      { h: 'Diversification cuts both ways', body: `<p>Multi-coin support gives <em>you</em> useful optionality: if one network is congested or a casino's hot wallet on one chain is slow, you can deposit and withdraw on another. That's a genuine resilience benefit. The catch is matching it with discipline — pick one stablecoin on one fast, low-fee network and stick to it rather than spreading small balances across chains you then have to track. Optionality is valuable when a problem appears; it's just clutter the rest of the time.</p>` },
      { h: 'A safe-choice checklist', body: `<p>(1) Confirm reserves cover near-term withdrawals; (2) confirm two-way flow; (3) pick a stablecoin on a low-fee network; (4) read withdrawal/KYC terms; (5) test a small cash-out first. Convenience features are a bonus on top of these — never a substitute. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Is a casino that accepts more cryptocurrencies safer?', a: 'No — coin count is a convenience feature, not a safety signal. Safety depends on verifiable reserves, two-way flow, trust track record and complaint trend, which you check the same way regardless of how many coins are listed.' },
      { q: 'What crypto should I use at a multi-coin casino?', a: 'For most players a dollar stablecoin (USDT/USDC) on a fast low-fee network like Tron (TRC20), Solana or Polygon — it removes price volatility between deposit and withdrawal and keeps fees low. Always send on the exact network specified.' },
      { q: 'Does supporting many coins mean a casino is well-established?', a: 'Not reliably. Adding tokens is cheap and largely automated, so a brand-new operator can list dozens on day one. Wide coin support signals engineering effort, not solvency or trustworthiness — verify reserves and payout behaviour regardless.' },
    ],
    related: `See <a href="/guide/best-crypto-for-casino-deposits">best crypto for deposits</a>, <a href="/guide/stablecoin-casinos-explained">stablecoin casinos</a>, and <a href="/guide/how-to-choose-a-crypto-casino">how to choose a crypto casino</a>.`,
  }), 'featured_core')
  add('/guide/world-cup-crypto-betting-safety', 'guide', guidePage({
    path: '/guide/world-cup-crypto-betting-safety', h1: 'World Cup crypto betting: how to pick a safe sportsbook',
    title: `World Cup Crypto Betting — Pick a Safe Sportsbook (${YEAR}) | WCOIN.CASINO`,
    description: `Big events bring traffic spikes and withdrawal stalls. How to choose a safe crypto sportsbook for the World Cup using the same on-chain reserve and flow checks — neutral, data-led.`,
    intro: `Major events like the World Cup drive a flood of new deposits — and a spike in stuck-withdrawal complaints right after. The safe-platform checks are the same on-chain ones we apply to casinos. Here's how to bet the event without funding the wrong book.`,
    sections: [
      { h: 'Why big events raise the risk', body: `<p>During a major tournament, sportsbooks take in unusually large deposit volume in a short window. Under-resourced or stressed operators are most likely to slow or stall withdrawals exactly when payout demand peaks. A platform that looked fine in quiet weeks can wobble under event load — which is why a pre-deposit check matters more, not less, around big events.</p>` },
      { h: 'Apply the on-chain safety checks', body: `<p>A crypto sportsbook settles on public chains just like a casino, so the same verifiable checks apply: do mapped reserves cover withdrawal outflow, is money flowing both ways, and what's the trend in unresolved complaints. Run the <a href="/guide/predict-casino-payout-risk-before-depositing">payout-risk self-check</a> before depositing for the event, not after.</p>` },
      { h: 'Use a stablecoin and test a cash-out', body: `<p>Fund with a dollar stablecoin on a fast low-fee network (USDT-TRC20, Solana, <a href="/best-polygon-casinos">Polygon</a>) so value is preserved and payouts are quick once released. Deposit only what you plan to bet, and <strong>test a small withdrawal early in the event</strong> — before the final-weekend rush — so you know the payout path works while support is less swamped.</p>` },
      { h: 'Sportsbook risks a casino doesn\'t have', body: `<p>Event betting adds failure modes beyond the casino checks. <strong>Liability spikes</strong>: a single popular outcome (a favourite winning) can leave an under-capitalised book owing more than it holds at once — a solvency stress test the on-chain reserve read helps you anticipate. <strong>Settlement disputes</strong>: voided bets, "palpable error" odds cancellations, and disputed results are sportsbook-specific ways winnings get clawed back, so the terms on bet voiding matter as much as withdrawal terms. <strong>Limit cuts</strong>: winning bettors often see their max stakes quietly slashed. None of these appear at a slots casino, so read a book's rules on void/cancellation/limits before the event, not after a disputed payout.</p>` },
      { h: 'Time your bankroll around the event', body: `<p>The withdrawal-stall risk isn't constant — it peaks in the hours after big results when everyone cashes out at once. Practical timing: fund and run your <strong>test withdrawal in the quiet run-up</strong>, not on finals weekend; <strong>withdraw winnings promptly</strong> after each settled bet rather than letting a balance ride through the whole tournament; and keep on the platform only the stake you intend to bet next, not your whole event budget. Treating the book as a pass-through rather than a wallet is the single best protection against an event-driven freeze.</p>` },
      { h: 'Bet the event responsibly', body: `<p>Event excitement and "can't-miss" odds drive overspending. Set a budget before the tournament, treat the stake as entertainment, and don't chase losses across matches. We don't publish odds or tips — our role is the on-chain safety read. 18+; <a href="/responsible-gambling">gamble responsibly</a> and use deposit limits.</p>` },
    ],
    faqs: [
      { q: 'How do I pick a safe crypto sportsbook for the World Cup?', a: 'Use the same on-chain checks as for a casino: confirm mapped reserves cover withdrawal outflow, money flows both ways, and unresolved complaints aren\'t rising. Fund with a stablecoin on a fast network and test a small withdrawal early in the event, before the peak-demand rush.' },
      { q: 'Why are withdrawals slower during big sporting events?', a: 'Events bring a surge of deposits and payout requests in a short window; under-resourced operators stall withdrawals exactly when demand peaks. Check solvency signals before depositing and cash out test amounts early rather than during the final-weekend rush.' },
      { q: 'What betting risks are unique to sportsbooks vs casinos?', a: 'Liability spikes when a popular outcome wins (the book may owe more than it holds at once), settlement disputes like voided bets and "palpable error" cancellations, and winning-bettor limit cuts. Read the void/cancellation and limit terms before the event, not after a disputed payout.' },
    ],
    related: `See <a href="/guide/predict-casino-payout-risk-before-depositing">predict payout risk</a>, <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">spotting a book that won't pay</a>, <a href="/guide/crypto-casino-red-flags">red flags</a>, and <a href="/guide/stablecoin-casino-withdrawals-fast-and-safe">stablecoin withdrawals</a>.`,
  }), 'featured_core')
  // ── net-new pillar guides (expanding the informational / GEO surface) ──────────
  add('/guide/what-is-igaming', 'guide', guidePage({
    path: '/guide/what-is-igaming', h1: 'What is iGaming?',
    title: `What Is iGaming? The Online Gambling Industry Explained (${YEAR}) | WCOIN.CASINO`,
    description: `iGaming means online gambling — casinos, sportsbooks, poker and more, played over the internet. What the term covers, how the industry is structured, how crypto changed it, and where the money actually flows.`,
    intro: `"iGaming" is the industry term for online gambling — real-money casino games, sports betting, poker and lotteries delivered over the internet. Here's what it covers, how it's built, and why crypto reshaped it.`,
    sections: [
      { h: 'What the term covers', body: `<p>iGaming spans every form of real-money gambling played online: <strong>online casinos</strong> (slots, live dealer, table games), <strong>sportsbooks</strong> (fixed-odds and in-play betting), <strong>online poker</strong>, <strong>bingo and lotteries</strong>, and increasingly <strong>prediction markets</strong>. It excludes free-to-play social casino games (no real-money payout). The defining features are that stakes are real money and outcomes are determined by chance or events, delivered through a website or app rather than a physical venue.</p>` },
      { h: 'How the industry is structured', body: `<p>Behind a casino brand sits a supply chain most players never see: <strong>game studios</strong> (Pragmatic Play, Evolution, Hacksaw) build the slots and live tables; <strong>platform/aggregator</strong> providers stitch them into a cashier and account system; the <strong>operator</strong> runs the brand, marketing and support; and <strong>payment processors</strong> (or, for crypto, the blockchain itself) move money. A single "casino" is really an operator licensing content and infrastructure from many vendors.</p>` },
      { h: 'How operators make money', body: `<p>Every game carries a built-in <a href="/guide/crypto-casino-rtp-and-house-edge">house edge</a> — the mathematical margin that, over enough play, guarantees the operator profits and players' balances trend down. Sportsbooks embed the same margin in their odds (the "vig"). This is the core business model; bonuses, VIP programs and streamer marketing exist to acquire and retain players who then wager against that edge.</p>` },
      { h: 'How crypto changed iGaming', body: `<p>Crypto casinos are the fastest-growing iGaming segment. By settling deposits and payouts on public blockchains instead of banks, they offer near-instant, borderless, low-friction money movement — and, uniquely, <strong>transparency</strong>: an operator's reserves and money flow become independently observable, which is impossible with a traditional casino's private banking. That transparency is what makes the on-chain data on this site possible. The trade-off is lighter regulation and less recourse — see <a href="/guide/crypto-casino-vs-online-casino">crypto vs traditional online casino</a>.</p>` },
      { h: 'Regulation and licensing', body: `<p>iGaming is regulated jurisdiction by jurisdiction. Some markets license and tax operators heavily (UK, Malta, several US states); many crypto casinos run under lighter offshore licences (Curaçao, Anjouan) with limited player recourse. Legality depends entirely on where the player is — see <a href="/guide/are-crypto-casinos-legal">are crypto casinos legal?</a> A licence is a baseline signal, not a guarantee of safety.</p>` },
      { h: 'Where the money flows', body: `<p>On the crypto side, the money is overwhelmingly <strong>stablecoins</strong> — USDT, mostly on Tron — because a dollar-pegged token removes price risk between deposit and cash-out. Real player flow is many small transfers; the biggest analytical trap is mistaking <a href="/guide/wash-trading-in-crypto-casinos-explained">wash-traded or treasury volume</a> for genuine activity. We strip that out, which is why our figures are lower and more realistic than raw-throughput trackers. 18+ only; <a href="/responsible-gambling">gamble responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What does iGaming mean?', a: 'iGaming is the industry term for online real-money gambling — online casinos, sportsbooks, poker, bingo and lotteries delivered over the internet. It excludes free-to-play social casino games that have no real-money payout.' },
      { q: 'Is iGaming the same as a crypto casino?', a: 'A crypto casino is one segment of iGaming — an online casino that takes deposits and pays winnings in cryptocurrency. iGaming is the broader category that also includes fiat casinos, sportsbooks and poker.' },
      { q: 'How does the iGaming industry make money?', a: 'From the house edge built into every game (and the margin in sportsbook odds). Over time that mathematical margin ensures operators profit; bonuses and marketing exist to acquire players who wager against it.' },
      { q: 'Why is crypto growing in iGaming?', a: 'Crypto settles on public blockchains, giving near-instant borderless payouts and — uniquely — transparency: reserves and money flow can be independently verified. The trade-off is lighter regulation and less recourse than licensed fiat operators.' },
    ],
    related: `See <a href="/guide/what-is-a-crypto-casino">what is a crypto casino?</a>, <a href="/guide/crypto-casino-vs-online-casino">crypto vs traditional online casino</a>, and <a href="/guide/how-on-chain-casino-tracking-works">how on-chain tracking works</a>.`,
  }), 'featured_core')
  add('/guide/what-is-a-crypto-sportsbook', 'guide', guidePage({
    path: '/guide/what-is-a-crypto-sportsbook', h1: 'What is a crypto sportsbook?',
    title: `What Is a Crypto Sportsbook? How Crypto Sports Betting Works (${YEAR}) | WCOIN.CASINO`,
    description: `A crypto sportsbook is an online sportsbook that takes bets in cryptocurrency. How it differs from a crypto casino, how odds and liability work, the risks unique to betting, and how to check one is safe.`,
    intro: `A crypto sportsbook lets you bet on sports using cryptocurrency instead of fiat. It shares a lot with a crypto casino but has its own mechanics and risks. Here's how it works and how to judge one.`,
    sections: [
      { h: 'Sportsbook vs casino', body: `<p>Both are iGaming operators settling on-chain, and many brands run both under one account. The difference is the product: a casino offers house-banked games with a fixed <a href="/guide/crypto-casino-rtp-and-house-edge">house edge</a>; a sportsbook takes bets on real-world events at odds it sets. The operator's margin is baked into those odds (the "vig" or "overround"), so across all outcomes the book expects to pay out less than it takes in.</p>` },
      { h: 'How odds and the margin work', body: `<p>Odds imply a probability. Add up the implied probabilities across all outcomes of a market and a fair book would total 100%; a real book totals more — say 105% — and that extra 5% is its margin. Lower-margin books give bettors better value. Crypto sportsbooks compete partly on margin, but the headline "best odds" claim means little if the operator won't pay a winning bet, which is the real risk.</p>` },
      { h: 'Liability — a risk casinos don\'t have', body: `<p>A casino's exposure is spread across many small independent bets. A sportsbook can face <strong>concentrated liability</strong>: if a heavily-backed favourite wins, the book may owe more on that single outcome than it holds at that moment. Under-capitalised books are most likely to stall or dispute payouts exactly after big popular results — which is why an on-chain <a href="/proof-of-reserves">reserve</a> read matters even more around major events (see <a href="/guide/world-cup-crypto-betting-safety">event betting safety</a>).</p>` },
      { h: 'Settlement disputes and voided bets', body: `<p>Sportsbooks have payout-blocking mechanisms casinos don't: <strong>voided bets</strong> (event abandoned, rule change), <strong>"palpable error"</strong> clauses that cancel bets taken at obviously-wrong odds, and <strong>result disputes</strong>. Some operators use these liberally to claw back winnings. Read the void/cancellation and settlement terms before betting — they matter as much as the withdrawal terms.</p>` },
      { h: 'Limit cuts on winners', body: `<p>A pattern winning bettors report across the industry: once you win consistently, your maximum stake quietly gets slashed, sometimes to pennies. It's legal under most terms and not unique to crypto, but it's worth knowing that "we welcome winners" is rarely literally true. It doesn't threaten your funds directly, but it's a signal about how an operator treats profitable customers.</p>` },
      { h: 'How to check a crypto sportsbook is safe', body: `<p>The core checks are the same as for a casino: verifiable <a href="/proof-of-reserves">on-chain reserves</a> that cover outflow, balanced two-way flow, and no rising cluster of <em>unresolved</em> payout complaints — run the <a href="/guide/predict-casino-payout-risk-before-depositing">payout-risk self-check</a>. Add the sportsbook-specific step: read the void/cancellation and limit terms. Fund with a stablecoin on a fast network and test a small withdrawal early. 18+ only; <a href="/responsible-gambling">bet responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is a crypto sportsbook?', a: 'An online sportsbook that accepts bets and pays winnings in cryptocurrency, settling on a public blockchain. It sets odds on real-world events and earns a margin baked into those odds, rather than running house-banked casino games.' },
      { q: 'How is a crypto sportsbook different from a crypto casino?', a: 'A casino offers house-banked games with a fixed house edge; a sportsbook takes bets on events at odds it sets, with the margin in the odds. Sportsbooks also face concentrated liability and have settlement-dispute mechanisms (voided bets, limit cuts) that casinos don\'t.' },
      { q: 'Are crypto sportsbook odds better?', a: 'Some compete on lower margin, giving better value, but "best odds" is meaningless if the operator won\'t pay winners. Judge a sportsbook first on whether it can and does pay — verifiable reserves, two-way flow, resolved complaints — then on odds.' },
      { q: 'What extra risks do sportsbooks have?', a: 'Concentrated liability (owing more than reserves on a popular winning outcome), settlement disputes and voided-bet clauses used to claw back winnings, and stake limits cut on winning bettors. Read the void/cancellation and limit terms before betting.' },
    ],
    related: `See <a href="/guide/world-cup-crypto-betting-safety">event betting safety</a>, <a href="/guide/predict-casino-payout-risk-before-depositing">predict payout risk</a>, and <a href="/proof-of-reserves">proof-of-reserves hub</a>.`,
  }), 'featured_core')
  add('/guide/wash-trading-in-crypto-casinos-explained', 'guide', guidePage({
    path: '/guide/wash-trading-in-crypto-casinos-explained', h1: 'Wash trading in crypto casinos, explained',
    title: `Wash Trading in Crypto Casinos — Why Volume Is Inflated (${YEAR}) | WCOIN.CASINO`,
    description: `What wash trading and treasury churn are, how they inflate a crypto casino's on-chain volume, how to spot the pattern yourself, and why most trackers overstate volume by an order of magnitude.`,
    intro: `A crypto casino's headline "volume" is often mostly fake — inflated by wash trading and treasury churn, not real players. Here's what those are, how to spot them, and why they matter.`,
    sections: [
      { h: 'What wash trading is', body: `<p>Wash trading is moving funds back and forth between addresses you control to manufacture the appearance of activity. On-chain it looks like volume — real tokens really move — but no genuine economic exchange happens; the same money cycles in a loop. Operators (or third parties) do it to look bigger and more popular than they are, because "highest volume" is a marketing claim and a ranking signal.</p>` },
      { h: 'Treasury and market-making churn', body: `<p>Not all inflated volume is deliberate deception. Operators legitimately move large sums between their own hot and cold wallets, rebalance across exchanges, and run market-making for a native token. This <strong>treasury churn</strong> is real business activity — but it isn't player deposits and withdrawals, so counting it as "casino volume" is just as misleading as counting wash trades. Both must be stripped out to see real player flow.</p>` },
      { h: 'Why raw volume overstates activity', body: `<p>Most trackers report <strong>gross throughput</strong> — every token that moves through a wallet. That double-counts casino-to-casino transfers, includes internal churn, and folds in wash/treasury flow. The result routinely overstates real player volume by 5–10× or more. A casino "doing billions" on-chain may have a fraction of that in genuine deposits and withdrawals. This is the single biggest reason on-chain casino stats are widely misread.</p>` },
      { h: 'How to spot it yourself', body: `<p>Two tells, both checkable on a block explorer. <strong>Average transfer size:</strong> real player deposits/withdrawals run roughly $2–12K; a wallet averaging $50K, $400K or more per transfer is moving treasury, not taking player flow. <strong>Counterparty concentration:</strong> genuine casinos touch thousands of distinct addresses; volume concentrated in a handful of counterparties cycling similar amounts is a wash/treasury signature. When "volume" dwarfs the brand's actual reputation, that mismatch is itself the flag.</p>` },
      { h: 'How WCOIN handles it', body: `<p>We exclude it. A precomputed internal-flow flag drops same-operator transfers and double counts; operators whose pattern trips our thresholds are flagged <code>volumeSuspect</code>, shown as <strong>"Under review"</strong>, ranked by trust only, and kept out of every volume leaderboard. The exact thresholds are public (avg-transfer ceiling $50K/tx, per-counterparty ceiling $50K, above a $50M floor) and the reasons are machine-readable — see <a href="/guide/how-on-chain-casino-tracking-works">how tracking works</a> and the <a href="https://github.com/chenny2023/wcoin-casino-data" rel="noopener" target="_blank">open-data repo</a>.</p>` },
      { h: 'Why it matters to you', body: `<p>Inflated volume isn't just a vanity metric — players use "biggest / most active" as a trust proxy, and manufactured activity turns that instinct into a trap. A casino padding its numbers is telling you something about how it markets. Rank operators by <a href="/rankings/trust">independent trust</a> and <a href="/proof-of-reserves">verifiable reserves</a>, not by a volume figure that can be fabricated in an afternoon. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is wash trading at a crypto casino?', a: 'Moving funds back and forth between addresses the operator controls to manufacture the appearance of volume. Real tokens move but no genuine economic activity occurs — it exists to look bigger and rank higher on "volume" leaderboards.' },
      { q: 'Why is a crypto casino\'s on-chain volume so high?', a: 'Because raw "volume" usually includes internal hot-wallet churn, casino-to-casino double counts, treasury movement and wash trading — not just player flow. This routinely overstates real activity by 5–10× or more.' },
      { q: 'How can I tell if a casino\'s volume is real?', a: 'Check average transfer size (real player flow is ~$2–12K; $50K+ signals treasury/wash) and counterparty spread (genuine casinos touch thousands of addresses; concentration in a few is a red flag). If volume dwarfs the brand\'s reputation, be sceptical.' },
      { q: 'Does WCOIN remove wash-traded volume?', a: 'Yes. Internal churn and double counts are excluded via a precomputed flag, and operators with anomalous patterns are marked "Under review" and kept out of all volume rankings. The thresholds and reasons are published for audit.' },
    ],
    related: `See <a href="/guide/how-on-chain-casino-tracking-works">how on-chain tracking works</a>, <a href="/guide/how-to-verify-a-crypto-casino">verify a casino on-chain</a>, and <a href="/highest-volume-crypto-casinos">verified-volume ranking</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-hot-wallet-vs-cold-wallet', 'guide', guidePage({
    path: '/guide/crypto-casino-hot-wallet-vs-cold-wallet', h1: 'Crypto casino hot wallet vs cold wallet',
    title: `Crypto Casino Hot Wallet vs Cold Wallet Explained (${YEAR}) | WCOIN.CASINO`,
    description: `What hot wallets, cold wallets and deposit addresses are at a crypto casino, how each behaves on-chain, and what the split tells you about an operator's security and solvency.`,
    intro: `Crypto casinos hold player funds across different wallet types, each with a job. Understanding hot vs cold wallets tells you a lot about how an operator manages — and secures — money.`,
    sections: [
      { h: 'The three wallet roles', body: `<p>A crypto casino's on-chain footprint is mostly three kinds of address. <strong>Deposit addresses</strong> — often one per player — receive incoming funds and are swept into central wallets. <strong>Hot wallets</strong> — the operating cashier — process the constant churn of deposits and withdrawals; they're online and busy by design. <strong>Cold wallets</strong> — offline storage — hold reserves that don't need to move daily, kept off the internet for security.</p>` },
      { h: 'How each behaves on-chain', body: `<p>The roles have distinct on-chain signatures. A <strong>hot wallet</strong> shows high-frequency, two-way flow to many distinct counterparties. A <strong>deposit address</strong> shows inflow from a player followed by an outward sweep to the operator's own wallets. A <strong>cold wallet</strong> shows large balances and rare movement. We infer these roles automatically from each wallet's own transfer behaviour — the exact rules are published in the <a href="https://github.com/chenny2023/wcoin-casino-data/blob/main/DATA_DICTIONARY.md" rel="noopener" target="_blank">open-data dictionary</a>.</p>` },
      { h: 'Why the split matters for security', body: `<p>Keeping most reserves in cold storage is basic operational hygiene: hot wallets are the attack surface, so a well-run operator keeps only working liquidity hot and the bulk cold. Casinos have been hacked precisely because too much sat in an online hot wallet. A visible cold-storage pattern (large stable balances moving rarely) is a mild positive signal; everything sitting in a single hot wallet is a mild risk signal.</p>` },
      { h: 'What it tells you about solvency', body: `<p>When we read an operator's <a href="/proof-of-reserves">reserves</a>, we sum balances across all its mapped wallets — hot and cold — because both back player withdrawals. The useful read isn't any single wallet but the total relative to withdrawal flow, tracked over time. A healthy operator's reserves comfortably exceed near-term outflow; reserves that only appear in a hot wallet right before payouts and drain afterwards are a dress-up pattern (see <a href="/guide/proof-of-reserves-vs-proof-of-custody">reserves vs custody</a>).</p>` },
      { h: 'Limits of reading wallet roles', body: `<p>Role inference is behavioural, not certified: a wallet that changes how it's used will get reclassified, and genuinely ambiguous wallets are left unlabelled rather than guessed. An operator can also hold reserves in wallets we haven't mapped, or off-chain entirely. So wallet roles are a useful lens on operations and security, not a complete balance sheet — pair them with the reserve trend and independent trust signals.</p>` },
      { h: 'How to check it yourself', body: `<p>Take a casino's known addresses (we publish the mapped set) and open them on a block explorer: a busy address with constant two-way flow is a hot wallet; a large, quiet balance is likely cold storage. Watch whether reserves stay stable or only appear around withdrawals. Our <a href="/guide/how-to-verify-a-crypto-casino">verification guide</a> walks through reading the wallets step by step. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is a hot wallet at a crypto casino?', a: 'The online operating wallet (the cashier) that processes the constant flow of deposits and withdrawals. It shows high-frequency, two-way on-chain activity to many counterparties, and is the operator\'s main attack surface.' },
      { q: 'What is a cold wallet?', a: 'Offline storage holding reserves that don\'t need to move daily, kept off the internet for security. On-chain it shows large balances that move rarely. Keeping most reserves cold is basic operational hygiene for a casino.' },
      { q: 'Does the hot/cold split affect solvency?', a: 'Reserves are summed across both — both back withdrawals. What matters is total reserves relative to withdrawal flow over time, not any single wallet. Reserves that only appear in a hot wallet around payout times and then drain are a warning sign.' },
      { q: 'Can I tell which casino wallet is which?', a: 'Often, from behaviour: a busy two-way address is a hot wallet; a large quiet balance is likely cold. We infer roles automatically from each wallet\'s transfers and publish the rules, though genuinely ambiguous wallets are left unlabelled rather than guessed.' },
    ],
    related: `See <a href="/guide/how-to-verify-a-crypto-casino">verify a casino on-chain</a>, <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves explained</a>, and <a href="/proof-of-reserves">reserves hub</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-tokens-explained', 'guide', guidePage({
    path: '/guide/crypto-casino-tokens-explained', h1: 'Crypto casino tokens, explained',
    title: `Crypto Casino Tokens Explained — Rewards, Buyback & Risk (${YEAR}) | WCOIN.CASINO`,
    description: `Why crypto casinos issue their own tokens, how revenue-share and buyback-and-burn models work, the risks of holding a casino token, and what the on-chain data does and doesn't tell you.`,
    intro: `Many crypto casinos issue their own token — for rewards, revenue share, or fundraising. Here's how these tokens work, the buyback-and-burn model, and the real risks of holding one.`,
    sections: [
      { h: 'Why casinos launch a token', body: `<p>A native token serves several ends at once: it <strong>rewards and locks in players</strong> (stake it for VIP perks, rakeback boosts, or a cut of revenue), it <strong>raises capital</strong> (selling tokens funds growth without traditional investors), and it <strong>markets the brand</strong> (a tradable token creates a community with financial upside in the casino's success). The best-known examples tie the token's value to the casino's actual revenue.</p>` },
      { h: 'Revenue share and buyback-and-burn', body: `<p>The headline model is <strong>buyback-and-burn</strong>: the operator uses a share of gaming revenue to buy its own token on the open market and permanently destroy ("burn") it, reducing supply. If revenue and burns are real and sustained, holders benefit from a shrinking supply against ongoing demand. Some tokens instead <strong>distribute</strong> revenue directly to stakers. Either way, the token's value case rests on the casino generating genuine revenue — which is exactly what independent on-chain data helps sanity-check.</p>` },
      { h: 'The risks of holding a casino token', body: `<p>These are high-risk assets. The token's value depends on the operator staying solvent, honest and popular — <strong>operator risk you can't diversify away</strong>. If the casino declines, gets hacked, exit-scams, or simply stops buying back, the token can collapse. Tokenomics can be changed by the team; "burns" can be paused; and a token gives you exposure to the casino's fortunes without the protections of equity. Treat it as a speculative bet on the operator, not a yield product.</p>` },
      { h: 'What the on-chain data shows — and doesn\'t', body: `<p>On-chain you can often verify a token's price, market cap, trading volume and whether buyback/burn transactions are actually happening. That's a real check against marketing claims. What you <em>can't</em> read from the token alone is whether the operator will keep paying player withdrawals — token health and casino solvency are related but separate. A pumping token doesn't make a casino safe to deposit at; check <a href="/proof-of-reserves">reserves</a> and <a href="/rankings/trust">trust</a> for that.</p>` },
      { h: 'Token price ≠ casino safety', body: `<p>This is the key confusion to avoid. A casino token going up reflects speculation on the operator's future; it says nothing about whether your <em>deposit</em> is safe to withdraw today. Conversely, a good, solvent casino might have no token at all. Keep the two questions separate: "should I hold this token?" (a speculative investment decision) and "is my deposit safe here?" (a solvency and payout question answered by reserves, flow and complaints).</p>` },
      { h: 'A note on investment', body: `<p>We publish casino-token data (price, market cap, buyback flags) as part of the on-chain picture, but nothing here is investment advice, and we don't rank casinos by their token. Crypto tokens are volatile and can go to zero. If you choose to hold one, size it as speculative capital you can afford to lose. 18+; <a href="/responsible-gambling">gamble responsibly</a> — and treat token speculation with the same caution.</p>` },
    ],
    faqs: [
      { q: 'Why do crypto casinos have their own tokens?', a: 'To reward and retain players (staking for VIP perks or revenue share), to raise capital, and to build a community with financial upside in the brand. Many tie the token\'s value to the casino\'s revenue via buyback-and-burn.' },
      { q: 'What is buyback-and-burn?', a: 'The operator uses a share of gaming revenue to buy its own token on the market and permanently destroy it, shrinking supply. If revenue and burns are real and sustained, holders benefit — but it all depends on the casino generating genuine revenue.' },
      { q: 'Are crypto casino tokens a good investment?', a: 'They are high-risk and speculative. Value depends on the operator staying solvent, honest and popular — undiversifiable operator risk. Tokenomics can change and burns can pause. Nothing here is investment advice; only hold what you can afford to lose.' },
      { q: 'Does a rising casino token mean the casino is safe?', a: 'No. Token price reflects speculation on the operator\'s future; it says nothing about whether your deposit is safe to withdraw today. Judge safety separately, from verifiable reserves, flow and complaint trends.' },
    ],
    related: `See <a href="/data/crypto-casino-tokens">casino token data</a>, <a href="/guide/are-crypto-casinos-safe">are crypto casinos safe?</a>, and <a href="/proof-of-reserves">proof-of-reserves hub</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-vip-and-rakeback-explained', 'guide', guidePage({
    path: '/guide/crypto-casino-vip-and-rakeback-explained', h1: 'Crypto casino VIP programs & rakeback, explained',
    title: `Crypto Casino VIP Programs & Rakeback Explained (${YEAR}) | WCOIN.CASINO`,
    description: `How crypto casino VIP tiers, rakeback and cashback actually work, how to calculate their real value against the house edge, and why loyalty perks should never override the solvency checks.`,
    intro: `VIP programs and rakeback are the main retention tools at crypto casinos — and, unlike big bonus headlines, some genuinely return value. Here's how they work and how to weigh them.`,
    sections: [
      { h: 'How VIP tiers work', body: `<p>Most crypto casinos run a loyalty ladder: the more you wager, the higher your tier, and the better your perks — higher rakeback, level-up bonuses, a personal "VIP host", faster withdrawals, and access to promotions. Tiers are driven by wagered volume, not deposits, so they reward <em>activity</em> against the house edge. The perks are real, but so is the incentive design: VIP programs exist to increase how much you play.</p>` },
      { h: 'Rakeback and cashback — the honest value', body: `<p><strong>Rakeback</strong> returns a percentage of the house edge you generate (the "rake") back to you; <strong>cashback</strong> returns a percentage of net losses. Because these have few strings compared to a match bonus, they're often the most genuinely valuable perk — they don't lock funds behind wagering requirements. A meaningful rakeback rate materially reduces the effective house edge over time, though it never flips a negative-edge game positive.</p>` },
      { h: 'Calculating the real value', body: `<p>Do the maths, not the vibe. If a game has a 3% house edge and you get 10% rakeback, your effective edge becomes roughly 2.7% — a real but modest improvement. Compare that with a "200% bonus" carrying 50× wagering, whose expected value can be negative once you account for the <a href="/guide/crypto-casino-bonuses-explained">playthrough and game weighting</a>. Low-wagering rakeback usually beats a big sticky bonus. Read the terms: some rakeback is instant and cashable, some is itself locked behind wagering.</p>` },
      { h: 'The retention trap', body: `<p>VIP status is designed to feel like a relationship — a host who checks in, tailored reloads, "we appreciate you" messaging. That's precisely when responsible-gambling discipline matters most: perks that reward more play can accelerate losses, and a VIP host is a salesperson, not a friend. If a program is nudging you to deposit more than you planned, that's the signal to step back and use <a href="/guide/crypto-casino-self-exclusion-and-limits">deposit limits</a>.</p>` },
      { h: 'Loyalty never overrides solvency', body: `<p>The most important point: a generous VIP program at an operator that won't pay is worthless — worse, it encourages you to concentrate funds there. Perks tell you how a casino <em>markets</em>, not whether it's solvent. Before chasing a tier, confirm the operator has verifiable <a href="/proof-of-reserves">on-chain reserves</a> and a clean payout record. Loyalty value is a tiebreaker between safe operators, never a reason to trust an unsafe one.</p>` },
      { h: 'Getting the most from a program safely', body: `<p>If you play anyway: prefer <strong>rakeback/cashback over match bonuses</strong>, read whether rewards are cashable or wagering-locked, don't chase a tier by increasing stakes, and treat the VIP host's suggestions with scepticism. Set a budget first and let perks be a bonus on top — never the reason you deposit more. 18+ only; <a href="/responsible-gambling">gamble responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What is rakeback at a crypto casino?', a: 'A return of a percentage of the house edge ("rake") you generate through play. It has few strings compared to a match bonus, so it\'s often the most genuinely valuable perk — it reduces your effective house edge, though it never makes a negative-edge game positive.' },
      { q: 'Is rakeback better than a deposit bonus?', a: 'Usually, for most players. Low-wagering rakeback and cashback return real value without locking funds behind high wagering requirements, whereas big match bonuses often carry 40–60× playthrough with negative expected value. Always read whether the rakeback itself is cashable or wagering-locked.' },
      { q: 'How do crypto casino VIP programs work?', a: 'A loyalty ladder driven by how much you wager: higher tiers unlock better rakeback, level-up bonuses, a VIP host and faster withdrawals. The perks are real, but the design rewards more play against the house edge, so treat a VIP host as a salesperson.' },
      { q: 'Should VIP perks affect where I deposit?', a: 'Only as a tiebreaker between operators you\'ve already confirmed are safe. A great program at a casino that won\'t pay is worthless. Verify reserves and payout record first; let loyalty value break ties, never override solvency.' },
    ],
    related: `See <a href="/guide/crypto-casino-bonuses-explained">bonuses & wagering</a>, <a href="/guide/crypto-casino-rtp-and-house-edge">RTP & house edge</a>, and <a href="/guide/crypto-casino-self-exclusion-and-limits">limits & self-exclusion</a>.`,
  }), 'featured_core')
  add('/guide/how-crypto-casino-affiliate-marketing-works', 'guide', guidePage({
    path: '/guide/how-crypto-casino-affiliate-marketing-works', h1: 'How crypto casino affiliate marketing works',
    title: `How Crypto Casino Affiliate Marketing Works — And Why It Biases Reviews (${YEAR}) | WCOIN.CASINO`,
    description: `How crypto casino affiliate deals, revenue share and streamer promotion work, why they bias "best casino" rankings, and how to find recommendations that aren't paid placements.`,
    intro: `Most crypto casino "reviews", top-10 lists and streamer promos are paid marketing. Understanding how affiliate deals work is the best defence against being sold an unsafe operator.`,
    sections: [
      { h: 'How affiliate deals work', body: `<p>Affiliates send players to a casino via a tracked link and get paid for it. Two common structures: <strong>revenue share</strong> — the affiliate earns an ongoing cut (often 30–50%) of the losses of every player they refer, for life — and <strong>CPA</strong> — a one-off payment per depositing player. Revenue share is the big one: it means a "reviewer" earns more the more the players they sent you <em>lose</em>. That's the incentive baked into most casino content.</p>` },
      { h: 'Why "best casino" lists are biased', body: `<p>When a site earns revenue share, its ranking has a structural conflict: the operators it places highest are frequently the ones paying the best affiliate rates, not the safest. "Top 10 crypto casinos", "editor's choice" and glowing reviews are often ad inventory sold to the highest bidder. This isn't a conspiracy — it's the business model of most gambling-affiliate sites, and it's usually disclosed only in fine print, if at all.</p>` },
      { h: 'Streamers are affiliates too', body: `<p>Gambling streamers on Kick, Twitch and YouTube almost always play under an affiliate or sponsorship deal with the casino they feature — sometimes with balances funded by the operator. A big win on stream is compelling marketing, but the streamer is paid to make you deposit, and their outcomes aren't yours. We track streamer→casino affiliations precisely so you can cross-check a promotion against the casino's actual <a href="/proof-of-reserves">on-chain reserves</a> and <a href="/rankings/trust">trust</a> — see the <a href="/streamers">streamer index</a>.</p>` },
      { h: 'How to spot paid placement', body: `<p>Signals a "recommendation" is an ad: prominent "Play now" / "Claim bonus" buttons with tracked links; a suspiciously positive tone with no downsides; ranking changes that follow promotions rather than performance; bonus codes that only work through that link; and affiliate disclosures buried at the page bottom. None of these mean the casino is bad — but they mean the recommendation isn't independent, so weight it accordingly.</p>` },
      { h: 'How to find real signals', body: `<p>Lean on sources that <em>can't</em> be bought: an operator's <strong>verifiable on-chain reserves and flow</strong> (a wallet balance doesn't care who's paid), <strong>independent complaint data</strong> (resolution rates), and rankings driven by data rather than payouts. This is exactly why we don't take affiliate placement for rankings and publish our <a href="https://github.com/chenny2023/wcoin-casino-data" rel="noopener" target="_blank">full dataset and method</a> — see <a href="/guide/why-on-chain-data-beats-complaint-boards">why on-chain data beats complaint boards</a>.</p>` },
      { h: 'What this means for you', body: `<p>Assume any casino recommendation is paid until proven otherwise, then verify the operator yourself on data that can't be bought. Use affiliate content for discovery if you like — but run the <a href="/guide/predict-casino-payout-risk-before-depositing">payout-risk self-check</a> before depositing, regardless of how glowing the review or how big the streamer's win. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'How do crypto casino affiliates make money?', a: 'Via revenue share (an ongoing cut, often 30–50%, of the losses of every player they refer) or CPA (a one-off payment per depositing player). Revenue share means a "reviewer" earns more the more the players they sent you lose.' },
      { q: 'Are crypto casino review sites biased?', a: 'Most have a structural conflict: they earn affiliate revenue, so the operators they rank highest are often those paying the best rates, not the safest. Treat "top 10" lists and glowing reviews as ad inventory unless the site demonstrably takes no affiliate placement.' },
      { q: 'Do gambling streamers get paid to promote casinos?', a: 'Almost always — via affiliate or sponsorship deals, sometimes with operator-funded balances. A big win on stream is marketing; the streamer is paid to make you deposit, and their results aren\'t yours. Cross-check any promotion against the casino\'s real on-chain data.' },
      { q: 'How do I find recommendations that aren\'t ads?', a: 'Rely on signals that can\'t be bought: verifiable on-chain reserves and flow, independent complaint-resolution data, and rankings driven by data rather than payouts. Verify the operator yourself before depositing, regardless of how positive a review is.' },
    ],
    related: `See <a href="/guide/why-on-chain-data-beats-complaint-boards">why on-chain data beats complaint boards</a>, the <a href="/streamers">streamer index</a>, and <a href="/rankings/trust">trust ranking</a>.`,
  }), 'featured_core')
  add('/guide/how-to-read-crypto-casino-reserves', 'guide', guidePage({
    path: '/guide/how-to-read-crypto-casino-reserves', h1: 'How to read a crypto casino\'s on-chain reserves',
    title: `How to Read a Crypto Casino's On-Chain Reserves (${YEAR}) | WCOIN.CASINO`,
    description: `A practical guide to reading a crypto casino's reserves: what the number means, how to weigh it against withdrawal flow and coverage, spotting temporary top-ups, and the trend that matters most.`,
    intro: `A reserve figure is only useful if you read it correctly. Here's how to interpret a crypto casino's on-chain reserves without being misled by a big number.`,
    sections: [
      { h: 'What the reserve number is', body: `<p>A crypto casino's reserves are the summed balances of stablecoins and major assets across the wallets attributed to it, on every chain we track, priced in USD. Because these are public wallet balances, the figure is independently verifiable — you can open the addresses on a block explorer and add them up yourself. It answers "how much does the operator hold right now?" — a real, checkable number, not a marketing claim.</p>` },
      { h: 'Read it against flow, not in isolation', body: `<p>A big reserve number means little on its own — $50M is reassuring for a small operator and thin for a huge one. The useful read is <strong>reserves relative to withdrawal outflow</strong>: does the operator hold enough to comfortably cover recent and near-term withdrawals? Our withdrawal-coverage ratio (reserves ÷ 7-day outflow) expresses this as "weeks of cover". Reserves that dwarf outflow are healthy; reserves that barely cover it, or fall while deposits keep arriving, are a warning.</p>` },
      { h: 'The trend beats the snapshot', body: `<p>The single most important habit: read reserves <strong>over time</strong>, not as a single moment. A snapshot can be dressed up — funds moved in temporarily to look healthy for a screenshot. A <em>trend</em> exposes that: a balance that spikes right before known payout periods and drains afterwards is a dress-up pattern, while a stable or rising trend is genuine strength. Our per-operator pages show the reserve trend for exactly this reason.</p>` },
      { h: 'Understand coverage', body: `<p>Every reserve figure carries a <strong>coverage level</strong> — how completely we've mapped that operator's wallets. A large number at "low coverage" means "at least this much" (we may have mapped only part of the footprint), not a total. We show coverage as a level rather than a false-precision percentage. Don't read a low-coverage figure as the operator's full holdings, and don't read a high figure as proof of solvency — see <a href="/guide/proof-of-reserves-vs-proof-of-custody">reserves vs custody</a>.</p>` },
      { h: 'What reserves can\'t tell you', body: `<p>Reserves show <strong>assets, not liabilities</strong>. They can't reveal how much the operator owes all its players (that lives in a private database), whether the operator exclusively controls the wallets, or off-chain holdings and debts. So healthy reserves are a strong positive signal, never a solvency guarantee. Pair them with <a href="/data/crypto-casino-net-flow">net flow</a>, independent <a href="/rankings/trust">trust ratings</a> and complaint trends before drawing a conclusion.</p>` },
      { h: 'A quick reading checklist', body: `<p>When you look at a casino's reserves: (1) is the figure large <em>relative to its withdrawal flow</em>, not just in absolute terms? (2) is the trend stable or rising, rather than spiking around payouts? (3) what's the coverage level — is this a floor or a fair total? (4) does the on-chain picture agree with the operator's reputation and complaints? Agreement across these is reassuring; disagreement is your cue to dig deeper. Check any operator on the <a href="/proof-of-reserves">proof-of-reserves hub</a>. 18+; <a href="/responsible-gambling">play responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'What do a crypto casino\'s reserves tell me?', a: 'How much the operator holds on-chain right now, summed across its mapped wallets and priced in USD — a publicly verifiable number. It\'s a strong solvency signal when read against withdrawal flow and over time, but it shows assets, not liabilities, so it never proves full solvency.' },
      { q: 'Is a bigger reserve number always better?', a: 'Not in isolation. What matters is reserves relative to withdrawal outflow (weeks of cover) and the trend over time. A big number at low wallet coverage is a floor, not a total, and reserves that only appear around payouts are a dress-up pattern.' },
      { q: 'What is reserve coverage?', a: 'How completely we\'ve mapped an operator\'s wallets. A figure at low coverage means "at least this much" rather than a total. We show it as a level, not a percentage, to avoid implying false precision.' },
      { q: 'Can reserves prove a casino is solvent?', a: 'No — they show assets, not the total owed to players, and can be temporarily funded. Read them as a trend against withdrawal flow and pair them with net flow, trust ratings and complaint history. They\'re a strong positive signal, not a guarantee.' },
    ],
    related: `See <a href="/guide/crypto-casino-proof-of-reserves">proof of reserves explained</a>, <a href="/guide/how-to-verify-a-crypto-casino">verify a casino on-chain</a>, and the <a href="/proof-of-reserves">reserves hub</a>.`,
  }), 'featured_core')
  add('/guide/crypto-casino-self-exclusion-and-limits', 'guide', guidePage({
    path: '/guide/crypto-casino-self-exclusion-and-limits', h1: 'Crypto casino limits & self-exclusion',
    title: `Crypto Casino Deposit Limits & Self-Exclusion — Staying in Control (${YEAR}) | WCOIN.CASINO`,
    description: `Practical responsible-gambling tools at crypto casinos: deposit and loss limits, cool-off, self-exclusion, and the extra steps that matter because crypto play has fewer built-in brakes.`,
    intro: `Crypto casinos are fast, always-open and low-friction — which makes staying in control harder, and the responsible-gambling tools more important. Here's what's available and how to use it.`,
    sections: [
      { h: 'Why crypto play needs more discipline', body: `<p>The same features that make crypto casinos convenient — instant deposits, 24/7 access, no bank in the loop, pseudonymity — also remove natural brakes on gambling. There's no card statement to jolt you, no bank declining a transfer, sometimes no identity check. Losses can compound quickly, and irreversible on-chain transactions mean there's no chargeback. That's why deliberately setting limits matters more here than at a traditional, more-regulated operator.</p>` },
      { h: 'Deposit, loss and wager limits', body: `<p>Most reputable operators let you set <strong>deposit limits</strong> (a cap per day/week/month), <strong>loss limits</strong>, <strong>wager limits</strong>, and <strong>session-time reminders</strong>. Set these when you're calm and thinking clearly, not mid-session. A good sign of a responsible operator is that these tools are easy to find and that <em>tightening</em> a limit takes effect immediately while <em>loosening</em> one has a cooling delay. If limits are buried or absent, that's a mark against the operator.</p>` },
      { h: 'Cool-off and self-exclusion', body: `<p><strong>Cool-off</strong> (or "take a break") locks your account for a short set period — a day to a few weeks. <strong>Self-exclusion</strong> is a longer or permanent block, from months to indefinite; a serious operator will honour it and not let you simply re-register to bypass it. Because crypto operators are often unregulated, self-exclusion enforcement varies — the strongest protection combines the operator's tools with the self-managed steps below.</p>` },
      { h: 'Self-managed brakes that always work', body: `<p>Don't rely only on the casino. Steps entirely within your control: <strong>keep gambling funds separate</strong> and only send what you've budgeted; <strong>withdraw winnings immediately</strong> rather than letting a balance ride; use device-level <strong>blocking tools</strong> (Gamban, or a browser/DNS blocklist) that stop you reaching gambling sites even when the operator won't; and, at the wallet level, don't keep large balances one click from a deposit. These work regardless of whether the operator cooperates.</p>` },
      { h: 'Recognising the warning signs', body: `<p>Signs it's time to use these tools: chasing losses with bigger bets, gambling with money meant for something else, hiding play, betting to escape stress, or a VIP host nudging you past your budget (see <a href="/guide/crypto-casino-vip-and-rakeback-explained">VIP programs</a>). Gambling should be entertainment you can afford; if it's stopped being that, the limits and blocks above are there to use — early, not after a big loss.</p>` },
      { h: 'Where to get help', body: `<p>If gambling is causing harm, free confidential support exists: <strong>GamCare</strong> and the National Gambling Helpline (UK), <strong>Gambling Therapy</strong> (international), <strong>Gamblers Anonymous</strong>, and <strong>1-800-GAMBLER</strong> (US). These are independent of any operator. See our <a href="/responsible-gambling">responsible gambling resources</a> for more. 18+ only — gambling should never be a way to make money or cope with problems.</p>` },
    ],
    faqs: [
      { q: 'Can I set deposit limits at a crypto casino?', a: 'At most reputable operators, yes — deposit, loss, wager and session-time limits. Set them when calm, not mid-session. A responsible operator makes them easy to find, applies tightening immediately, and delays loosening. Missing or buried limits are a mark against an operator.' },
      { q: 'Does self-exclusion work at crypto casinos?', a: 'A serious operator will honour a self-exclusion and block re-registration, but because many crypto casinos are unregulated, enforcement varies. Combine the operator\'s tools with self-managed brakes — device-level blockers, separating funds, withdrawing winnings promptly — which work regardless.' },
      { q: 'How do I stay in control gambling with crypto?', a: 'Budget and separate gambling funds, set deposit/loss limits, withdraw winnings immediately instead of letting a balance ride, use device-level blocking tools, and don\'t keep large balances one click from a deposit. Crypto\'s speed and irreversibility make deliberate brakes essential.' },
      { q: 'Where can I get help for gambling harm?', a: 'Free confidential support is available independent of any operator: GamCare and the National Gambling Helpline (UK), Gambling Therapy (international), Gamblers Anonymous, and 1-800-GAMBLER (US). See our responsible gambling page for more.' },
    ],
    related: `See <a href="/responsible-gambling">responsible gambling resources</a>, <a href="/guide/crypto-casino-vip-and-rakeback-explained">VIP & rakeback</a>, and <a href="/guide/are-crypto-casinos-safe">are crypto casinos safe?</a>`,
  }), 'featured_core')
  add('/guide/are-crypto-casino-winnings-taxable', 'guide', guidePage({
    path: '/guide/are-crypto-casino-winnings-taxable', h1: 'Are crypto casino winnings taxable?',
    title: `Are Crypto Casino Winnings Taxable? What to Know (${YEAR}) | WCOIN.CASINO`,
    description: `Whether crypto gambling winnings are taxable depends on your country and can involve both gambling tax and crypto capital-gains tax. A neutral overview of how it can work — general information, not tax advice.`,
    intro: `"Do I owe tax on crypto casino winnings?" has no single answer — it depends on where you live, and crypto adds a second layer most players miss. Here's a neutral overview. This is general information, not tax advice.`,
    sections: [
      { h: 'It depends entirely on your jurisdiction', body: `<p>Gambling-tax rules are set country by country. In some places gambling winnings are <strong>tax-free to the player</strong> (the operator is taxed instead — the UK is a common example); in others, winnings are <strong>taxable income</strong> and must be declared (the US treats gambling winnings as taxable). Some countries have specific thresholds or withholding. The only reliable answer is your local law — do not assume a rule you read for another country applies to you.</p>` },
      { h: 'The crypto layer most players miss', body: `<p>Even where gambling winnings themselves are tax-free, <strong>the crypto can be taxed separately</strong>. In many jurisdictions, disposing of cryptocurrency — selling it, swapping it, or spending it — is a capital-gains event based on how its value changed since you acquired it. So if you win crypto and later sell it higher, the <em>gain on the crypto</em> may be taxable even if the <em>winning</em> wasn't. Two potentially separate questions: is the gambling win taxable, and is the crypto disposal taxable?</p>` },
      { h: 'Why on-chain settlement matters for records', body: `<p>Crypto gambling is pseudonymous, not invisible — every deposit and withdrawal is a permanent public transaction. Tax authorities increasingly use chain-analysis tools, and funding from a KYC'd exchange links activity to identity. Practically, that means "it's crypto so no one will know" is a poor basis for a tax decision. On the upside, the public ledger also makes it straightforward to reconstruct your own transaction history for accurate reporting.</p>` },
      { h: 'Keeping records', body: `<p>Whatever your jurisdiction, good records make compliance far easier: the date, amount and USD value of each deposit and withdrawal, and the acquisition cost of crypto you later dispose of. Because it's all on-chain, you can export transactions from a block explorer or a crypto-tax tool. Keeping this as you go — rather than reconstructing it under deadline — is the single most useful habit.</p>` },
      { h: 'Get proper advice', body: `<p>Tax rules for both gambling and crypto are complex, change frequently, and vary enormously by country and even sub-jurisdiction. Nothing on this page is tax, legal or financial advice, and we can't tell you your liability. If real money is involved, consult a <strong>qualified tax professional in your country</strong> who understands both gambling and cryptocurrency. See also <a href="/guide/are-crypto-casinos-legal">are crypto casinos legal?</a> for the related jurisdiction question. 18+; <a href="/responsible-gambling">gamble responsibly</a>.</p>` },
    ],
    faqs: [
      { q: 'Are crypto casino winnings taxable?', a: 'It depends entirely on your country. Some jurisdictions make gambling winnings tax-free to the player (taxing the operator instead); others treat them as taxable income to declare. There is no universal answer — check your local law. This is general information, not tax advice.' },
      { q: 'Do I owe crypto tax on gambling winnings too?', a: 'Possibly, even where the gambling win itself is tax-free. Many jurisdictions treat disposing of crypto (selling, swapping, spending) as a capital-gains event, so a gain on the crypto you won may be taxable separately from the win. Two distinct questions apply.' },
      { q: 'Can tax authorities see my crypto gambling?', a: 'Crypto is pseudonymous, not invisible — deposits and withdrawals are permanent public transactions, authorities use chain-analysis tools, and exchange funding links activity to identity. "No one will know" is a poor basis for a tax decision, but the public ledger also makes accurate self-reporting easier.' },
      { q: 'What records should I keep?', a: 'The date, amount and USD value of each deposit and withdrawal, and the acquisition cost of crypto you later dispose of. You can export these from a block explorer or a crypto-tax tool. Keep records as you go, and consult a qualified tax professional in your country.' },
    ],
    related: `See <a href="/guide/are-crypto-casinos-legal">are crypto casinos legal?</a>, <a href="/guide/crypto-casino-kyc-and-anonymity">KYC & anonymity</a>, and <a href="/guide/what-is-a-crypto-casino">what is a crypto casino?</a>`,
  }), 'featured_core')
  add('/guide', 'guide', guidePage({
    path: '/guide', h1: 'Crypto casino guides',
    title: `Crypto Casino Guides — On-Chain Data, Reserves & Deposits (${YEAR}) | WCOIN.CASINO`,
    description: `Practical, data-backed guides to crypto casinos: proof of reserves, deposit currencies (USDT vs Bitcoin), how to verify an operator on-chain, and how to judge safety.`,
    intro: `Practical guides built on verifiable on-chain data — not affiliate marketing. Learn how to read reserves, choose a deposit currency, and check an operator yourself.`,
    sections: [
      { h: 'Getting started', body: `<p><a href="/guide/what-is-igaming">What is iGaming?</a> — the online gambling industry explained. <a href="/guide/what-is-a-crypto-casino">What is a crypto casino?</a> — how they work and differ from traditional ones. <a href="/guide/what-is-a-crypto-sportsbook">What is a crypto sportsbook?</a> — crypto sports betting and its unique risks. <a href="/guide/how-to-choose-a-crypto-casino">How to choose a crypto casino</a> — a data-driven checklist that puts solvency first.</p>` },
      { h: 'Safety & solvency', body: `<p><a href="/guide/are-crypto-casinos-safe">Are crypto casinos safe?</a> — the real risks and how to judge an operator. <a href="/guide/crypto-casino-red-flags">Red flags & warning signs</a>. <a href="/guide/how-to-spot-a-crypto-casino-that-wont-pay">How to spot a casino that won't pay</a> — a pre-deposit checklist. <a href="/guide/on-chain-signs-of-a-casino-exit-scam">On-chain signs of distress</a>. <a href="/guide/predict-casino-payout-risk-before-depositing">Predict payout risk before depositing</a>. <a href="/guide/crypto-casino-proof-of-reserves">Proof of reserves explained</a> &amp; <a href="/guide/proof-of-reserves-vs-proof-of-custody">vs proof of custody</a>. <a href="/guide/how-to-verify-a-crypto-casino">Verify a casino on-chain</a> yourself.</p>` },
      { h: 'Legal, KYC & comparison', body: `<p><a href="/guide/are-crypto-casinos-legal">Are crypto casinos legal?</a> — jurisdictions and licensing, explained neutrally. <a href="/guide/crypto-casino-kyc-and-anonymity">KYC & anonymity</a> — when verification kicks in and what "no-KYC" really means. <a href="/guide/crypto-casino-vs-online-casino">Crypto casino vs traditional online casino</a> — how the two models really differ.</p>` },
      { h: 'Deposits & currencies', body: `<p><a href="/guide/best-crypto-for-casino-deposits">Best crypto for casino deposits</a>. <a href="/guide/stablecoin-casinos-explained">Stablecoin casinos explained</a>. <a href="/guide/choosing-a-multi-crypto-casino-safely">Choosing a multi-crypto casino safely</a>. <a href="/guide/usdt-vs-bitcoin-casino-deposits">USDT vs Bitcoin</a>. <a href="/guide/crypto-casino-deposit-not-showing">Deposit not showing?</a> — troubleshoot on-chain. See the <a href="/data/crypto-casino-deposit-currencies">deposit currency breakdown</a>.</p>` },
      { h: 'Games & withdrawals', body: `<p><a href="/guide/crypto-casino-rtp-and-house-edge">RTP & house edge</a>. <a href="/guide/provably-fair-explained">Provably fair, explained</a>. <a href="/guide/crypto-casino-withdrawal-times">Withdrawal times</a>. <a href="/guide/stablecoin-casino-withdrawals-fast-and-safe">How fast & safe are stablecoin withdrawals</a>. <a href="/guide/crypto-casino-payout-speed-vs-support">Payout speed vs support quality</a>. <a href="/guide/world-cup-crypto-betting-safety">World Cup crypto betting safety</a>.</p>` },
      { h: 'Bonuses, VIP & terms', body: `<p><a href="/guide/crypto-casino-bonuses-explained">Bonuses & wagering requirements explained</a> — how to tell a real offer from a trap. <a href="/guide/crypto-casino-vip-and-rakeback-explained">VIP programs & rakeback</a> — which loyalty perks actually return value. <a href="/guide/crypto-casino-tokens-explained">Crypto casino tokens explained</a> — buyback-and-burn and the risks. <a href="/guide/crypto-gambling-glossary">Crypto gambling glossary</a> — the key terms in plain English.</p>` },
      { h: 'Staying in control & taxes', body: `<p><a href="/guide/crypto-casino-self-exclusion-and-limits">Limits & self-exclusion</a> — the responsible-gambling tools and self-managed brakes. <a href="/guide/are-crypto-casino-winnings-taxable">Are winnings taxable?</a> — a neutral overview (not tax advice). <a href="/guide/how-crypto-casino-affiliate-marketing-works">How affiliate marketing works</a> — why most "reviews" are paid.</p>` },
      { h: 'How our data works', body: `<p><a href="/guide/how-on-chain-casino-tracking-works">How on-chain casino tracking works</a> — how we read deposits, withdrawals and reserves from public blockchains. <a href="/guide/wash-trading-in-crypto-casinos-explained">Wash trading explained</a> — why raw volume is inflated. <a href="/guide/how-to-read-crypto-casino-reserves">How to read a casino's reserves</a> — interpret the number correctly. <a href="/guide/crypto-casino-hot-wallet-vs-cold-wallet">Hot wallet vs cold wallet</a> — what the split reveals. <a href="/guide/why-on-chain-data-beats-complaint-boards">On-chain data vs complaint boards</a> — why proactive verification beats reactive review.</p>` },
    ],
    related: `Explore the <a href="/best-crypto-casinos">best crypto casinos</a> ranking and the daily <a href="/daily">market report</a>.`,
  }), 'featured_core')

  add('/risk', 'risk', riskIndexPage(recentRiskEvents(80)), 'featured_core') // neutral risk registry
  add('/proof-of-reserves', 'reserves', reservesHubPage(onchainBrands, slugOfBrand), 'featured_core') // on-chain moat: PoR guide + verified list
  // E-E-A-T + YMYL compliance pages (always indexable; linked from every page footer)
  add('/about', 'about', aboutPage(), 'featured_core')
  add('/whitepaper', 'about', whitepaperPage(), 'featured_core')
  add('/responsible-gambling', 'about', responsibleGamblingPage(), 'featured_core')
  add('/insights', 'insights', insightsIndexPage(snaps), 'featured_core')
  add('/submit/casino', 'submit', submitPage('casino'), 'featured_core') // §5.3
  add('/submit/kol', 'submit', submitPage('kol'), 'featured_core')
  if (unattributed.length) add('/rankings/unattributed-flow', 'rankings', unattributedFlowPage(unattributed))
  await yieldLoop()
  // chains
  for (const cs of chainSet) if (cs) add(`/chains/${cs}`, 'chains', chainPage(cs, onchainBrands, slugOfBrand))
  await yieldLoop()
  // high-intent comparison pages ("X vs Y") — top-K strongest operators, all pairs
  for (let i = 0; i < comparePairs.length; i++) {
    const p = comparePairs[i]
    add(`/compare/${p.slugA}-vs-${p.slugB}`, 'compare', comparePage(p.a, p.b, p.slugA, p.slugB))
    if (i % 15 === 14) await yieldLoop()
  }
  // best-on-chain shortlists (trust-ranked) — featured_core (high-value evergreen)
  for (const g of chainBestGroups) add(`/rankings/best-on-${g.chain}`, 'rankings', bestOnChainPage(g.chain, g.entries), 'featured_core')
  await yieldLoop()
  // "{brand} alternatives" pages — high commercial intent. Emitted from altByKey
  // (computed up-front so casino profiles could link into them); ranked by blended
  // trust (never volume), only for targets with ≥4 shared-chain alternatives.
  let altN = 0
  for (const { target, slug, alts } of altByKey.values()) {
    add(`/${slug}-alternatives`, 'rankings', alternativesPage(target, slug, alts), 'featured_core')
    if (++altN % 10 === 0) await yieldLoop()
  }
  await yieldLoop()
  // "{chainA} vs {chainB} for crypto casinos" — data-led chain settlement comparisons.
  // Per-chain stats (operators + 7d external settlement) from byChainView; curated set
  // of the most-searched chain pairs, gated on ≥5 tracked operators BOTH sides so no
  // page is thin. Canonical: cslug order is fixed by the curated list.
  const chainStat = new Map<string, { cslug: string; name: string; ops: number; settled: number }>()
  for (const [chain, m] of byChainView) {
    const cslug = slugify(chain)
    let ops = 0
    let settled = 0
    for (const [v, val] of m) if (val > 0 && dataConfidence(v) !== 'low') { ops++; settled += val }
    chainStat.set(cslug, { cslug, name: chainName(chain), ops, settled })
  }
  const CHAIN_PAIRS: [string, string][] = [
    ['eth', 'tron'], ['tron', 'bsc'], ['eth', 'sol'], ['tron', 'sol'],
    ['base', 'arb'], ['eth', 'base'], ['eth', 'polygon'], ['btc', 'eth'],
  ]
  for (const [x, y] of CHAIN_PAIRS) {
    const sa = chainStat.get(x)
    const sb = chainStat.get(y)
    if (!sa || !sb || sa.ops < 5 || sb.ops < 5 || !CHAIN_FACTS[x] || !CHAIN_FACTS[y]) continue
    add(`/${x}-vs-${y}-casinos`, 'rankings', chainVsChainPage(sa, sb), 'featured_core')
  }
  await yieldLoop()
  // daily report archive (prev = older, next = newer)
  snaps.forEach((s, i) => {
    const next = i > 0 ? snaps[i - 1].snapshot_date : null // newer
    const prev = i < snaps.length - 1 ? snaps[i + 1].snapshot_date : null // older
    add(`/reports/daily/${s.snapshot_date}`, 'report', reportPage(s, prev, next))
  })
  // weekly reports — group daily snapshots by ISO week; one evergreen page per week
  // with ≥3 covered days (prev/next link only to other generated weeks).
  const weeks = new Map<string, any[]>()
  for (const s of snaps) {
    const k = isoWeek(s.snapshot_date).key
    weeks.set(k, [...(weeks.get(k) ?? []), s])
  }
  const weekKeys = [...weeks.keys()].sort()
  const has = (k: string) => (weeks.get(k)?.length ?? 0) >= 3
  weekKeys.forEach((key, idx) => {
    if (!has(key)) return
    const days = (weeks.get(key) ?? []).slice().sort((a, b) => (a.snapshot_date < b.snapshot_date ? -1 : 1))
    const prev = idx > 0 && has(weekKeys[idx - 1]) ? weekKeys[idx - 1] : null
    const next = idx < weekKeys.length - 1 && has(weekKeys[idx + 1]) ? weekKeys[idx + 1] : null
    add(`/reports/weekly/${key}`, 'report', weeklyReportPage(isoWeek(days[0].snapshot_date), days, prev, next))
  })
  await yieldLoop()
  // methodology
  for (const topic of Object.keys(METHODOLOGY)) add(`/methodology/${topic}`, 'methodology', methodologyPage(topic)!)
  await yieldLoop()

  // crypto-casino streamers — public SSR (the data used to be login-only). Index page
  // + per-streamer pages for the better-followed ones (thin-content guard), each
  // cross-linked to the on-chain data of the casino they promote.
  try {
    const streamers = db
      .prepare('SELECT id, handle, platform, viewers, live, followers, affiliation, game, thumbnail, bio, socials, verified, since FROM streamers ORDER BY followers DESC LIMIT 100')
      .all() as any[]
    if (streamers.length) {
      add('/streamers', 'streamers', streamersIndexPage(streamers), 'featured_core')
      const casinoByNorm = new Map<string, CasinoView>()
      for (const v of ranked) casinoByNorm.set(brandKey(v.name), v)
      for (const s of streamers) {
        if ((s.followers ?? 0) < 5000) continue // skip thin pages
        const v = s.affiliation ? casinoByNorm.get(brandKey(String(s.affiliation))) : undefined
        const aff = v
          ? { name: v.name, slug: slugOfView(v), vol7d: v.onchain?.volume7d ?? 0, volSuspect: !!v.onchain?.volumeSuspect, reserves: v.onchain?.reserves ?? 0, trust: blendedTrust(v)?.score ?? null }
          : null
        add(`/streamer/${streamerSlug(s)}`, 'streamers', streamerPage(s, aff))
      }
    }
  } catch (e) {
    console.warn('[seo] streamer pages skipped:', (e as Error).message)
  }
  await yieldLoop()

  // ── Phase 2: WRITE in small chunked transactions, yielding between chunks ───
  // 20 (not 50): each write transaction touches the multi-GB DB, and on a cold-cache
  // boot a 50-page transaction was part of the long SEO-regen freeze. Smaller chunks
  // keep the event loop responsive as the page set grows.
  const CHUNK = 20
  for (let i = 0; i < built.length; i += CHUNK) {
    const slice = built.slice(i, i + CHUNK)
    db.transaction(() => {
      for (const b of slice) upsert.run({ path: b.path, kind: b.kind, title: b.pg.title, description: b.pg.description, html: b.pg.html, hash: contentHash(b.pg.html), now, lifecycle: b.lifecycle })
    })()
    await yieldLoop()
  }
  for (let i = 0; i < enrich.length; i += CHUNK) {
    const slice = enrich.slice(i, i + CHUNK)
    db.transaction(() => {
      for (const e of slice) enqueueEnrich.run(e)
    })()
    await yieldLoop()
  }
  const n = built.length

  // GC: drop any stored page not regenerated this run (stale casino slugs, etc.) —
  // chunked + yielded too, so a large prune can't freeze the loop either.
  const stale = (db.prepare('SELECT path FROM seo_page').all() as { path: string }[]).filter((r) => !written.has(r.path))
  if (stale.length) {
    const del = db.prepare('DELETE FROM seo_page WHERE path=?')
    for (let i = 0; i < stale.length; i += CHUNK) {
      const slice = stale.slice(i, i + CHUNK)
      db.transaction(() => slice.forEach((r) => del.run(r.path)))()
      await yieldLoop()
    }
  }
  console.log(`[seo] rebuilt ${n} pages (${cap_count(ranked)} casinos, ${snaps.length} reports, ${stale.length} pruned)`)

  // data-quality gate — verify the public surface didn't regress on the 1.0 rules
  try {
    const dq = await runDataQualityChecks()
    const fails = dq.filter((d) => d.status !== 'pass')
    if (fails.length) console.warn(`[dq] ${fails.length}/${dq.length} FAILED — ${fails.map((f) => `${f.check}: ${f.detail}`).join(' | ')}`)
    else console.log(`[dq] all ${dq.length} data-quality checks passed`)
  } catch (e) {
    console.warn('[dq] check failed to run:', (e as Error).message)
  }
}
const cap_count = (ranked: CasinoView[]) => Math.min(ranked.length, MAX_CASINOS)

export function getPage(path: string): { html: string } | null {
  return db.prepare('SELECT html FROM seo_page WHERE path=?').get(path) as { html: string } | null
}

// dynamic sitemap merging the static core URLs + every generated SEO page
function buildSitemap(): string {
  // Only public, server-rendered pages belong here. The /app/* dashboard routes are
  // login-gated SPA shells (no unique SSR content — identical title/h1), so submitting
  // them wastes crawl budget and risks a thin/duplicate-content signal. Their public,
  // indexable equivalents are the SSR SEO pages (/casino/*, /rankings/*, /reports/*, …).
  const core = [
    { loc: '/', freq: 'hourly', pr: '1.0' },
    { loc: '/daily', freq: 'hourly', pr: '0.9' },
  ]
  // only indexable lifecycle states belong in the sitemap; limited_public_noindex /
  // internal_only / archived pages are accessible on-site but excluded from search.
  const pages = db
    .prepare("SELECT path, kind, lifecycle, updated_at FROM seo_page WHERE lifecycle IN ('public_indexable','featured_core') ORDER BY kind, path")
    .all() as { path: string; kind: string; lifecycle: string; updated_at: number }[]
  const pr = (p: { kind: string; lifecycle: string }) =>
    p.lifecycle === 'featured_core' ? '0.9' : p.kind === 'rankings' ? '0.8' : p.kind === 'chains' ? '0.7' : p.kind === 'report' ? '0.6' : p.kind === 'methodology' ? '0.5' : '0.6'
  const cf = (k: string) => (k === 'methodology' || k === 'report' ? 'monthly' : 'daily')
  // <lastmod> tells crawlers what's fresh → more efficient (re)crawling + faster
  // indexing of updated pages. Sourced from each page's last regeneration time.
  const lastmod = (ts: number) => (ts > 0 ? `<lastmod>${new Date(ts).toISOString().slice(0, 10)}</lastmod>` : '')
  const urls = [
    ...core.map((c) => `<url><loc>${SITE}${c.loc}</loc><changefreq>${c.freq}</changefreq><priority>${c.pr}</priority></url>`),
    ...pages.map((p) => `<url><loc>${SITE}${p.path}</loc>${lastmod(p.updated_at)}<changefreq>${cf(p.kind)}</changefreq><priority>${pr(p)}</priority></url>`),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

const HTML_CACHE = 'public, max-age=600, stale-while-revalidate=86400'

export function registerSeo(app: FastifyInstance) {
  const serve = (kind: string) => async (req: any, reply: any) => {
    const page = getPage(req.url.split('?')[0])
    if (page) return reply.type('text/html; charset=utf-8').header('Cache-Control', HTML_CACHE).send(page.html)
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found — WCOIN.CASINO</title><body style="background:#0a0a0f;color:#e8e8ee;font:16px/1.6 system-ui;text-align:center;padding:80px"><h1 style="color:#f5b100">404</h1><p>This ${esc(kind)} page isn't available.</p><p><a style="color:#f5b100" href="/">← WCOIN.CASINO home</a></p></body>`)
  }
  // OG image as PNG — Twitter/Facebook don't render an SVG og:image, so social
  // previews showed no image. Convert the static og.svg once via sharp, cache it.
  let ogPng: Buffer | null = null
  app.get('/og.png', async (_req, reply) => {
    if (!ogPng) {
      try {
        const svg = readFileSync(fileURLToPath(new URL('../../dist/og.svg', import.meta.url)))
        ogPng = await sharp(svg, { density: 144 }).resize(1200, 630, { fit: 'cover' }).png().toBuffer()
      } catch {
        return reply.code(404).send()
      }
    }
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').send(ogPng)
  })
  app.get('/casino/:slug', serve('casino'))
  app.get('/compare/:slug', serve('compare'))
  // entity review pages (keyword-rich slugs need explicit routes; the catch-all SPA
  // would otherwise swallow them) — see ENTITY_REVIEW
  for (const s of ENTITY_REVIEW_SLUGS) {
    app.get(`/is-${s}-safe`, serve('casino'))
    app.get(`/does-${s}-pay-out`, serve('casino'))
    app.get(`/${s}-proof-of-reserves`, serve('casino'))
  }
  app.get('/rankings', serve('rankings'))
  app.get('/best-crypto-casinos', serve('rankings'))
  app.get('/highest-volume-crypto-casinos', serve('rankings'))
  app.get('/crypto-casinos-with-proof-of-reserves', serve('rankings'))
  app.get('/multi-chain-crypto-casinos', serve('rankings'))
  app.get('/best-usdt-casinos', serve('rankings'))
  app.get('/best-usdc-casinos', serve('rankings'))
  app.get('/best-bitcoin-casinos', serve('rankings'))
  app.get('/best-ethereum-casinos', serve('rankings'))
  app.get('/best-tron-casinos', serve('rankings'))
  app.get('/best-solana-casinos', serve('rankings'))
  app.get('/best-polygon-casinos', serve('rankings'))
  app.get('/data/crypto-casino-deposit-currencies', serve('data'))
  app.get('/data/crypto-casino-reserves', serve('data'))
  app.get('/data/crypto-casino-net-flow', serve('data'))
  app.get('/data/crypto-casino-tokens', serve('data'))
  app.get('/data', serve('data'))
  app.get('/guide/what-is-a-crypto-casino', serve('guide'))
  app.get('/guide/how-to-choose-a-crypto-casino', serve('guide'))
  app.get('/guide/crypto-casino-bonuses-explained', serve('guide'))
  app.get('/guide/crypto-gambling-glossary', serve('guide'))
  app.get('/guide', serve('guide'))
  app.get('/guide/crypto-casino-proof-of-reserves', serve('guide'))
  app.get('/guide/usdt-vs-bitcoin-casino-deposits', serve('guide'))
  app.get('/guide/are-crypto-casinos-safe', serve('guide'))
  app.get('/guide/how-to-verify-a-crypto-casino', serve('guide'))
  app.get('/guide/crypto-casino-withdrawal-times', serve('guide'))
  app.get('/guide/provably-fair-explained', serve('guide'))
  app.get('/guide/:slug', serve('guide')) // catch-all so new guides need no per-slug route
  app.get('/risk', serve('risk'))
  app.get('/proof-of-reserves', serve('reserves'))
  app.get('/rankings/:slug', serve('rankings'))
  app.get('/chains/:slug', serve('chains'))
  app.get('/reports/daily/:date', serve('report'))
  app.get('/reports/weekly/:week', serve('report'))
  app.get('/methodology/:topic', serve('methodology'))
  app.get('/about', serve('about'))
  app.get('/whitepaper', serve('about'))
  app.get('/responsible-gambling', serve('about'))
  app.get('/insights', serve('insights'))
  app.get('/submit/casino', serve('submit'))
  app.get('/submit/kol', serve('submit'))
  // §5.3 form post (x-www-form-urlencoded parser registered in server.ts) → record a
  // reviewed submission, reply with a branded HTML page (SSR pages run no JS).
  const submitReply = (reply: any, heading: string, msg: string) =>
    reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${heading} — WCOIN.CASINO</title><body style="background:#0a0a0f;color:#e8e8ee;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:72px 20px"><h1 style="color:#f5b100;font-size:22px">${heading}</h1><p style="color:#aab;max-width:440px;margin:12px auto">${esc(msg)}</p><p style="margin-top:24px"><a style="color:#f5b100" href="/">← WCOIN.CASINO home</a></p></body>`)
  const handleSubmit = (kind: string) => async (req: any, reply: any) => {
    const b = (req.body ?? {}) as { name?: string; email?: string; message?: string; evidence?: string }
    const name = String(b.name ?? '').trim().slice(0, 120)
    const message = String(b.message ?? '').trim().slice(0, 3500)
    const email = String(b.email ?? '').trim().slice(0, 200)
    if (name.length < 2 || message.length < 5) return submitReply(reply, 'Missing details', 'Please provide a name and a short description, then submit again.')
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return submitReply(reply, 'Invalid email', 'That email looks off — leave it blank or fix it and resubmit.')
    try {
      db.prepare('INSERT INTO submission(type, brand, email, message, evidence_url, status, created_at) VALUES(?,?,?,?,?,?,?)').run(
        'attribution',
        name,
        email || null,
        `[${kind} submission] ${message}`,
        String(b.evidence ?? '').trim().slice(0, 500) || null,
        'new',
        Date.now(),
      )
    } catch (e) {
      return submitReply(reply, 'Something went wrong', 'Please try again in a moment.')
    }
    return submitReply(reply, 'Thanks — received', 'Your submission is in our review queue. We verify on-chain before listing and may follow up if you left an email.')
  }
  app.post('/submit/casino', handleSubmit('casino'))
  app.post('/submit/kol', handleSubmit('kol'))
  app.get('/streamers', serve('streamers'))
  app.get('/streamer/:slug', serve('streamers'))

  // Dynamic child sitemap with every generated SEO page (+ core URLs). We use a
  // distinct path because @fastify/static (wildcard:false) registers an explicit
  // route per dist file, so /sitemap.xml is already taken — that static file is a
  // <sitemapindex> pointing here, and GSC follows the index to discover these.
  app.get('/sitemap-pages.xml', async (_req, reply) =>
    reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(buildSitemap()),
  )
}

export function startSeo() {
  const run = () =>
    generateSeoPages()
      .then(() => pingIndexNow())
      .catch((e) => console.warn('[seo] generation failed:', (e as Error).message))
  // run after the snapshot warms the aggregate cache (snapshot fires at +150s)
  setTimeout(run, 210_000)
  setInterval(run, 30 * 60_000).unref?.()
  console.log('[seo] data-led SEO page generator active (30-min rebuild)')
}
