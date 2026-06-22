import { latestMarketSnapshot } from '../snapshot.ts'
import type { QaInput } from './qa.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Prompt + input builders. We hand the model ONLY pre-formatted figures from the
// daily snapshot (never raw numbers, never raw entities), and collect the exact
// set of formatted values + brand names so the QA filter can reject anything the
// model invents.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = 'https://wcoin.casino'
function fmtUsd(n: number): string {
  const a = Math.abs(n || 0)
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
  return '$' + Math.round(n || 0)
}
const fmtPct = (f: number) => (f >= 0 ? '+' : '') + (f * 100).toFixed(1) + '%'

export interface BuiltPrompt {
  contentType: string
  system: string
  user: string
  qa: QaInput
}

const RULES = `Rules:
- Output valid JSON only, matching the schema. No prose outside JSON.
- Use ONLY the figures provided, exactly as formatted. Never invent, round, or recompute a number.
- Do not infer unknown wallet ownership. Do not include any brand not present in the input.
- Never describe any operator as scam, fraud, insolvent, illegal, bankrupt, rug pull, criminal, fake or collapsing. Use neutral, data-driven language.
- Clearly separate VERIFIED casino flow from UNATTRIBUTED casino-related flow.
- Include data-confidence notes where relevant.
- Each tweet must be concise and under 280 characters.`

// returns the snapshot + the allowed brands/values lists, or null if no snapshot
function snapshotInput(): { input: any; brands: string[]; values: string[]; reportUrl: string } | null {
  const snap = latestMarketSnapshot()
  if (!snap || snap.error) return null
  const p = snap.payload || {}
  const values = new Set<string>()
  const brands = new Set<string>()
  const v = (s: string) => {
    values.add(s)
    return s
  }
  const movers = (p.topMovers ?? []).slice(0, 6).map((m: any) => {
    brands.add(m.label)
    return { brand: m.label, volume_24h: v(fmtUsd(m.vol24h)), volume_7d: v(fmtUsd(m.vol7d ?? 0)) }
  })
  const COV: Record<string, string> = { high: 'High', medium: 'Medium', partial: 'Partial', under_review: 'Under review', unknown: 'Unknown' }
  const reserves = (p.topReserves ?? []).slice(0, 6).map((r: any) => {
    brands.add(r.label)
    return { brand: r.label, reserves: v(fmtUsd(r.reserves)), coverage: COV[r.level] ?? 'Unknown' }
  })
  const chains = (p.chainVolume ?? []).slice(0, 8).map((c: any) => ({ chain: c.chain, volume_7d: v(fmtUsd(c.vol7d)) }))
  const whaleAgg = (p.whaleGroups ?? []).slice(0, 6).map((g: any) => {
    brands.add(g.label)
    return { brand: g.label, chain: g.chain, direction: g.direction === 'in' ? 'inflow' : 'outflow', events: g.count, total: v(fmtUsd(g.total)) }
  })
  // concentration shares — registered as allowed values so the insight may cite e.g.
  // "ETH = 96.0% of chain volume" and still pass the number-consistency QA check.
  const pctPlain = (f: number) => `${((f ?? 0) * 100).toFixed(1)}%`
  const c = p.concentration
  const concentration = c
    ? { top3_verified_brand_share: v(pctPlain(c.top3Share)), top5_verified_brand_share: v(pctPlain(c.top5Share)), top_chain: c.topChain, top_chain_share: v(pctPlain(c.topChainShare)) }
    : null
  const u = p.unattributed || { count: 0 }
  const reportUrl = `${SITE}/reports/daily/${snap.snapshot_date}`
  const input = {
    date_utc: snap.snapshot_date,
    market: {
      tracked_volume_24h: v(fmtUsd(snap.tracked_volume_24h ?? 0)),
      net_flow_24h: v((snap.net_flow_24h >= 0 ? '+' : '') + fmtUsd(snap.net_flow_24h ?? 0).replace('$', '$')),
      active_verified_casinos: String(snap.active_casinos ?? 0),
      active_chains: String(snap.active_chains ?? 0),
      live_streamers: String(snap.live_streamers ?? 0),
      tracked_reserves_total: v(fmtUsd(snap.reserves_total ?? 0)),
      reserve_change_7d: snap.reserve_change_7d != null ? v(fmtPct(snap.reserve_change_7d)) : null,
      data_confidence: snap.confidence_level || 'medium',
    },
    market_concentration: concentration,
    top_verified_casino_flow_24h: movers,
    reserve_watch: reserves,
    chain_breakdown_24h: chains,
    whale_activity_aggregated: whaleAgg,
    unattributed_flow: { clusters: u.count ?? 0, observed_7d: u.vol7d ? v(fmtUsd(u.vol7d)) : '$0' },
    report_url: reportUrl,
    rankings_url: `${SITE}/rankings/trust`,
    methodology_url: `${SITE}/methodology/data-confidence`,
  }
  return { input, brands: [...brands], values: [...values], reportUrl }
}

