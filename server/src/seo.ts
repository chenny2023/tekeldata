import { FastifyInstance } from 'fastify'
import { db } from './db.ts'
import { aggregateBrands, type BrandAgg } from './aggregate.ts'
import { runDataQualityChecks } from './dataquality.ts'
import { brandKey, brandName, matchCasinoMeta, type CasinoMeta } from './casinometa.ts'
import { reviewScores, type ReviewScore } from './collectors/reviews.ts'
import { reserveSeries } from './reservehistory.ts'
import { brandRiskEvents, recentRiskEvents, type RiskEvent } from './riskevents.ts'
import { pingIndexNow } from './indexnow.ts'

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
<meta name="theme-color" content="#0a0a0f">
<meta property="og:type" content="website"><meta property="og:site_name" content="WCOIN.CASINO">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(ogImage || SITE + '/og.svg')}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(ogImage || SITE + '/og.svg')}">
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
<nav class="navlinks"><a href="/">Home</a><a href="/rankings">Rankings</a><a href="/risk">Risk</a><a href="/daily">Daily report</a><a href="/methodology/address-attribution">Methodology</a><a class="cta" href="/app">Live dashboard →</a></nav>
</div></header>
<main class="wrap">
<div class="crumb">${crumbHtml}</div>
<h1>${esc(h1)}</h1>
${body}
<p class="note"><strong>Methodology &amp; disclaimer.</strong> Figures are derived from on-chain transfers attributed to wallets we associate with each operator, plus third-party ratings shown with their source. Blockchain attribution carries inherent uncertainty, and reserves are an all-chain best-effort estimate from mapped wallets — coverage varies by operator. These pages describe <em>observed activity and third-party data only</em>; they are not a statement on any operator's solvency, legality, fairness, or safety, and nothing here is financial advice. See <a href="/methodology/address-attribution">how we attribute on-chain activity</a>. Data updates roughly every 30 minutes.</p>
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
<span>© 2026 WCOIN.CASINO — the on-chain intelligence layer for iGaming</span>
<span><a href="/rankings">Rankings</a> · <a href="/daily">Daily report</a> · <a href="/streamers">Streamers</a> · <a href="/app">Live data</a> · <a href="/methodology/proof-of-reserves">Reserves methodology</a></span>
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
  if (r.tp != null && (r.tpN ?? 0) >= MIN_TP_REVIEWS) out.push({ key: 'tp', label: 'Trustpilot', norm: (r.tp / 5) * 100 })
  return out
}

