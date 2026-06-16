import { FastifyInstance } from 'fastify'
import { db } from './db.ts'
import { aggregateBrands, type BrandAgg } from './aggregate.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — data-led SEO pages. We pre-render REAL, indexable HTML for a handful
// of high-value page types and store it in seo_page, then serve it from Fastify
// AHEAD of the SPA so search engines and AI answer engines get content + internal
// links (the SPA is a JS shell crawlers see as near-empty). Pages are rebuilt on a
// timer from the already-warm aggregate cache, so a request is one PK read.
//
// Liability: every page presents OBSERVED on-chain activity and ATTRIBUTED
// third-party ratings (with sources). It never asserts a verdict on any named
// operator (safe / scam / solvent / legal). The methodology note is on every page.
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
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.prose{color:var(--mut);font-size:15px}.prose p{margin:10px 0}
.note{border-top:1px solid var(--line);margin-top:40px;padding-top:18px;color:var(--dim);font-size:12px;line-height:1.7}
footer{border-top:1px solid var(--line);margin-top:30px}footer .wrap{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;padding:22px 20px;color:var(--dim);font-size:13px}
.bar{height:7px;background:#ffffff0d;border-radius:6px;overflow:hidden}.bar>span{display:block;height:100%;background:linear-gradient(90deg,#f5b100,#d98a00)}
</style></head><body>
<header class="nav"><div class="wrap">
<a class="brand" href="/">WCOIN.CASINO</a>
<nav class="navlinks"><a href="/">Home</a><a href="/daily">Daily report</a><a href="/methodology/attribution">Methodology</a><a class="cta" href="/app">Live dashboard →</a></nav>
</div></header>
<main class="wrap">
<div class="crumb">${crumbHtml}</div>
<h1>${esc(h1)}</h1>
${body}
<p class="note"><strong>Methodology &amp; disclaimer.</strong> Figures are derived from on-chain transfers attributed to wallets we associate with each operator, plus third-party ratings shown with their source. Blockchain attribution carries inherent uncertainty, and reserves are an all-chain best-effort estimate from mapped wallets — coverage varies by operator. These pages describe <em>observed activity and third-party data only</em>; they are not a statement on any operator's solvency, legality, fairness, or safety, and nothing here is financial advice. See <a href="/methodology/attribution">how we attribute on-chain activity</a>. Data updates roughly every 30 minutes.</p>
</main>
<footer><div class="wrap">
<span>© 2026 WCOIN.CASINO — the on-chain intelligence layer for iGaming</span>
<span><a href="/daily">Daily report</a> · <a href="/app">Live data</a> · <a href="/methodology/reserves">Reserves methodology</a></span>
</div></footer>
</body></html>`
}

// ─────────────────────────────────────────────────────────────────────────────
// Page builders
// ─────────────────────────────────────────────────────────────────────────────

function casinoPage(e: BrandAgg, slug: string, related: { slug: string; label: string }[]): { title: string; description: string; html: string } {
  const url = `${SITE}/casino/${slug}`
  const net = e.net7d ?? 0
  const title = `${e.brand} — On-Chain Volume, Reserves & Trust Data | WCOIN.CASINO`
  const description = `On-chain data for ${e.brand}: ${fmtUsd(e.volume7d)} tracked 7-day volume across ${e.byChain?.length || 1} chains, ${fmtUsd(e.reserves)} mapped reserves, and third-party trust ratings. Observed blockchain activity, updated continuously.`

  const stat = (k: string, v: string, cls = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`
  const stats =
    `<div class="grid">` +
    stat('7d volume', fmtUsd(e.volume7d)) +
    stat('24h volume', fmtUsd(e.volume24h)) +
    stat('Net flow (7d)', (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), net >= 0 ? 'mint' : 'rose') +
    stat('Mapped reserves', fmtUsd(e.reserves), 'mint') +
    stat('Active counterparties (7d)', fmtNum(e.players)) +
    stat('Chains', String(e.byChain?.length || 0)) +
    `</div>`

  // third-party ratings — ALL attributed, shown only when present
  const ratings: string[] = []
  if (e.safetyIndex != null) ratings.push(`<tr><td>casino.guru Safety Index</td><td class="n">${e.safetyIndex.toFixed(1)} / 10</td></tr>`)
  if (e.trustpilot != null) ratings.push(`<tr><td>Trustpilot</td><td class="n">${e.trustpilot.toFixed(1)} / 5</td></tr>`)
  if (e.askgamblers != null) ratings.push(`<tr><td>AskGamblers expert</td><td class="n">${e.askgamblers.toFixed(1)} / 10</td></tr>`)
  if (e.editorial != null) ratings.push(`<tr><td>casino.org editorial</td><td class="n">${e.editorial.toFixed(1)} / 5</td></tr>`)
  if (e.complaints != null) ratings.push(`<tr><td>casino.guru complaints (current)</td><td class="n">${fmtNum(e.complaints)}${e.unresolved != null ? ` (${fmtNum(e.unresolved)} unresolved)` : ''}</td></tr>`)
  const ratingsTable = ratings.length
    ? `<h2>Third-party trust ratings</h2><p class="prose">Independently published by the sources named below — shown here with attribution, not endorsed or verified by us.</p><table><tbody>${ratings.join('')}</tbody></table>`
    : ''

  // chain split
  const chainRows = (e.byChain ?? [])
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((c) => `<tr><td><span class="pill">${esc(chainName(c.chain))}</span></td><td class="n">${fmtUsd(c.value)}</td></tr>`)
    .join('')
  const chainTable = chainRows ? `<h2>On-chain volume by network (7d)</h2><table><thead><tr><th>Network</th><th style="text-align:right">7d volume</th></tr></thead><tbody>${chainRows}</tbody></table>` : ''

  // reference profile (license / house edge), if available — factual reference only
  const meta = e.meta as any
  const refRows: string[] = []
  if (meta?.license) refRows.push(`<tr><td>Stated licence</td><td class="n">${esc(String(meta.license))}</td></tr>`)
  if (meta?.established) refRows.push(`<tr><td>Established</td><td class="n">${esc(String(meta.established))}</td></tr>`)
  if (meta?.houseEdge) refRows.push(`<tr><td>Typical house edge</td><td class="n">${esc(String(meta.houseEdge))}</td></tr>`)
  if (e.reserveCoverage != null) refRows.push(`<tr><td>Withdrawal-coverage ratio <span class="pill">reserves ÷ 7d outflow</span></td><td class="n">${e.reserveCoverage.toFixed(1)}×</td></tr>`)
  const refTable = refRows.length ? `<h2>Reference</h2><table><tbody>${refRows.join('')}</tbody></table>` : ''

  const rel = related.length
    ? `<h2>Related operators</h2><div class="chips">${related.map((r) => `<a class="pill" href="/casino/${r.slug}">${esc(r.label)}</a>`).join('')}</div>`
    : ''

  const body = `
<p class="sub">Observed on-chain activity and third-party ratings attributed to <strong>${esc(e.brand)}</strong>, across ${e.byChain?.length || 1} blockchain${(e.byChain?.length || 1) === 1 ? '' : 's'}.</p>
<p class="upd">Updated continuously from indexed on-chain data.</p>
${stats}
${chainTable}
${ratingsTable}
${refTable}
${rel}
<p class="prose" style="margin-top:24px">Explore the full live picture — real-time deposits &amp; withdrawals, whale flow and reserve history — on the <a href="/app/casinos">live casino dashboard</a>, or see the whole market in today's <a href="/daily">daily report</a>.</p>`

  const jsonLd = [
    {
      '@type': 'Dataset',
      name: `${e.brand} on-chain activity dataset`,
      description,
      url,
      creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
      isAccessibleForFree: true,
      variableMeasured: ['7d on-chain volume', 'mapped reserves (USD)', 'net flow', 'active counterparties'],
    },
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
        { name: 'Casinos', url: SITE + '/rankings/volume' },
        { name: e.brand, url },
      ],
      h1: `${e.brand} — on-chain data`,
      updated: Date.now(),
      body,
    }),
  }
}

