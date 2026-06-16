import { FastifyInstance } from 'fastify'
import { db } from './db.ts'
import { aggregateBrands, type BrandAgg } from './aggregate.ts'
import { runDataQualityChecks } from './dataquality.ts'
import { brandKey, brandName, matchCasinoMeta, type CasinoMeta } from './casinometa.ts'
import { reviewScores, type ReviewScore } from './collectors/reviews.ts'

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
}): string {
  const { title, description, canonical, jsonLd = [], breadcrumb, h1, updated, body } = opts
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
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#0a0a0f">
<meta property="og:type" content="website"><meta property="og:site_name" content="WCOIN.CASINO">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${SITE}/og.svg">
<meta name="twitter:card" content="summary_large_image">
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
<nav class="navlinks"><a href="/">Home</a><a href="/rankings">Rankings</a><a href="/daily">Daily report</a><a href="/methodology/address-attribution">Methodology</a><a class="cta" href="/app">Live dashboard →</a></nav>
</div></header>
<main class="wrap">
<div class="crumb">${crumbHtml}</div>
<h1>${esc(h1)}</h1>
${body}
<p class="note"><strong>Methodology &amp; disclaimer.</strong> Figures are derived from on-chain transfers attributed to wallets we associate with each operator, plus third-party ratings shown with their source. Blockchain attribution carries inherent uncertainty, and reserves are an all-chain best-effort estimate from mapped wallets — coverage varies by operator. These pages describe <em>observed activity and third-party data only</em>; they are not a statement on any operator's solvency, legality, fairness, or safety, and nothing here is financial advice. See <a href="/methodology/address-attribution">how we attribute on-chain activity</a>. Data updates roughly every 30 minutes.</p>
</main>
<footer><div class="wrap">
<span>© 2026 WCOIN.CASINO — the on-chain intelligence layer for iGaming</span>
<span><a href="/rankings">Rankings</a> · <a href="/daily">Daily report</a> · <a href="/app">Live data</a> · <a href="/methodology/proof-of-reserves">Reserves methodology</a></span>
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

function casinoPage(v: CasinoView, slug: string, related: { slug: string; label: string }[]): { title: string; description: string; html: string } {
  const url = `${SITE}/casino/${slug}`
  const oc = v.onchain
  const r = ratingsOf(v)
  const bt = blendedTrust(v)

  const title = oc
    ? `${v.name} — On-Chain Volume, Reserves & Trust Data | WCOIN.CASINO`
    : `${v.name} — Crypto Casino Trust Ratings & Data | WCOIN.CASINO`
  const description = oc
    ? `On-chain data for ${v.name}: ${fmtUsd(oc.volume7d)} tracked 7-day volume across ${oc.byChain?.length || 1} chains, ${fmtUsd(oc.reserves)} mapped reserves, and multi-source trust ratings. Observed blockchain activity, updated continuously.`
    : `Aggregated third-party trust ratings and reference data for ${v.name} — casino.guru, Trustpilot${r.ag != null ? ', AskGamblers' : ''} and more, in one place. Updated continuously.`

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

  const body = `${sub}${trustLine}${stats}${chainTable}${ratingsTable}${refTable}${website}${rel}${cta}`

  const jsonLd = oc
    ? [
        {
          '@type': 'Dataset',
          name: `${v.name} on-chain activity dataset`,
          description,
          url,
          creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
          isAccessibleForFree: true,
          variableMeasured: ['7d on-chain volume', 'mapped reserves (USD)', 'net flow', 'active counterparties'],
        },
      ]
    : []
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

function metricRankingPage(key: string, brands: BrandAgg[], slugOfBrand: (b: BrandAgg) => string): { title: string; description: string; html: string } | null {
  const cfg = METRICS[key]
  if (!cfg) return null
  const url = `${SITE}/rankings/${key}`
  const rows = brands
    .filter((e) => Math.abs(cfg.metric(e)) > 0)
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
  const description = `Crypto-casino market on ${date} (UTC): ${fmtUsd(snap.tracked_volume_24h ?? 0)} tracked 24h on-chain volume across ${snap.active_casinos ?? 0} casinos and ${snap.active_chains ?? 0} chains, ${fmtUsd(snap.reserves_total ?? 0)} mapped reserves.`

  const stats =
    `<div class="grid">` +
    stat('24h tracked volume', fmtUsd(snap.tracked_volume_24h ?? 0)) +
    stat('Net flow (24h)', (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), net >= 0 ? 'mint' : 'rose') +
    stat('Active casinos', fmtNum(snap.active_casinos ?? 0)) +
    stat('Chains', String(snap.active_chains ?? 0)) +
    stat('Live streamers', String(snap.live_streamers ?? 0)) +
    stat('Tracked reserves', fmtUsd(snap.reserves_total ?? 0), 'mint') +
    `</div>`

  const movers = (p.topMovers ?? []).slice(0, 8)
  const moversT = movers.length
    ? `<h2>Verified casino flow — biggest movers (24h)</h2><table><thead><tr><th>Operator</th><th style="text-align:right">24h volume</th><th style="text-align:right">7d volume</th></tr></thead><tbody>${movers
        .map((m: any) => `<tr><td><a href="/casino/${slugify(m.label)}">${esc(m.label)}</a></td><td class="n">${fmtUsd(m.vol24h)}</td><td class="n" style="color:var(--mut)">${fmtUsd(m.vol7d ?? 0)}</td></tr>`)
        .join('')}</tbody></table>`
    : ''

  const chains = (p.chainVolume ?? []).slice(0, 10)
  const maxC = Math.max(...chains.map((c: any) => c.vol24h || 0), 1)
  const chainsT = chains.length
    ? `<h2>Volume by chain (24h)</h2><table><tbody>${chains
        .map((c: any) => `<tr><td><span class="pill">${esc(chainName(c.chain))}</span></td><td class="n">${fmtUsd(c.vol24h)}</td><td style="width:120px"><div class="bar"><span style="width:${Math.max(3, ((c.vol24h || 0) / maxC) * 100)}%"></span></div></td></tr>`)
        .join('')}</tbody></table>`
    : ''

  const whales = (p.whales ?? []).slice(0, 10)
  const whalesT = whales.length
    ? `<h2>Whale activity (24h, ≥ $50K)</h2><table><tbody>${whales
        .map(
          (w: any) =>
            `<tr><td>${esc(w.label)}</td><td><span class="pill">${esc(chainName(w.chain))}</span></td><td class="n ${w.direction === 'in' ? 'mint' : 'rose'}">${w.direction === 'in' ? '+' : '−'}${fmtUsd(w.usd)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''

  const reserves = (p.topReserves ?? []).slice(0, 8)
  const reservesT = reserves.length
    ? `<h2>Reserve watch — all-chain tracked reserves</h2><table><tbody>${reserves
        .map((r: any) => `<tr><td><a href="/casino/${slugify(r.label)}">${esc(r.label)}</a></td><td class="n mint">${fmtUsd(r.reserves)}</td></tr>`)
        .join('')}</tbody></table>`
    : ''

  // unattributed flow — pattern-detected, never mixed into the verified figures above
  const u = p.unattributed
  const unattrT =
    u && u.count
      ? `<h2>Unattributed Casino Flow</h2><p class="prose" style="font-size:13px;color:var(--dim)">Pattern-detected casino-related flow not attributed to a verified brand — shown separately and excluded from every figure above.</p><table><tbody>${(u.top ?? [])
          .map((x: any) => `<tr><td>${esc(x.label)}</td><td class="n">${fmtUsd(x.vol7d)} 7d</td></tr>`)
          .join('')}<tr><td><strong>Total unattributed</strong></td><td class="n"><strong>${fmtUsd(u.vol24h)} 24h · ${fmtUsd(u.vol7d)} 7d</strong></td></tr></tbody></table>`
      : ''

  const confNote = `<p class="prose" style="margin-top:20px;font-size:13px"><strong>Data confidence notes.</strong> All figures are brand-merged, verified on-chain observations for the stated window; unattributed pattern flow is reported separately above. Snapshot confidence for this day: <span class="pill">${esc(snap.confidence_level || 'medium')}</span>. See <a href="/methodology/data-confidence">how we rate data confidence</a>.</p>`

  const pager =
    prev || next
      ? `<div class="pager">${prev ? `<a href="/reports/daily/${prev}">← ${esc(prev)}</a>` : '<span></span>'}${next ? `<a href="/reports/daily/${next}">${esc(next)} →</a>` : '<span></span>'}</div>`
      : ''

  const body = `
<p class="sub">On-chain snapshot of the crypto-casino market for <strong>${esc(date)} (UTC)</strong> — confidence: ${esc(snap.confidence_level || 'medium')}.</p>
<p class="upd">Archived daily report · <a href="/daily">today's live report</a></p>
${pager}
${stats}
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
  `INSERT INTO seo_page(path, kind, title, description, html, updated_at) VALUES(@path,@kind,@title,@description,@html,@now)
   ON CONFLICT(path) DO UPDATE SET kind=@kind, title=@title, description=@description, html=@html, updated_at=@now`,
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
  let n = 0
  const put = (path: string, kind: string, pg: { title: string; description: string; html: string }) => {
    upsert.run({ path, kind, title: pg.title, description: pg.description, html: pg.html, now })
    written.add(path)
    n++
  }

  const writeAll = db.transaction(() => {
    // casino pages — public profiles require confidence >= medium (a bare single
    // low-weight rating is not enough); keeps pages authoritative, no thin content.
    const cap = ranked.filter((v) => dataConfidence(v) !== 'low').slice(0, MAX_CASINOS)
    cap.forEach((v, idx) => {
      const peers = [cap[idx - 2], cap[idx - 1], cap[idx + 1], cap[idx + 2]].filter(Boolean).map((x) => ({ slug: slugOfView(x), label: x.name }))
      const fallback = cap.filter((x) => x.key !== v.key).slice(0, 4).map((x) => ({ slug: slugOfView(x), label: x.name }))
      put(`/casino/${slugOfView(v)}`, 'casino', casinoPage(v, slugOfView(v), peers.length ? peers : fallback))
    })
    // rankings: metric leaderboards + trust board + index
    for (const key of Object.keys(METRICS)) {
      const pg = metricRankingPage(key, onchainBrands, slugOfBrand)
      if (pg) put(`/rankings/${key}`, 'rankings', pg)
    }
    put('/rankings/trust', 'rankings', trustRankingPage(ranked, slugOfView))
    put('/rankings', 'rankings', rankingsIndexPage([...chainSet], unattributed.length > 0))
    if (unattributed.length) put('/rankings/unattributed-flow', 'rankings', unattributedFlowPage(unattributed))
    // chains
    for (const cs of chainSet) if (cs) put(`/chains/${cs}`, 'chains', chainPage(cs, onchainBrands, slugOfBrand))
    // daily report archive (prev = older, next = newer)
    snaps.forEach((s, i) => {
      const next = i > 0 ? snaps[i - 1].snapshot_date : null // newer
      const prev = i < snaps.length - 1 ? snaps[i + 1].snapshot_date : null // older
      put(`/reports/daily/${s.snapshot_date}`, 'report', reportPage(s, prev, next))
    })
    // methodology
    for (const topic of Object.keys(METHODOLOGY)) put(`/methodology/${topic}`, 'methodology', methodologyPage(topic)!)
  })
  writeAll()

  // GC: drop any stored page not regenerated this run (stale casino slugs, etc.)
  const stale = (db.prepare('SELECT path FROM seo_page').all() as { path: string }[]).filter((r) => !written.has(r.path))
  if (stale.length) {
    const del = db.prepare('DELETE FROM seo_page WHERE path=?')
    db.transaction(() => stale.forEach((r) => del.run(r.path)))()
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
  const core = [
    { loc: '/', freq: 'hourly', pr: '1.0' },
    { loc: '/daily', freq: 'hourly', pr: '0.9' },
    { loc: '/app/casinos', freq: 'hourly', pr: '0.8' },
    { loc: '/app/sentiment', freq: 'hourly', pr: '0.8' },
    { loc: '/app/markets', freq: 'hourly', pr: '0.7' },
    { loc: '/app/directory', freq: 'daily', pr: '0.7' },
    { loc: '/app/streamers', freq: 'hourly', pr: '0.6' },
    { loc: '/app/blockchain', freq: 'hourly', pr: '0.6' },
  ]
  const pages = db.prepare('SELECT path, kind FROM seo_page ORDER BY kind, path').all() as { path: string; kind: string }[]
  const pr = (k: string) => (k === 'rankings' ? '0.8' : k === 'chains' ? '0.7' : k === 'report' ? '0.6' : k === 'methodology' ? '0.5' : '0.6')
  const cf = (k: string) => (k === 'methodology' || k === 'report' ? 'monthly' : 'daily')
  const urls = [
    ...core.map((c) => `<url><loc>${SITE}${c.loc}</loc><changefreq>${c.freq}</changefreq><priority>${c.pr}</priority></url>`),
    ...pages.map((p) => `<url><loc>${SITE}${p.path}</loc><changefreq>${cf(p.kind)}</changefreq><priority>${pr(p.kind)}</priority></url>`),
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
  app.get('/rankings', serve('rankings'))
  app.get('/rankings/:slug', serve('rankings'))
  app.get('/chains/:slug', serve('chains'))
  app.get('/reports/daily/:date', serve('report'))
  app.get('/methodology/:topic', serve('methodology'))

  // Dynamic child sitemap with every generated SEO page (+ core URLs). We use a
  // distinct path because @fastify/static (wildcard:false) registers an explicit
  // route per dist file, so /sitemap.xml is already taken — that static file is a
  // <sitemapindex> pointing here, and GSC follows the index to discover these.
  app.get('/sitemap-pages.xml', async (_req, reply) =>
    reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(buildSitemap()),
  )
}

export function startSeo() {
  const run = () => generateSeoPages().catch((e) => console.warn('[seo] generation failed:', (e as Error).message))
  // run after the snapshot warms the aggregate cache (snapshot fires at +150s)
  setTimeout(run, 210_000)
  setInterval(run, 30 * 60_000).unref?.()
  console.log('[seo] data-led SEO page generator active (30-min rebuild)')
}
