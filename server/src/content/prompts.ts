import { latestMarketSnapshot } from '../snapshot.ts'
import { db } from '../db.ts'
import type { QaInput } from './qa.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Prompt + input builders. We hand the model ONLY pre-formatted figures from the
// daily snapshot (never raw numbers, never raw entities), and collect the exact
// set of formatted values + brand names so the QA filter can reject anything the
// model invents.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = 'https://tekeldata.com'
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
  // "ETH = 47.1% of chain volume" (the credible de-distorted split) and still pass the
  // number-consistency QA check.
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

const pctPlain = (f: number) => `${((f ?? 0) * 100).toFixed(1)}%`
const signed = (n: number, dp = 1) => (n >= 0 ? '+' : '') + n.toFixed(dp)

// Richer input for the daily "Market Read" ONLY: the base snapshot PLUS recent history
// (day-over-day and week-over-week deltas, chain-share rotation, concentration drift,
// the biggest movers and any new entrants) and yesterday's read — so the model can write
// genuine analysis that varies day to day instead of restating a single static snapshot.
// Every derived figure is pre-formatted and registered, so qaCheck still rejects anything
// invented. Returns null if there's no snapshot yet.
function insightInput(): { input: any; brands: string[]; values: string[]; reportUrl: string } | null {
  const base = snapshotInput()
  if (!base) return null
  const values = new Set(base.values)
  const brands = new Set(base.brands)
  const v = (s: string) => {
    values.add(s)
    return s
  }
  const parse = (s: any) => {
    try {
      return JSON.parse(s || '{}')
    } catch {
      return {}
    }
  }
  const hist = db
    .prepare(
      'SELECT snapshot_date, tracked_volume_24h, net_flow_24h, active_casinos, reserves_total, payload_json, ai_market_read FROM daily_market_snapshot ORDER BY snapshot_date DESC LIMIT 8',
    )
    .all() as any[]
  const today = hist[0] ?? {}
  const prev = hist[1] ?? null
  const weekAgo = hist.length >= 6 ? hist[Math.min(7, hist.length - 1)] : null
  const pct = (cur: number, b: number) => (b > 0 ? (cur - b) / b : null)
  const tp = parse(today.payload_json)
  const pp = parse(prev?.payload_json)
  const tc = tp.concentration || {}
  const pc = pp.concentration || {}

  const volDoD = prev ? pct(today.tracked_volume_24h, prev.tracked_volume_24h) : null
  const volWoW = weekAgo ? pct(today.tracked_volume_24h, weekAgo.tracked_volume_24h) : null
  const resDoD = prev ? pct(today.reserves_total, prev.reserves_total) : null
  const acDelta = prev != null ? (today.active_casinos ?? 0) - (prev.active_casinos ?? 0) : null
  // absolute deltas too — the model often expresses a change in $ rather than %, and
  // every figure it cites must be pre-registered or qaCheck rejects the whole insight
  const volAbsDoD = prev ? (today.tracked_volume_24h ?? 0) - (prev.tracked_volume_24h ?? 0) : null
  const resAbsDoD = prev ? (today.reserves_total ?? 0) - (prev.reserves_total ?? 0) : null

  // mover dynamics from today's verified top movers (change24h is already a percent)
  const movers = (tp.topMovers ?? []) as any[]
  const byChange = movers.filter((m) => typeof m.change24h === 'number' && Math.abs(m.change24h) > 0)
  const gain = [...byChange].sort((a, b) => b.change24h - a.change24h)[0]
  const drop = [...byChange].sort((a, b) => a.change24h - b.change24h)[0]
  const prevMovers = new Set((pp.topMovers ?? []).map((m: any) => m.label))
  const newEntrants = movers.filter((m) => !prevMovers.has(m.label)).map((m) => m.label).slice(0, 3)

  const recent_trends = {
    days_of_history: hist.length,
    verified_volume_24h_dod: volDoD != null ? v(fmtPct(volDoD)) : null,
    verified_volume_24h_wow: volWoW != null ? v(fmtPct(volWoW)) : null,
    verified_volume_24h_change_abs: volAbsDoD != null ? v(fmtUsd(volAbsDoD)) : null,
    reserves_total_dod: resDoD != null ? v(fmtPct(resDoD)) : null,
    reserves_total_change_abs: resAbsDoD != null ? v(fmtUsd(resAbsDoD)) : null,
    active_casinos_change: acDelta != null ? signed(acDelta, 0) : null,
    net_flow_24h_today: today.net_flow_24h != null ? v(fmtUsd(today.net_flow_24h)) : null,
    net_flow_24h_yesterday: prev?.net_flow_24h != null ? v(fmtUsd(prev.net_flow_24h)) : null,
    top_chain: tc.topChain ?? null,
    top_chain_share_today: tc.topChainShare != null ? v(pctPlain(tc.topChainShare)) : null,
    top_chain_share_yesterday: pc.topChainShare != null ? v(pctPlain(pc.topChainShare)) : null,
    top3_brand_share_today: tc.top3Share != null ? v(pctPlain(tc.top3Share)) : null,
    top3_brand_share_yesterday: pc.top3Share != null ? v(pctPlain(pc.top3Share)) : null,
    biggest_24h_gainer: gain ? { brand: gain.label, change_24h: v(signed(gain.change24h) + '%') } : null,
    biggest_24h_decliner: drop ? { brand: drop.label, change_24h: v(signed(drop.change24h) + '%') } : null,
    new_top_movers_today: newEntrants,
  }
  for (const m of [gain, drop]) if (m?.label) brands.add(m.label)
  const yesterday_read = prev?.ai_market_read ? parse(prev.ai_market_read) : null

  return {
    input: { ...base.input, recent_trends, yesterday_read_do_not_repeat: yesterday_read },
    brands: [...brands],
    values: [...values],
    reportUrl: base.reportUrl,
  }
}