// rankings: a few curated leaderboards
const RANKINGS: Record<string, { title: string; blurb: string; metric: (e: BrandAgg) => number; fmt: (e: BrandAgg) => string; col: string; sort: 'desc' }> = {
  volume: { title: 'Top crypto casinos by on-chain volume (7d)', blurb: 'Crypto casinos ranked by tracked on-chain transaction volume over the last 7 days.', metric: (e) => e.volume7d, fmt: (e) => fmtUsd(e.volume7d), col: '7d volume', sort: 'desc' },
  reserves: { title: 'Crypto casinos by mapped on-chain reserves', blurb: 'Operators ranked by all-chain reserves mapped from on-chain wallets (proof-of-reserves estimate).', metric: (e) => e.reserves, fmt: (e) => fmtUsd(e.reserves), col: 'Mapped reserves', sort: 'desc' },
  trust: { title: 'Crypto casinos by third-party trust rating', blurb: 'Operators ordered by a blended score of independently published trust ratings (casino.guru, Trustpilot, AskGamblers).', metric: (e) => e.trust ?? 0, fmt: (e) => (e.trust ? Math.round(e.trust) + ' / 100' : '—'), col: 'Blended trust', sort: 'desc' },
}

function rankingsPage(key: string, ents: BrandAgg[], slugOf: (e: BrandAgg) => string): { title: string; description: string; html: string } | null {
  const cfg = RANKINGS[key]
  if (!cfg) return null
  const url = `${SITE}/rankings/${key}`
  const rows = ents
    .filter((e) => cfg.metric(e) > 0)
    .sort((a, b) => cfg.metric(b) - cfg.metric(a))
    .slice(0, 50)
  const title = `${cfg.title} | WCOIN.CASINO`
  const description = `${cfg.blurb} Ranking ${rows.length} operators from live on-chain data and attributed third-party ratings. Free, updated continuously.`
  const trows = rows
    .map(
      (e, i) =>
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOf(e)}">${esc(e.brand)}</a></td><td class="n">${esc(cfg.fmt(e))}</td><td class="n" style="color:var(--mut)">${fmtUsd(e.volume7d)}</td></tr>`,
    )
    .join('')
  const others = Object.keys(RANKINGS).filter((k) => k !== key)
  const body = `
<p class="sub">${esc(cfg.blurb)}</p>
<p class="upd">${rows.length} operators · live on-chain data, refreshed continuously</p>
<div class="chips">${others.map((k) => `<a class="pill" href="/rankings/${k}">${esc(RANKINGS[k].title.replace(/ \(7d\)/, ''))}</a>`).join('')}</div>
<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">${esc(cfg.col)}</th><th style="text-align:right">7d volume</th></tr></thead><tbody>${trows}</tbody></table>
<p class="prose" style="margin-top:22px">See live deposits, withdrawals and reserve history on the <a href="/app/casinos">interactive dashboard</a>, or the whole-market view in the <a href="/daily">daily report</a>.</p>`
  const jsonLd = [
    {
      '@type': 'ItemList',
      name: cfg.title,
      itemListElement: rows.map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: e.brand, url: `${SITE}/casino/${slugOf(e)}` })),
    },
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
        { name: 'Rankings', url: SITE + '/rankings/volume' },
        { name: cfg.col, url },
      ],
      h1: cfg.title,
      updated: Date.now(),
      body,
    }),
  }
}