export function buildPrompt(contentType: string): BuiltPrompt | null {
  const s = snapshotInput()
  if (!s) return null
  const base = 'You are the automated editorial engine for WCOIN.CASINO, an independent on-chain intelligence site for crypto casinos. '
  const qa: QaInput = { allowedBrands: s.brands, allowedValues: s.values, requiredUrl: s.reportUrl }

  if (contentType === 'daily_market_thread') {
    const system =
      base +
      `Generate an X thread (5-7 tweets) using only the structured data provided.\n${RULES}\n- The thread should cover, in order: market snapshot, top verified casino flow, reserve watch, chain breakdown, an unattributed-flow note, and a closing tweet with the full daily report URL.\n- The FINAL tweet must include this URL: ${s.reportUrl}\nOutput JSON schema: {"content_type":"daily_market_thread","risk_level":"low|medium|high","tweets":[{"text":"..."}],"links":["..."],"data_notes":["..."]}`
    return { contentType, system, user: JSON.stringify(s.input), qa }
  }
  if (contentType === 'top_ranking_image_post') {
    qa.requiredUrl = s.input.rankings_url
    const system =
      base +
      `Generate one X post plus image-card copy for the top verified crypto-casino flows. Use only the verified brand-level data provided.\n${RULES}\n- Do not include unattributed entities.\n- Provide a short image title and subtitle and up to 6 ranked rows.\n- Include the ranking URL: ${s.input.rankings_url}\n- No affiliate language (no "best casino", "play now", "bonus", "promo").\nOutput JSON schema: {"content_type":"top_ranking_image_post","post_text":"...","image":{"title":"...","subtitle":"...","rows":[{"rank":1,"brand":"...","value":"..."}],"footer":"No paid rankings — public, verifiable data"},"target_url":"...","risk_level":"low|medium|high"}`
    return { contentType, system, user: JSON.stringify(s.input), qa }
  }
  if (contentType === 'daily_insight') {
    // page/email insight — no tweet, no URL requirement
    const insightQa: QaInput = { allowedBrands: s.brands, allowedValues: s.values }
    const system =
      base +
      `Generate the daily "Market Read" and notable signals for the report PAGE (not social media). Use ONLY the structured data provided.\n${RULES}\n- "market_read" has exactly three fields: what_changed, why_it_matters, what_to_watch. Each is 1-2 sentences, neutral, derived only from the data. If a section lacks data, write a brief neutral note.\n- "notable_signals" is 3-5 short factual one-line signals drawn ONLY from the data (e.g. chain dominance, top brand by verified volume, reserve concentration, unattributed flow exclusion).\n- Never describe causes you cannot see; describe observed structure, not motive.\nOutput JSON schema: {"market_read":{"what_changed":"...","why_it_matters":"...","what_to_watch":"..."},"notable_signals":["...","..."]}`
    return { contentType, system, user: JSON.stringify(s.input), qa: insightQa }
  }
  if (contentType === 'rotating_signal_post') {
    const system =
      base +
      `Generate ONE concise single X post about the most noteworthy signal among: reserve watch, chain breakdown, or unattributed flow — pick whichever is most informative from the data.\n${RULES}\n- Include the report URL: ${s.reportUrl}\nOutput JSON schema: {"content_type":"rotating_signal_post","post_text":"...","links":["${s.reportUrl}"],"risk_level":"low|medium|high"}`
    return { contentType, system, user: JSON.stringify(s.input), qa }
  }
  return null // weekly_recap / monthly_report require weekly/monthly rollups (not yet built)
}

export const CONTENT_TYPES = ['daily_market_thread', 'top_ranking_image_post', 'rotating_signal_post'] as const