export function buildPrompt(contentType: string): BuiltPrompt | null {
  const s = snapshotInput()
  if (!s) return null
  const base = 'You are the automated editorial engine for Tekel Data, an independent on-chain intelligence site for crypto casinos. '
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
    // page/email insight — richer input (history/trends + yesterday's read), no tweet/URL
    const ii = insightInput()
    if (!ii) return null
    const insightQa: QaInput = { allowedBrands: ii.brands, allowedValues: ii.values, numberTolerance: true }
    const system =
      base +
      `You are writing today's "Market Read" for the daily report PAGE (not social). Inputs: today's verified on-chain snapshot; a recent_trends block (day-over-day & week-over-week deltas, chain-share rotation, concentration drift, biggest 24h movers, new entrants, days_of_history); and yesterday_read_do_not_repeat (yesterday's read).\n${RULES}\n` +
      `Write genuine ANALYSIS, not a restatement of today's numbers:\n` +
      `- LEAD with the single most notable real shift vs the recent baseline, taken from recent_trends (a volume swing, a chain-share rotation, a concentration shift, a standout or new mover). If little changed, say so plainly and name what is holding steady — do not manufacture drama.\n` +
      `- SYNTHESISE across signals when the data supports it (e.g. volume down while reserves hold → an activity dip, not liquidity stress; share moving ETH→TRON → rotation toward cheaper stablecoin rails). Only connect signals the data actually shows.\n` +
      `- Make what_to_watch FORWARD-LOOKING and specific to THIS day's setup — a concrete level, share threshold, brand or trend to watch next — never generic boilerplate.\n` +
      `- VARY from yesterday_read_do_not_repeat: a different lead and angle, never its phrasing. The reader sees these daily; repetition kills the value.\n` +
      `- 2-3 sentences per field, neutral and data-only. Describe observed structure; never invent motive or causes you cannot see. Cite figures EXACTLY as formatted in the input (recent_trends deltas are pre-computed for you — use them, don't recompute).\n` +
      `- "notable_signals": 3-5 short ANALYTICAL one-liners, each a trend or contrast (e.g. "TRON share rose to 45% from 41% d/d", "reserves flat despite the volume dip"), not static facts.\n` +
      `- Write in natural prose. NEVER echo the raw input field names: say "verified 24h volume fell 29% day-over-day", NOT "verified_volume_24h_dod -29.0%"; say "net inflow of $11.2M, up from -$2.7M", NOT "net_flow_24h_today +$11.2M". Use the figures, not the JSON keys.\n` +
      `Output JSON schema: {"market_read":{"what_changed":"...","why_it_matters":"...","what_to_watch":"..."},"notable_signals":["...","..."]}`
    return { contentType, system, user: JSON.stringify(ii.input), qa: insightQa }
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