function chainPage(chain: string, ents: BrandAgg[], slugOf: (e: BrandAgg) => string): { title: string; description: string; html: string } {
  const name = chainName(chain)
  const url = `${SITE}/chains/${slugify(chain)}`
  // operators active on this chain, by their volume on it
  const onChain = ents
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
        `<tr><td class="n" style="text-align:left;color:var(--dim);width:34px">${i + 1}</td><td><a href="/casino/${slugOf(x.e)}">${esc(x.e.brand)}</a></td><td class="n">${fmtUsd(x.v)}</td><td style="width:120px"><div class="bar"><span style="width:${Math.max(3, (x.v / max) * 100)}%"></span></div></td></tr>`,
    )
    .join('')
  const body = `
<p class="sub">Tracked crypto-casino transaction volume settled on <strong>${esc(name)}</strong>, by operator (7-day window).</p>
<p class="upd">${onChain.length} operators · ${fmtUsd(total)} total 7d volume</p>
<table><thead><tr><th>#</th><th>Operator</th><th style="text-align:right">7d volume on ${esc(name)}</th><th></th></tr></thead><tbody>${trows}</tbody></table>
<p class="prose" style="margin-top:22px">This is on-chain settlement volume attributed to casino wallets on ${esc(name)} — see the <a href="/methodology/volume">volume methodology</a> for how it's measured, or the live <a href="/app/blockchain">on-chain feed</a>.</p>`
  const jsonLd = [
    {
      '@type': 'Dataset',
      name: `${name} crypto-casino on-chain volume`,
      description,
      url,
      creator: { '@type': 'Organization', name: 'WCOIN.CASINO', url: SITE },
      isAccessibleForFree: true,
    },
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
        { name: 'Chains', url: SITE + '/chains/' + slugify(chain) },
        { name, url },
      ],
      h1: `${name} crypto casinos`,
      updated: Date.now(),
      body,
    }),
  }
}

