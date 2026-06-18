import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowDownRight, ArrowUpRight, ShieldCheck, TrendingUp, Sparkles } from 'lucide-react'
import { Logo, Card, ChainPill } from '../components/ui'
import { CountUp } from '../components/motion'
import { api, usePoll } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

// ─────────────────────────────────────────────────────────────────────────────
// Public daily report. Renders the precomputed daily_market_snapshot in full —
// the target of the homepage "Full daily report →" link and the email digest's
// "Read the full daily report" CTA. Reads ONLY the snapshot endpoint (never raw
// transfers), so it's cheap and CF-cacheable. Numbers are on-chain observations;
// the methodology note keeps us out of solvency/legality claims.
// ─────────────────────────────────────────────────────────────────────────────

// Top badge no longer claims a single whole-page confidence (the page mixes verified
// flow, low-confidence unattributed flow and partial reserve coverage). It states the
// LENS instead; confidence/coverage is shown per module.
function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-mint-500/30 bg-mint-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-mint-400">
      <ShieldCheck size={12} /> Verified Flow View
    </span>
  )
}

// hover-explainer (native title — accessible, zero-dep). Use on easily-misread fields.
function Tip({ text }: { text: string }) {
  return (
    <span title={text} className="ml-1 inline-grid h-3.5 w-3.5 cursor-help place-items-center rounded-full border border-white/20 align-middle text-[9px] font-bold text-white/45">
      i
    </span>
  )
}

// per-module coverage/confidence note (small, muted, below a module header)
function ModuleNote({ children }: { children: React.ReactNode }) {
  return <div className="px-5 pb-3 pt-0 text-[11px] leading-relaxed text-white/35">{children}</div>
}

const COVERAGE: Record<string, [string, string]> = {
  high: ['Coverage: High', 'text-mint-400 bg-mint-400/12'],
  medium: ['Coverage: Medium', 'text-gold-400 bg-gold-400/12'],
  partial: ['Coverage: Partial', 'text-white/55 bg-white/8'],
  under_review: ['Coverage: Under review', 'text-rose-300 bg-rose-400/12'],
  unknown: ['Coverage: Unknown', 'text-white/45 bg-white/6'],
}
function CoverageChip({ level }: { level: string }) {
  const [label, cls] = COVERAGE[level] ?? COVERAGE.unknown
  return <span className={`hidden rounded px-1.5 py-0.5 text-[11px] font-medium sm:inline ${cls}`}>{label}</span>
}

// Compact email capture (double opt-in) — mirrors the homepage lead CTA.
function SubscribeBox() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!/.+@.+\..+/.test(email)) return
    setState('sending')
    try {
      await api.subscribe(email)
      setState('sent')
    } catch {
      setState('error')
    }
  }
  if (state === 'sent')
    return (
      <p className="text-sm text-mint-400">
        ✓ Check your inbox — confirm the link to start receiving the daily report.
      </p>
    )
  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        className="flex-1 rounded-xl border border-white/12 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/35 focus:border-gold-500/50 focus:outline-none"
      />
      <button
        type="submit"
        disabled={state === 'sending'}
        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-5 py-3 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
      >
        {state === 'sending' ? 'Sending…' : 'Get it daily'} <ArrowRight size={15} />
      </button>
    </form>
  )
}

function StatGrid({ data }: { data: any }) {
  const net = data.net_flow_24h ?? 0
  const rc = data.reserve_change_7d
  const cells: { label: string; value: string; raw?: number; fmt?: (n: number) => string; tone?: string; sub?: string; tip?: string }[] = [
    { label: '24H Verified Tracked Volume', value: fmtUsd(data.tracked_volume_24h ?? 0), raw: data.tracked_volume_24h ?? 0, fmt: fmtUsd, tip: 'Tracked volume from verified casino brands only. Unattributed casino-related flow is excluded from this figure.' },
    { label: 'Net Flow (24h)', value: (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), raw: Math.abs(net), fmt: (n) => (net >= 0 ? '+' : '−') + fmtUsd(n), tone: net >= 0 ? 'text-mint-400' : 'text-rose-400', tip: 'Verified inflow minus outflow over the last 24h. Positive = net deposits into tracked casino wallets.' },
    { label: 'Active Verified Brands', value: fmtNum(data.active_casinos ?? 0), raw: data.active_casinos ?? 0, fmt: fmtNum, tip: 'Verified casino brands with observed tracked on-chain flow during the selected time window (24h).' },
    { label: 'Active Chains', value: String(data.active_chains ?? 0), tip: 'Blockchains with verified casino settlement observed in the window.' },
    { label: 'Live Streamers', value: String(data.live_streamers ?? 0), tip: 'Gambling streamers detected live across Kick, Twitch and YouTube. Coverage varies by platform.' },
    {
      label: 'Tracked Reserves',
      value: fmtUsd(data.reserves_total ?? 0),
      raw: data.reserves_total ?? 0,
      fmt: fmtUsd,
      sub: rc != null ? `${rc >= 0 ? '+' : ''}${(rc * 100).toFixed(1)}% 7d` : undefined,
      tip: 'All-chain best-effort estimate of reserves from mapped wallets. Coverage is partial by brand — not a complete financial statement.',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <Card key={c.label} spotlight className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-white/40">
            {c.label}
            {c.tip && <Tip text={c.tip} />}
          </div>
          <div className={`mt-1.5 font-display text-xl font-bold tabular-nums ${c.tone ?? ''}`}>
            {c.raw != null && c.fmt ? <CountUp value={c.raw} format={c.fmt} /> : c.value}
          </div>
          {c.sub && <div className="mt-0.5 text-[11px] text-white/40">{c.sub}</div>}
        </Card>
      ))}
    </div>
  )
}