// A PUBLISHED blended trust score requires ≥2 independent qualifying sources — a
// single rating is shown as itself, never synthesised into a misleading "blend".
function blendedTrust(v: CasinoView): { score: number; sources: number } | null {
  const s = trustSources(v)
  if (s.length < 2) return null
  return { score: Math.round(s.reduce((a, b) => a + b.norm, 0) / s.length), sources: s.length }
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
  xlinks: { compares?: { slug: string; label: string }[]; bestChains?: { slug: string; label: string }[] } = {},
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
    ? `Is ${v.name} solvent and active? On-chain data: ${fmtUsd(oc.reserves)} tracked all-chain reserves (${COVERAGE_LABEL[cov]} coverage), ${fmtUsd(oc.volume7d)} 7-day volume across ${oc.byChain?.length || 1} chains, and multi-source trust ratings — independently verifiable, updated continuously.`
    : `Trust ratings and reference data for ${v.name} — casino.guru, Trustpilot${r.ag != null ? ', AskGamblers' : ''} and more, in one place. Updated continuously.`

  // stats grid — on-chain tiles when we track wallets, else rating tiles
  let stats = ''
  if (oc) {
    const net = oc.net7d ?? 0
    stats =
      `<div class="grid">` +
      stat('7d volume', fmtUsd(oc.volume7d)) +
      stat('24h volume', fmtUsd(oc.volume24h)) +
      stat('Net flow (7d)', (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), net >= 0 ? 'mint' : 'rose') +
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
  if (r.tp != null) ratings.push(`<tr><td>Trustpilot${r.tpN != null ? ` (${fmtNum(r.tpN)} reviews${r.tpN < MIN_TP_REVIEWS ? ' — limited, excluded from blend' : ''})` : ''}</td><td class="n">${r.tp.toFixed(1)} / 5</td></tr>`)
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
    faqs.push({ q: `Is ${v.name} active on-chain?`, a: `${v.name} has ${fmtUsd(oc.volume7d)} of tracked on-chain volume over the last 7 days across ${oc.byChain?.length || 1} chain${(oc.byChain?.length || 1) === 1 ? '' : 's'}, with ${fmtNum(oc.players)} active counterparties.` })
    faqs.push({ q: `Is ${v.name} legit or safe to use?`, a: `WCOIN is an independent on-chain data site and does not rate operators as legit, safe or unsafe. We surface verifiable signals — on-chain reserves, tracked volume and independent third-party ratings${bt ? ` (blended trust ${bt.score}/100 from ${bt.sources} sources)` : ''} — so you can assess for yourself. Always do your own research.` })
    faqs.push({ q: `How is ${v.name}'s data verified?`, a: `Figures come from on-chain transfers attributed to wallets associated with ${v.name}, plus published third-party ratings shown with their source. Attribution carries inherent uncertainty; see our methodology.` })
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

  const body = `${limitedNote}${suspectNote}${sub}${trustLine}${stats}${solvency}${riskSection}${chainTable}${ratingsTable}${refTable}${website}${rel}${compareLinks}${chainBestLinks}${faqHtml}${alertForm}${cta}`

  const jsonLd: object[] = [
    ...(oc
      ? [
          {
            '@type': 'Dataset',
            name: `${v.name} on-chain activity dataset`,
            description,
            url,
            creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
            isAccessibleForFree: true,
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
      updated: Date.now(),
      body,
      noindex,
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
    row('7d on-chain volume', oa?.volume7d ?? null, ob?.volume7d ?? null, fmtUsd) +
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

// ── "best crypto casinos on {chain}" — trust-ranked, per network ───────────────
// Distinct from /chains/{chain} (which is volume-by-network): this is an editorial,
// TRUST-ranked shortlist of the operators actually settling on that chain.
function bestOnChainPage(chain: string, entries: { v: CasinoView; slug: string }[]): { title: string; description: string; html: string } {
  const cn = chainName(chain)
  const cslug = slugify(chain)
  const path = `/rankings/best-on-${cslug}`
  const url = SITE + path
  const title = `Best Crypto Casinos on ${cn} — Ranked by Independent Trust | WCOIN.CASINO`
  const description = `The most independently-trusted crypto casinos settling on ${cn}, ranked by a blend of third-party trust ratings (not volume). On-chain volume and reserves shown for context. Updated continuously.`
  const rows = entries
    .map((x, i) => {
      const bt = blendedTrust(x.v)
      const oc = x.v.onchain
      const onVol = oc?.byChain?.find((c) => slugify(c.chain) === cslug)?.value ?? 0
      return `<tr><td class="n">${i + 1}</td><td><a href="/casino/${x.slug}">${esc(x.v.name)}</a></td><td class="n gold">${bt ? `${bt.score} / 100` : '—'}</td><td class="n">${fmtUsd(onVol)}</td><td class="n">${oc ? fmtUsd(oc.reserves) : '—'}</td></tr>`
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
      jsonLd: [],
      breadcrumb: [
        { name: 'Home', url: SITE + '/' },
        { name: 'Rankings', url: SITE + '/rankings' },
        { name: `Best on ${cn}`, url },
      ],
      h1: `Best crypto casinos on ${cn}`,
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

function streamerPage(s: any, affCasino: { name: string; slug: string; vol7d: number; reserves: number; trust: number | null } | null): { title: string; description: string; html: string } {
  const path = `/streamer/${streamerSlug(s)}`
  const url = SITE + path
  const followers = fmtNum(s.followers || 0)
  const title = `${esc(s.handle)} — Crypto Casino Streamer on ${esc(s.platform)} | WCOIN.CASINO`
  const description = `${s.handle} is a ${s.platform} crypto-gambling streamer with ${followers} followers${s.affiliation ? `, promoting ${s.affiliation}` : ''}. Live status, audience and the on-chain data for the casino they play.`
  const affBlock = affCasino
    ? `<div class="card"><h2>Promotes: <a href="/casino/${affCasino.slug}">${esc(affCasino.name)}</a></h2>` +
      `<p class="prose">On-chain snapshot for ${esc(affCasino.name)} — independent of any promotion:</p>` +
      `<table><tbody>` +
      `<tr><td>7d on-chain volume</td><td class="n">${fmtUsd(affCasino.vol7d)}</td></tr>` +
      `<tr><td>Mapped reserves</td><td class="n">${fmtUsd(affCasino.reserves)}</td></tr>` +
      `<tr><td>Blended trust</td><td class="n gold">${affCasino.trust != null ? `${affCasino.trust} / 100` : '—'}</td></tr>` +
      `</tbody></table></div>`
    : s.affiliation
      ? `<p class="prose">Most visibly promotes <strong>${esc(String(s.affiliation))}</strong>.</p>`
      : ''
  const body =
    `<p class="sub"><strong>${esc(s.handle)}</strong> is a crypto-casino / gambling streamer on <strong>${esc(s.platform)}</strong>${s.live ? ' — <span class="gold">live now</span>' : ''}.</p>` +
    `<table><tbody>` +
    `<tr><td>Platform</td><td>${esc(s.platform)}</td></tr>` +
    `<tr><td>Followers</td><td class="n">${followers}</td></tr>` +
    `<tr><td>Status</td><td>${s.live ? `Live · ${fmtNum(s.viewers || 0)} viewers` : 'Offline'}</td></tr>` +
    (s.game ? `<tr><td>Category</td><td>${esc(String(s.game))}</td></tr>` : '') +
    `</tbody></table>` +
    affBlock +
    `<p class="prose" style="margin-top:16px">See all <a href="/streamers">tracked crypto casino streamers</a>. Streamer promotion ≠ endorsement of solvency — always check a casino's <a href="/proof-of-reserves">on-chain reserves</a> and <a href="/rankings/trust">independent trust</a>.</p>`
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
function chainPage(chain: string, brands: BrandAgg[], slugOfBrand: (b: BrandAgg) => string): { title: string; description: string; html: string } {
  const name = chainName(chain)
  const url = `${SITE}/chains/${slugify(chain)}`
  const onChain = brands
    .map((e) => ({ e, v: (e.byChain ?? []).find((c) => slugify(c.chain) === slugify(chain))?.value ?? 0 }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 30)
  const total = onChain.reduce((s, x) => s + x.v, 0)
  const max = Math.max(...onChain.map((x) => x.v), 1)
  const title = `${name} crypto casinos — on-chain volume & reserves | WCOIN.CASINO`
  const description = `Crypto-casino activity on ${name}: ${fmtUsd(total)} tracked 7-day volume across ${onChain.length} operators. Live on-chain data, updated continuously.`
  const trows = onChain
    .map(
      (x, i) =>
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOfBrand(x.e)}">${esc(x.e.brand)}</a></td><td class="n">${fmtUsd(x.v)}</td><td style="width:120px"><div class="bar"><span style="width:${Math.max(3, (x.v / max) * 100)}%"></span></div></td></tr>`,
    )
    .join('')
  const body = `
<p class="sub">Tracked crypto-casino transaction volume settled on <strong>${esc(name)}</strong>, by operator (7-day window).</p>
<p class="upd">${onChain.length} operators · ${fmtUsd(total)} total 7d volume · <a href="/rankings">all rankings</a></p>
<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">7d volume on ${esc(name)}</th><th></th></tr></thead><tbody>${trows}</tbody></table>
<p class="prose" style="margin-top:22px">This is on-chain settlement volume attributed to casino wallets on ${esc(name)} — see the <a href="/methodology/on-chain-volume">volume methodology</a> for how it's measured, or the live <a href="/app/blockchain">on-chain feed</a>.</p>`
  const jsonLd = [
    { '@type': 'Dataset', name: `${name} crypto-casino on-chain volume`, description, url, creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE }, isAccessibleForFree: true },
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
        { name: 'Chains', url: SITE + '/rankings' },
        { name, url },
      ],
      h1: `${name} crypto casinos`,
      updated: Date.now(),
      body,
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
const upsert = db.prepare(
  `INSERT INTO seo_page(path, kind, title, description, html, updated_at, lifecycle) VALUES(@path,@kind,@title,@description,@html,@now,@lifecycle)
   ON CONFLICT(path) DO UPDATE SET kind=@kind, title=@title, description=@description, html=@html, updated_at=@now, lifecycle=@lifecycle`,
)
const enqueueEnrich = db.prepare(
  `INSERT INTO enrichment_queue(brand_key, label, slug, confidence, missing, status, created_at, updated_at)
   VALUES(@brand_key,@label,@slug,@confidence,@missing,'pending',@now,@now)
   ON CONFLICT(brand_key) DO UPDATE SET label=@label, slug=@slug, confidence=@confidence, missing=@missing, updated_at=@now,
     status=CASE WHEN enrichment_queue.status='promoted' THEN 'promoted' ELSE 'pending' END`,
)

const MAX_CASINOS = Number(process.env.SEO_MAX_CASINOS ?? 600)
const MAX_REPORTS = Number(process.env.SEO_MAX_REPORTS ?? 400)

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
  const add = (path: string, kind: string, pg: { title: string; description: string; html: string }, lifecycle = 'public_indexable') => {
    built.push({ path, kind, pg, lifecycle })
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
  const COMPARE_TOP_K = Number(process.env.SEO_COMPARE_TOP_K ?? 18)
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
    add(`/casino/${slugOfView(v)}`, 'casino', casinoPage(v, slugOfView(v), peers.length ? peers : fallback, noindex, { compares: comparesByKey.get(v.key), bestChains: bestChainsByKey.get(v.key) }), lc)
    if (noindex) {
      const missing = [!v.onchain && 'onchain', !(v.onchain && v.onchain.reserves > 0) && 'reserves', trustSources(v).length < 2 && 'trust-sources']
        .filter(Boolean)
        .join(',')
      enrich.push({ brand_key: v.key, label: v.name, slug: slugOfView(v), confidence: 'low', missing, now })
    }
    if (idx % 15 === 14) await yieldLoop() // hand the loop back every 15 page-builds
  }
  // rankings: metric leaderboards + trust board + index
  for (const key of Object.keys(METRICS)) {
    const pg = metricRankingPage(key, onchainBrands, slugOfBrand)
    if (pg) add(`/rankings/${key}`, 'rankings', pg)
  }
  add('/rankings/trust', 'rankings', trustRankingPage(ranked, slugOfView))
  add('/rankings', 'rankings', rankingsIndexPage([...chainSet], unattributed.length > 0))
  add('/risk', 'risk', riskIndexPage(recentRiskEvents(80)), 'featured_core') // neutral risk registry
  add('/proof-of-reserves', 'reserves', reservesHubPage(onchainBrands, slugOfBrand), 'featured_core') // on-chain moat: PoR guide + verified list
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
      .prepare('SELECT id, handle, platform, viewers, live, followers, affiliation, game FROM streamers ORDER BY followers DESC LIMIT 100')
      .all() as any[]
    if (streamers.length) {
      add('/streamers', 'streamers', streamersIndexPage(streamers), 'featured_core')
      const casinoByNorm = new Map<string, CasinoView>()
      for (const v of ranked) casinoByNorm.set(brandKey(v.name), v)
      for (const s of streamers) {
        if ((s.followers ?? 0) < 5000) continue // skip thin pages
        const v = s.affiliation ? casinoByNorm.get(brandKey(String(s.affiliation))) : undefined
        const aff = v
          ? { name: v.name, slug: slugOfView(v), vol7d: v.onchain?.volume7d ?? 0, reserves: v.onchain?.reserves ?? 0, trust: blendedTrust(v)?.score ?? null }
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
      for (const b of slice) upsert.run({ path: b.path, kind: b.kind, title: b.pg.title, description: b.pg.description, html: b.pg.html, now, lifecycle: b.lifecycle })
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

function getPage(path: string): { html: string } | null {
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
  app.get('/casino/:slug', serve('casino'))
  app.get('/compare/:slug', serve('compare'))
  app.get('/rankings', serve('rankings'))
  app.get('/risk', serve('risk'))
  app.get('/proof-of-reserves', serve('reserves'))
  app.get('/rankings/:slug', serve('rankings'))
  app.get('/chains/:slug', serve('chains'))
  app.get('/reports/daily/:date', serve('report'))
  app.get('/reports/weekly/:week', serve('report'))
  app.get('/methodology/:topic', serve('methodology'))
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