// methodology: hand-written explainers (stable, link targets for the disclaimers)
const METHODOLOGY: Record<string, { title: string; body: string }> = {
  attribution: {
    title: 'How we attribute on-chain activity to crypto casinos',
    body: `<p>WCOIN.CASINO links blockchain wallets to crypto-casino operators using public block-explorer name-tags, published hot-wallet addresses, on-chain clustering of deposit/withdrawal patterns, and cross-referencing against third-party datasets. A single operator typically runs many wallets across several chains, which we group under one entity.</p>
<p>Attribution is a best-effort inference, not a certainty. Wallets can be mislabelled, shared, rotated, or operated by third parties (payment processors, market makers). We continuously revise mappings as new evidence appears. Figures should be read as <em>observed activity for the wallets we associate with an operator</em> — not an audited, operator-confirmed total.</p>
<p>We deliberately do not publish verdicts on operators. We surface measurements and attributed third-party ratings, and let you judge.</p>`,
  },
  volume: {
    title: 'How on-chain volume is measured',
    body: `<p>On-chain volume is the USD value of transfers to and from attributed casino wallets over a window (24-hour and 7-day), priced at transfer time. It captures on-chain settlement — deposits and withdrawals that touch the public blockchain — and excludes purely off-chain ledger movements inside an operator, which are not observable.</p>
<p>Net flow is inflow minus outflow over the window. A figure reflects observed settlement only and should not be read as revenue, profit, or gross gaming revenue.</p>`,
  },
  reserves: {
    title: 'How we estimate all-chain reserves (proof-of-reserves)',
    body: `<p>Reserves are the current on-chain balance of stablecoins and major assets held by wallets we attribute to an operator, summed across every chain we map and priced in USD. It is an all-chain, best-effort proof-of-reserves estimate.</p>
<p>Coverage varies: we can only sum wallets we have mapped, so the true figure may be higher, and some balances belong to processors rather than the operator. The withdrawal-coverage ratio (reserves ÷ 7-day outflow) is a descriptive liquidity indicator, <em>not</em> a solvency rating. None of this is a statement that any operator is or is not solvent.</p>`,
  },
  trust: {
    title: 'How third-party trust ratings are sourced',
    body: `<p>We aggregate independently published ratings — the casino.guru Safety Index, Trustpilot consumer scores, AskGamblers expert ratings, casino.org editorial ratings, and casino.guru complaint counts — and show each with its source. Where we display a blended score, it is a transparent combination of those external signals plus on-chain liquidity heuristics.</p>
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
        { name: 'Methodology', url: SITE + '/methodology/attribution' },
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

const MAX_CASINOS = Number(process.env.SEO_MAX_CASINOS ?? 100)

export async function generateSeoPages(): Promise<void> {
  // Brand-merged casinos (wallets grouped into one row per real operator, dead
  // labels pruned) — gives few, clean, high-quality pages instead of per-wallet noise.
  const all = await aggregateBrands('casino')
  const ents = all.filter((e) => e.volume7d > 0 || e.reserves > 0)

  // build a stable, collision-free slug map, keyed by brand
  const slugMap = new Map<string, string>()
  const used = new Set<string>()
  let seq = 0
  for (const e of ents.slice().sort((a, b) => b.volume7d - a.volume7d)) {
    let s = slugify(e.brand) || `casino-${++seq}`
    if (used.has(s)) s = `${s}-${++seq}`
    used.add(s)
    slugMap.set(e.brand, s)
  }
  const slugOf = (e: BrandAgg) => slugMap.get(e.brand) ?? slugify(e.brand)

  const now = Date.now()
  let n = 0
  const writeAll = db.transaction(() => {
    // casino pages (top N by volume; quality filter already applied)
    const top = ents.slice().sort((a, b) => b.volume7d - a.volume7d).slice(0, MAX_CASINOS)
    for (const e of top) {
      const slug = slugOf(e)
      const idx = top.findIndex((x) => x.brand === e.brand)
      // 4 nearest peers by volume as "related" internal links
      const peers = [top[idx - 2], top[idx - 1], top[idx + 1], top[idx + 2]].filter(Boolean).map((x) => ({ slug: slugOf(x), label: x.brand }))
      const fallback = top.filter((x) => x.brand !== e.brand).slice(0, 4).map((x) => ({ slug: slugOf(x), label: x.brand }))
      const pg = casinoPage(e, slug, peers.length ? peers : fallback)
      upsert.run({ path: `/casino/${slug}`, kind: 'casino', title: pg.title, description: pg.description, html: pg.html, now })
      n++
    }
    // rankings
    for (const key of Object.keys(RANKINGS)) {
      const pg = rankingsPage(key, ents, slugOf)
      if (pg) {
        upsert.run({ path: `/rankings/${key}`, kind: 'rankings', title: pg.title, description: pg.description, html: pg.html, now })
        n++
      }
    }
    // chains — from the chains operators actually transact on
    const chainSet = new Set<string>()
    for (const e of ents) for (const c of e.byChain ?? []) if (c.value > 0) chainSet.add(slugify(c.chain))
    for (const cs of chainSet) {
      if (!cs) continue
      const pg = chainPage(cs, ents, slugOf)
      upsert.run({ path: `/chains/${cs}`, kind: 'chains', title: pg.title, description: pg.description, html: pg.html, now })
      n++
    }
    // methodology
    for (const topic of Object.keys(METHODOLOGY)) {
      const pg = methodologyPage(topic)!
      upsert.run({ path: `/methodology/${topic}`, kind: 'methodology', title: pg.title, description: pg.description, html: pg.html, now })
      n++
    }
  })
  writeAll()
  // prune casino pages that dropped out of the set (stale slugs)
  const keep = new Set<string>([...slugMap.values()].slice(0, MAX_CASINOS).map((s) => `/casino/${s}`))
  const stale = (db.prepare("SELECT path FROM seo_page WHERE kind='casino'").all() as { path: string }[]).filter((r) => !keep.has(r.path))
  if (stale.length) {
    const del = db.prepare('DELETE FROM seo_page WHERE path=?')
    db.transaction(() => stale.forEach((r) => del.run(r.path)))()
  }
  console.log(`[seo] rebuilt ${n} pages (${slugMap.size} casinos mapped, ${stale.length} pruned)`)
}

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
  const pr = (k: string) => (k === 'rankings' ? '0.8' : k === 'chains' ? '0.7' : k === 'methodology' ? '0.5' : '0.6')
  const urls = [
    ...core.map((c) => `<url><loc>${SITE}${c.loc}</loc><changefreq>${c.freq}</changefreq><priority>${c.pr}</priority></url>`),
    ...pages.map((p) => `<url><loc>${SITE}${p.path}</loc><changefreq>${p.kind === 'methodology' ? 'monthly' : 'daily'}</changefreq><priority>${pr(p.kind)}</priority></url>`),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

const HTML_CACHE = 'public, max-age=600, stale-while-revalidate=86400'

export function registerSeo(app: FastifyInstance) {
  const serve = (kind: string, build?: (slug: string) => string | null) => async (req: any, reply: any) => {
    const page = getPage(req.url.split('?')[0])
    if (page) return reply.type('text/html; charset=utf-8').header('Cache-Control', HTML_CACHE).send(page.html)
    // not generated (yet / unknown slug): clean 404, noindex, link home
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found — WCOIN.CASINO</title><body style="background:#0a0a0f;color:#e8e8ee;font:16px/1.6 system-ui;text-align:center;padding:80px"><h1 style="color:#f5b100">404</h1><p>This ${esc(kind)} page isn't available.</p><p><a style="color:#f5b100" href="/">← WCOIN.CASINO home</a></p></body>`)
  }
  app.get('/casino/:slug', serve('casino'))
  app.get('/rankings/:slug', serve('rankings'))
  app.get('/chains/:slug', serve('chains'))
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
