import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowDownRight, ArrowUpRight, ShieldCheck, TrendingUp } from 'lucide-react'
import { Logo, Card, ChainPill } from '../components/ui'
import { api, usePoll } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

// ─────────────────────────────────────────────────────────────────────────────
// Public daily report. Renders the precomputed daily_market_snapshot in full —
// the target of the homepage "Full daily report →" link and the email digest's
// "Read the full daily report" CTA. Reads ONLY the snapshot endpoint (never raw
// transfers), so it's cheap and CF-cacheable. Numbers are on-chain observations;
// the methodology note keeps us out of solvency/legality claims.
// ─────────────────────────────────────────────────────────────────────────────

function ConfidencePill({ level }: { level: string }) {
  const map: Record<string, string> = {
    high: 'border-mint-500/30 bg-mint-500/10 text-mint-400',
    medium: 'border-gold-500/30 bg-gold-500/10 text-gold-400',
    low: 'border-white/15 bg-white/5 text-white/50',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${map[level] ?? map.low}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" /> {level} confidence
    </span>
  )
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
  const cells = [
    { label: '24h Tracked Volume', value: fmtUsd(data.tracked_volume_24h ?? 0) },
    { label: 'Net Flow (24h)', value: (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)), tone: net >= 0 ? 'text-mint-400' : 'text-rose-400' },
    { label: 'Active Casinos', value: fmtNum(data.active_casinos ?? 0) },
    { label: 'Chains', value: String(data.active_chains ?? 0) },
    { label: 'Live Streamers', value: String(data.live_streamers ?? 0) },
    {
      label: 'Tracked Reserves',
      value: fmtUsd(data.reserves_total ?? 0),
      sub: rc != null ? `${rc >= 0 ? '+' : ''}${(rc * 100).toFixed(1)}% 7d` : undefined,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <Card key={c.label} className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-white/40">{c.label}</div>
          <div className={`mt-1.5 font-display text-xl font-bold tabular-nums ${c.tone ?? ''}`}>{c.value}</div>
          {c.sub && <div className="mt-0.5 text-[11px] text-white/40">{c.sub}</div>}
        </Card>
      ))}
    </div>
  )
}

function MoversTable({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3.5">
        <TrendingUp size={16} className="text-gold-400" />
        <h3 className="font-display text-base font-semibold">Biggest movers — 24h volume</h3>
      </div>
      <div className="divide-y divide-white/5">
        {rows.map((m, i) => (
          <div key={m.label} className="flex items-center gap-3 px-5 py-3 text-sm">
            <span className="w-5 text-center font-bold text-white/30">{i + 1}</span>
            <span className="flex-1 truncate font-medium">{m.label}</span>
            {m.trust != null && <span className="hidden text-xs text-white/40 sm:inline">trust {Math.round(m.trust)}</span>}
            <span className="w-24 text-right tabular-nums text-white/45">7d {fmtUsd(m.vol7d)}</span>
            <span className="w-24 text-right font-semibold tabular-nums text-gold-400">{fmtUsd(m.vol24h)}</span>
          </div>
        ))}
      </div>
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

function WhaleList({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-white/8 px-5 py-3.5">
        <h3 className="font-display text-base font-semibold">Whale activity — 24h (≥ $50K)</h3>
      </div>
      <div className="max-h-80 divide-y divide-white/5 overflow-y-auto">
        {rows.map((w, i) => (
          <div key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
            <span className={w.direction === 'in' ? 'text-mint-400' : 'text-rose-400'}>
              {w.direction === 'in' ? <ArrowDownRight size={15} /> : <ArrowUpRight size={15} />}
            </span>
            <span className="flex-1 truncate font-medium">{w.label}</span>
            <ChainPill chain={w.chain} />
            <span className={`w-24 text-right font-semibold tabular-nums ${w.direction === 'in' ? 'text-mint-400' : 'text-rose-400'}`}>
              {w.direction === 'in' ? '+' : '−'}
              {fmtUsd(w.usd)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ReserveList({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3.5">
        <ShieldCheck size={16} className="text-mint-400" />
        <h3 className="font-display text-base font-semibold">All-chain reserves</h3>
      </div>
      <div className="divide-y divide-white/5">
        {rows.map((r, i) => (
          <div key={r.label} className="flex items-center gap-3 px-5 py-3 text-sm">
            <span className="w-5 text-center font-bold text-white/30">{i + 1}</span>
            <span className="flex-1 truncate font-medium">{r.label}</span>
            {r.coverage != null && <span className="hidden text-xs text-white/40 sm:inline">{Math.round(r.coverage * 100)}% mapped</span>}
            <span className="w-24 text-right font-semibold tabular-nums text-mint-400">{fmtUsd(r.reserves)}</span>
          </div>
        ))}
      </div>
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
            {ready && <ConfidencePill level={data.confidence_level} />}
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
              <WhaleList rows={p?.whales ?? []} />
              <ReserveList rows={p?.topReserves ?? []} />
            </div>

            {/* Subscribe CTA */}
            <Card className="ring-gold flex flex-col items-center gap-4 p-8 text-center">
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
