import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowDownRight, ArrowUpRight, ShieldCheck, TrendingUp } from 'lucide-react'
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
  if (!rows?.length) return null
  return (
    <Card spotlight className="overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3.5">
        <TrendingUp size={16} className="text-gold-400" />
        <h3 className="font-display text-base font-semibold">Biggest movers — 24h verified volume</h3>
      </div>
      <div className="divide-y divide-white/5">
        {rows.map((m, i) => {
          const rep = m.repSignal ?? m.trust
          return (
            <div key={m.label} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="w-5 text-center font-bold text-white/30">{i + 1}</span>
              <span className="flex-1 truncate font-medium">{m.label}</span>
              {rep != null && (
                <span title="Composite reputation indicator from available third-party and on-chain signals. Not a recommendation, safety rating, or endorsement." className="hidden cursor-help text-xs text-white/40 sm:inline">
                  Rep. {Math.round(rep)}
                </span>
              )}
              <span className="w-24 text-right tabular-nums text-white/45">7d {fmtUsd(m.vol7d)}</span>
              <span className="w-24 text-right font-semibold tabular-nums text-gold-400">{fmtUsd(m.vol24h)}</span>
            </div>
          )
        })}
      </div>
      <ModuleNote>Verified casino brands only · ranked by 24h tracked volume. “Rep.” is a composite reputation signal, not a safety rating.</ModuleNote>
    </Card>
  )
}

function ChainBars({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  const max = Math.max(...rows.map((r) => r.vol24h || 0), 1)
  return (
    <Card className="p-5">
      <h3 className="mb-4 font-display text-base font-semibold">Volume by chain — 24h</h3>
      <div className="space-y-2.5">
        {rows.slice(0, 8).map((c) => (
          <div key={c.chain} className="flex items-center gap-3">
            <div className="w-20 shrink-0">
              <ChainPill chain={c.chain} />
            </div>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
              <div className="h-full rounded-full bg-gradient-to-r from-gold-400 to-gold-600" style={{ width: `${Math.max(2, (c.vol24h / max) * 100)}%` }} />
            </div>
            <span className="w-20 text-right text-sm font-semibold tabular-nums text-white/70">{fmtUsd(c.vol24h)}</span>
          </div>
        ))}
      </div>
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

            <div className="grid gap-6 lg:grid-cols-2">
              <MoversTable rows={p?.topMovers ?? []} />
              <ChainBars rows={p?.chainVolume ?? []} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <WhaleGroups groups={p?.whaleGroups ?? []} events={p?.whales ?? []} />
              <ReserveList rows={p?.topReserves ?? []} />
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