function MoversTable({ rows }: { rows: any[] }) {
  const [tab, setTab] = useState<'vol' | 'in' | 'out'>('vol')
  if (!rows?.length) return null
  const sorted =
    tab === 'vol'
      ? [...rows].sort((a, b) => (b.vol24h ?? 0) - (a.vol24h ?? 0))
      : tab === 'in'
        ? rows.filter((r) => (r.net7d ?? 0) > 0).sort((a, b) => (b.net7d ?? 0) - (a.net7d ?? 0))
        : rows.filter((r) => (r.net7d ?? 0) < 0).sort((a, b) => (a.net7d ?? 0) - (b.net7d ?? 0))
  const view = sorted.slice(0, 8)
  const TABS = [['vol', 'By 24h Volume'], ['in', 'By Net Inflow'], ['out', 'By Net Outflow']] as const
  return (
    <Card spotlight className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 px-5 py-3">
        <div className="flex items-center gap-2">
          <TrendingUp size={16} className="text-gold-400" />
          <h3 className="font-display text-base font-semibold">Biggest movers — verified</h3>
        </div>
        <div className="flex gap-1 rounded-lg border border-white/8 bg-white/4 p-0.5">
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition ${tab === k ? 'bg-gold-500/15 text-gold-400' : 'text-white/45 hover:text-white'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="divide-y divide-white/5">
        {view.length === 0 && <div className="px-5 py-6 text-center text-sm text-white/40">No {tab === 'in' ? 'net inflows' : 'net outflows'} in this window.</div>}
        {view.map((m, i) => {
          const rep = m.repSignal ?? m.trust
          const net = m.net7d ?? 0
          return (
            <div key={m.label} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="w-5 text-center font-bold text-white/30">{i + 1}</span>
              <span className="flex-1 truncate font-medium">{m.label}</span>
              {rep != null && (
                <span title="Composite reputation indicator from available third-party and on-chain signals. Not a recommendation, safety rating, or endorsement." className="hidden cursor-help text-xs text-white/40 sm:inline">
                  Rep. {Math.round(rep)}
                </span>
              )}
              {tab === 'vol' ? (
                <>
                  <span className="w-24 text-right tabular-nums text-white/45">7d {fmtUsd(m.vol7d)}</span>
                  <span className="w-24 text-right font-semibold tabular-nums text-gold-400">{fmtUsd(m.vol24h)}</span>
                </>
              ) : (
                <span className={`w-32 text-right font-semibold tabular-nums ${net >= 0 ? 'text-mint-400' : 'text-rose-400'}`}>
                  {net >= 0 ? '+' : '−'}
                  {fmtUsd(Math.abs(net))} <span className="font-normal text-white/35">7d net</span>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <ModuleNote>Verified casino brands only. “Rep.” is a composite reputation signal, not a safety rating. Net flow shown over the 7d window.</ModuleNote>
    </Card>
  )
}

function ChainBars({ rows }: { rows: any[] }) {
  const [mode, setMode] = useState<'share' | 'abs'>('share')
  if (!rows?.length) return null
  const total = rows.reduce((s, r) => s + (r.vol24h || 0), 0) || 1
  const max = Math.max(...rows.map((r) => r.vol24h || 0), 1)
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-base font-semibold">Volume by chain — 24h</h3>
        <div className="flex gap-1 rounded-lg border border-white/8 bg-white/4 p-0.5">
          {(['share', 'abs'] as const).map((k) => (
            <button key={k} onClick={() => setMode(k)} className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition ${mode === k ? 'bg-gold-500/15 text-gold-400' : 'text-white/45 hover:text-white'}`}>
              {k === 'share' ? 'Share' : 'Absolute'}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2.5">
        {rows.slice(0, 8).map((c) => {
          const share = (c.vol24h || 0) / total
          return (
            <div key={c.chain} className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <ChainPill chain={c.chain} />
              </div>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-gold-400 to-gold-600" style={{ width: `${Math.max(2, mode === 'share' ? share * 100 : (c.vol24h / max) * 100)}%` }} />
              </div>
              <span className="w-24 text-right text-sm font-semibold tabular-nums text-white/70">{mode === 'share' ? `${(share * 100).toFixed(1)}%` : fmtUsd(c.vol24h)}</span>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[11px] text-white/35">Share view normalises chains so smaller networks stay readable when one chain dominates.</p>
    </Card>
  )
}

function MarketConcentration({ c }: { c: any }) {
  if (!c) return null
  const pct = (x: number) => `${((x ?? 0) * 100).toFixed(1)}%`
  const items = [
    { k: 'Top 3 verified brands', v: pct(c.top3Share) },
    { k: 'Top 5 verified brands', v: pct(c.top5Share) },
    { k: `Top chain${c.topChain ? ` · ${c.topChain}` : ''}`, v: pct(c.topChainShare) },
  ]
  return (
    <Card spotlight className="p-5">
      <h3 className="mb-1 font-display text-base font-semibold">
        Market Concentration
        <Tip text="How concentrated the day's verified volume is among the top brands and the leading chain. High concentration = the day was driven by a few players, not broad activity." />
      </h3>
      <p className="mb-3 text-[12px] text-white/45">Share of 24h verified volume.</p>
      <div className="grid grid-cols-3 gap-3">
        {items.map((it) => (
          <div key={it.k} className="rounded-xl border border-white/8 bg-white/[0.02] p-3 text-center">
            <div className="font-display text-xl font-bold tabular-nums text-gradient-gold">{it.v}</div>
            <div className="mt-1 text-[11px] leading-tight text-white/50">{it.k}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function SourceHealth({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  const dot = (s: string) => (s === 'Healthy' ? 'bg-mint-400' : s === 'Delayed' ? 'bg-gold-400' : s === 'Unknown' ? 'bg-white/30' : 'bg-rose-400')
  const ago = (m: number | null) => (m == null || m < 1 ? '' : ` · ${m < 60 ? `${m}m` : `${Math.round(m / 60)}h`} ago`)
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-display text-base font-semibold">
        Source Health
        <Tip text="User-readable status of the data sources feeding this report — not engineering monitoring." />
      </h3>
      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.source} className="flex items-center gap-3 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot(r.status)}`} />
            <span className="flex-1 text-white/70">{r.source}</span>
            <span className="text-white/45">{r.status}{ago(r.lagMin)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

// Executive Insight — AI-written "Today's Market Read" (What changed / Why it matters /
// What to watch). The model only expresses; every number is program-injected + QA-gated.
function MarketRead({ read }: { read: any }) {
  if (!read || !(read.what_changed || read.why_it_matters || read.what_to_watch)) return null
  const secs = [
    { k: 'What changed', v: read.what_changed },
    { k: 'Why it matters', v: read.why_it_matters },
    { k: 'What to watch next', v: read.what_to_watch },
  ].filter((s) => s.v)
  return (
    <Card spotlight className="p-6">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={16} className="text-gold-400" />
        <h3 className="font-display text-lg font-semibold">Today’s Market Read</h3>
      </div>
      <div className="space-y-3">
        {secs.map((s) => (
          <div key={s.k}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gold-400/80">{s.k}</div>
            <p className="mt-0.5 text-[14px] leading-relaxed text-white/75">{s.v}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-white/30">AI-written summary of the verified data above. Figures are program-injected; the model does not generate numbers, rankings or names.</p>
    </Card>
  )
}

function NotableSignals({ signals }: { signals: string[] }) {
  if (!signals?.length) return null
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-display text-base font-semibold">Notable Signals</h3>
      <ol className="space-y-2 text-[13.5px] text-white/70">
        {signals.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="font-bold text-gold-400">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function CoverageNotes() {
  const notes = [
    'Verified flow includes only mapped casino brands with medium or higher confidence.',
    'Unattributed casino-related flow is excluded from all verified totals and rankings.',
    'Reserve coverage may be partial by brand and is shown as a level, not a percentage.',
    'Streamer coverage varies by platform availability.',
  ]
  return (
    <Card className="p-5">
      <h3 className="mb-2 font-display text-base font-semibold">Data Coverage Notes</h3>
      <ul className="space-y-1.5 text-[13px] text-white/55">
        {notes.map((n, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-gold-400">•</span>
            {n}
          </li>
        ))}
      </ul>
    </Card>
  )
}

// Aggregated whale activity (grouped by brand·chain·direction). Each row expands to
// the underlying raw transfers — replaces the old raw-ticker that spammed the same
// brand+amount and read like a feed, not an insight.
function WhaleGroups({ groups, events }: { groups: any[]; events: any[] }) {
  const [open, setOpen] = useState<string | null>(null)
  // backward-compat: a snapshot from before aggregation has only raw `events`
  const list = groups?.length
    ? groups
    : (events ?? []).slice(0, 8).map((e: any) => ({ label: e.label, chain: e.chain, direction: e.direction, count: 1, total: e.usd, largest: e.usd }))
  if (!list.length) return null
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-white/8 px-5 py-3.5">
        <h3 className="font-display text-base font-semibold">
          Whale Activity — Aggregated
          <Tip text="Aggregated large wallet transfers (≥ $50K) involving tracked casino-related wallets. Click a row to see the underlying transactions." />
        </h3>
      </div>
      <div className="max-h-80 divide-y divide-white/5 overflow-y-auto">
        {list.map((g: any) => {
          const key = `${g.label}:${g.chain}:${g.direction}`
          const isIn = g.direction === 'in'
          const ev = open === key ? (events ?? []).filter((e: any) => e.label === g.label && e.chain === g.chain && e.direction === g.direction) : []
          return (
            <div key={key}>
              <button onClick={() => setOpen(open === key ? null : key)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm hover:bg-white/[0.02]">
                <span className={isIn ? 'text-mint-400' : 'text-rose-400'}>{isIn ? <ArrowDownRight size={15} /> : <ArrowUpRight size={15} />}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{g.label}</div>
                  <div className="text-[11px] text-white/40">
                    {g.count} whale {isIn ? 'inflow' : 'outflow'}{g.count > 1 ? 's' : ''} · largest {fmtUsd(g.largest)}
                  </div>
                </div>
                <ChainPill chain={g.chain} />
                <span className={`w-24 text-right font-semibold tabular-nums ${isIn ? 'text-mint-400' : 'text-rose-400'}`}>
                  {isIn ? '+' : '−'}
                  {fmtUsd(g.total)}
                </span>
              </button>
              {open === key && ev.length > 0 && (
                <div className="bg-white/[0.02] px-5 pb-2 pt-0.5">
                  {ev.map((e: any, j: number) => (
                    <div key={j} className="flex items-center gap-2 py-1 text-[12px] text-white/55">
                      <span className="text-white/30">{new Date(e.ts).toISOString().slice(11, 16)} UTC</span>
                      <span className="flex-1" />
                      <span className="tabular-nums">{isIn ? '+' : '−'}{fmtUsd(e.usd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <ModuleNote>Whale activity reflects observed large wallet transfers involving tracked casino-related wallets. It does not indicate user identity or intent.</ModuleNote>
    </Card>
  )
}

function ReserveList({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3.5">
        <ShieldCheck size={16} className="text-mint-400" />
        <h3 className="font-display text-base font-semibold">
          Tracked All-chain Reserves
          <Tip text="Observed wallet balances for verified casino brands. Coverage may be partial and is not a complete financial statement." />
        </h3>
      </div>
      <div className="divide-y divide-white/5">
        {rows.map((r, i) => (
          <div key={r.label} className="flex items-center gap-3 px-5 py-3 text-sm">
            <span className="w-5 text-center font-bold text-white/30">{i + 1}</span>
            <span className="flex-1 truncate font-medium">{r.label}</span>
            <CoverageChip level={r.level ?? 'unknown'} />
            <span className="w-24 text-right font-semibold tabular-nums text-mint-400">{fmtUsd(r.reserves)}</span>
          </div>
        ))}
      </div>
      <ModuleNote>
        Observed wallet balances for verified casino brands. Coverage may be partial — not a complete financial statement.{' '}
        <a href="/methodology/proof-of-reserves" className="text-gold-400 hover:underline">How this is calculated →</a>
      </ModuleNote>
    </Card>
  )
}

export default function Daily() {
  const { data } = usePoll(api.marketSnapshot, 60_000)
  const ready = data && !data.error
  const p = data?.payload

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-white/7 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
          <Link to="/">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/" className="rounded-lg px-3 py-2 text-sm font-medium text-white/70 hover:text-white">
              Home
            </Link>
            <Link
              to="/app"
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-gold-400 to-gold-600 px-4 py-2 text-sm font-semibold text-ink-950 hover:brightness-110"
            >
              Live dashboard <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Crypto Casino Market — Daily</h1>
            {ready && <VerifiedBadge />}
          </div>
          <p className="mt-2 text-sm text-white/55">
            {ready ? (
              <>
                On-chain snapshot for <span className="font-semibold text-white/80">{data.snapshot_date} (UTC)</span> — tracked
                volume, net flow, whale moves and all-chain reserves across the crypto-casino market.
              </>
            ) : (
              'Building today’s snapshot…'
            )}
          </p>
        </div>

        {!ready ? (
          <Card className="p-10 text-center text-sm text-white/40">The daily snapshot is generating — check back shortly.</Card>
        ) : (
          <div className="space-y-6">
            <StatGrid data={data} />

            <MarketRead read={data.aiMarketRead} />

            <div className="grid gap-6 lg:grid-cols-2">
              <MarketConcentration c={p?.concentration} />
              <NotableSignals signals={data.aiNotableSignals ?? []} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <MoversTable rows={p?.topMovers ?? []} />
              <ChainBars rows={p?.chainVolume ?? []} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <WhaleGroups groups={p?.whaleGroups ?? []} events={p?.whales ?? []} />
              <ReserveList rows={p?.topReserves ?? []} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <SourceHealth rows={p?.sourceHealth ?? []} />
              <CoverageNotes />
            </div>

            {/* Unattributed flow — pattern-detected, shown separately from verified totals */}
            {p?.unattributed && p.unattributed.count > 0 && (
              <Card className="p-5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-base font-semibold">Unattributed Casino-related Flow</h3>
                  <span className="text-[13px] text-white/50">
                    {p.unattributed.count} clusters · {fmtUsd(p.unattributed.vol7d)} 7d{' '}
                    <span className="rounded bg-white/8 px-1.5 py-0.5 text-[11px] text-white/45">confidence: low</span>
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-white/45">
                  Pattern-detected casino-related wallet activity that has <strong className="text-white/65">not yet been attributed</strong> to a
                  verified casino brand. These flows are <strong className="text-white/65">excluded from every verified figure and ranking above</strong> until
                  attribution improves — they are shown here for transparency, not as a verdict on any operator.{' '}
                  <a href="/rankings/unattributed-flow" className="text-gold-400 hover:underline">View details →</a>{' '}
                  <a href="/methodology/address-attribution" className="text-gold-400 hover:underline">Attribution methodology →</a>
                </p>
              </Card>
            )}

            {/* Subscribe CTA */}
            <Card spotlight className="ring-gold flex flex-col items-center gap-4 p-8 text-center">
              <h2 className="font-display text-2xl font-bold">
                Get this report <span className="text-gradient-gold">every morning</span>
              </h2>
              <p className="max-w-lg text-sm text-white/55">
                One email a day: the numbers above, summarised. Free, no account needed — confirm with a one-click link.
              </p>
              <SubscribeBox />
            </Card>

            {/* Historical reports entry */}
            {data.snapshot_date && (
              <div className="px-1 text-[13px] text-white/45">
                <a href={`/reports/daily/${new Date(new Date(data.snapshot_date + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)}`} className="text-gold-400 hover:underline">
                  ← Previous daily reports
                </a>
              </div>
            )}

            {/* Methodology */}
            <p className="px-1 text-xs leading-relaxed text-white/35">
              <span className="font-semibold text-white/50">Methodology.</span> Figures are derived from on-chain transfers
              attributed to crypto-casino entities and third-party reserve data, each with inherent attribution uncertainty.
              They reflect observed blockchain activity over the stated window and are <span className="text-white/50">not</span> a
              statement on any operator’s solvency, legality, or financial health. Reserves are an all-chain best-effort estimate
              from mapped wallets; coverage varies by operator. Nothing here is financial advice.{' '}
              <Link to="/app/sentiment" className="text-gold-400 hover:underline">
                Explore the live data →
              </Link>
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/7 bg-ink-900/40">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <Logo />
          <p className="text-sm text-white/40">© 2026 WCOIN.CASINO — The Intelligence Layer for iGaming</p>
          <Link to="/" className="text-sm text-white/50 hover:text-white">
            ← Back home
          </Link>
        </div>
      </footer>
    </div>
  )
}
