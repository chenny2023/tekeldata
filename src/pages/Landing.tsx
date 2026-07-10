import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Boxes,
  Radio,
  Gauge,
  Users,
  FileBarChart,
  ArrowDownRight,
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Globe,
} from 'lucide-react'
import { Logo, Card, ChainPill, LiveBadge } from '../components/ui'
import { Reveal, CountUp, SpotlightCard } from '../components/motion'
import { api, usePoll, useLiveFeed, useCountUp } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

const FEATURES = [
  { icon: Boxes, title: 'Blockchain Mapping', desc: 'Track casino wallets across ETH, TRX, SEI, BTC & SOL with full on-chain flow visibility.', accent: '#8b3df0' },
  { icon: Radio, title: 'Streamer Analytics', desc: 'Monitor gambling streamers, affiliations and player-acquisition performance in real time.', accent: '#F2C200' },
  { icon: Users, title: 'Player Segmentation', desc: 'Cohort analysis and LTV modelling to surface your highest-value segments.', accent: '#2ee6a6' },
  { icon: Gauge, title: 'Real-time Dashboards', desc: 'Live deposits, withdrawals, player activity and market trends — updated by the second.', accent: '#5b8cff' },
  { icon: FileBarChart, title: 'Custom Reports', desc: 'On-demand report generation with flexible filters and CSV / JSON / PDF export.', accent: '#ff8a3d' },
  { icon: ShieldCheck, title: 'Proof-of-Reserves', desc: 'All-chain casino reserves via on-chain attribution — solvency trends, not promises.', accent: '#c79bff' },
]

function Ticker() {
  const feed = useLiveFeed(16, 'casino')
  const items = feed.length ? [...feed, ...feed] : []
  return (
    <div className="relative overflow-hidden border-y border-white/8 bg-ink-900/60 py-2.5">
      {items.length === 0 ? (
        <div className="text-center text-[13px] text-white/40">Connecting to live on-chain feed…</div>
      ) : (
        <div className="ticker-track flex w-max gap-8 whitespace-nowrap">
          {items.map((t, i) => (
            <span key={t.tx_hash + t.direction + i} className="inline-flex items-center gap-2 text-[13px]">
              <span className={t.direction === 'in' ? 'text-mint-400' : 'text-rose-400'}>
                {t.direction === 'in' ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />}
              </span>
              <span className="font-medium text-white/80">{t.label}</span>
              <span className="font-semibold text-gold-400">{fmtUsd(t.usd)}</span>
              <ChainPill chain={t.chain} />
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function CoverageBoard() {
  const { data: c } = usePoll(api.coverage, 30_000)
  const fmtBig = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${(n / 1e3).toFixed(0)}K`)
  const intFmt = (n: number) => `${Math.round(n)}`
  const tiles: { label: string; num?: number; format: (n: number) => string; sub: string }[] = [
    { label: 'Casinos catalogued', num: c?.casinos, format: fmtNum, sub: c ? `${fmtNum(c.sitesLive)} verified live` : '' },
    { label: 'All-chain reserves', num: c?.reservesUsd, format: fmtBig, sub: c ? `${c.reservesCount} casinos` : '' },
    { label: 'Chains indexed', num: c?.chains, format: intFmt, sub: 'ETH · Tron · BTC · SOL…' },
    { label: 'Prediction markets', num: c?.predictionMarkets, format: fmtNum, sub: c ? `${fmtBig(c.predictionVolume)} vol` : '' },
    { label: 'On-chain protocols', num: c?.protocols, format: fmtNum, sub: c ? `${fmtBig(c.protocolTvl)} TVL` : '' },
    { label: 'Social mentions', num: c?.mentions, format: fmtNum, sub: '8 sources' },
    { label: 'Streamers tracked', num: c?.streamers, format: fmtNum, sub: 'Kick · Twitch · YouTube' },
    { label: 'Trust-rated', num: c?.trustpilotRated, format: fmtNum, sub: 'Trustpilot + guru + AG' },
  ]
  return (
    <section className="mx-auto max-w-7xl px-5 py-14">
      <Reveal className="mx-auto mb-8 max-w-2xl text-center">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          The web's <span className="text-gradient-gold">most complete</span> iGaming dataset
        </h2>
        <p className="mt-2 text-sm text-white/55">On-chain truth + reviews + social — one layer, fully verifiable.</p>
      </Reveal>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t, i) => (
          <Reveal key={t.label} delay={i * 55}>
            <SpotlightCard className="h-full p-5 text-center">
              <div className="font-display text-2xl font-bold text-gradient-gold sm:text-3xl">
                {t.num == null ? '—' : <CountUp value={t.num} format={t.format} />}
              </div>
              <div className="mt-1 text-[13px] font-medium text-white/75">{t.label}</div>
              {t.sub && <div className="mt-0.5 text-[11px] text-white/40">{t.sub}</div>}
            </SpotlightCard>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

// Email capture → double opt-in via a one-click confirmation LINK (unified with the
// /daily subscribe box — no on-page 6-digit code step).
function EmailCapture() {
  const [email, setEmail] = useState('')
  const [stage, setStage] = useState<'idle' | 'sending' | 'done'>('idle')
  const [msg, setMsg] = useState('')

  const request = async (e: FormEvent) => {
    e.preventDefault()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setMsg('Enter a valid email')
    setStage('sending')
    setMsg('')
    try {
      const r = await api.subscribe(email)
      setStage('done')
      setMsg(r.alreadyActive ? "You're already subscribed ✓" : 'Check your inbox and click the confirmation link to start the Daily Report.')
    } catch {
      setStage('idle')
      setMsg('Something went wrong — try again.')
    }
  }

  return (
    <div className="mx-auto mt-7 max-w-md">
      {stage === 'done' ? (
        <div className="rounded-xl border border-mint-400/30 bg-mint-400/10 px-4 py-3 text-sm font-medium text-mint-300">{msg}</div>
      ) : (
        <form onSubmit={request} className="flex gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="you@email.com"
            className="min-w-0 flex-1 rounded-xl border border-white/12 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/35 focus:border-gold-500/50 focus:outline-none"
          />
          <button
            disabled={stage === 'sending'}
            className="whitespace-nowrap rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-5 py-3 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
          >
            {stage === 'sending' ? 'Sending…' : 'Get the Daily Report'}
          </button>
        </form>
      )}
      {msg && stage !== 'done' && <p className="mt-2 text-[13px] text-white/45">{msg}</p>}
      {stage === 'idle' && <p className="mt-2 text-[12px] text-white/35">Free daily on-chain crypto-casino market report — confirm with a one-click link. Unsubscribe anytime.</p>}
    </div>
  )
}

// "Today in Crypto Casino" — the precomputed daily snapshot first screen.
function TodayStrip() {
  const { data } = usePoll(api.marketSnapshot, 60_000)
  if (!data || data.error) return null
  const net = data.net_flow_24h ?? 0
  const cells = [
    { label: '24h Volume', value: fmtUsd(data.tracked_volume_24h ?? 0) },
    { label: 'Net Flow 24h', value: (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net)) },
    { label: 'Active Casinos', value: fmtNum(data.active_casinos ?? 0) },
    { label: 'Chains', value: String(data.active_chains ?? 0) },
    { label: 'Live Streamers', value: String(data.live_streamers ?? 0) },
    { label: 'Tracked Reserves', value: fmtUsd(data.reserves_total ?? 0) },
  ]
  const movers = data.payload?.topMovers?.slice(0, 5) ?? []
  return (
    <section className="mx-auto max-w-7xl px-5 py-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold sm:text-2xl">Today in Crypto Casino</h2>
        <Link to="/daily" className="text-[13px] font-medium text-gold-400 hover:underline">Full daily report →</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <Card key={c.label} className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-white/40">{c.label}</div>
            <div className="mt-1.5 font-display text-lg font-bold tabular-nums">{c.value}</div>
          </Card>
        ))}
      </div>
      {movers.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-white/55">
          <span className="text-white/35">Biggest movers (24h):</span>
          {movers.map((m) => (
            <span key={m.label}>
              {m.label} <span className="font-semibold tabular-nums text-gold-400">{fmtUsd(m.vol24h)}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

export default function Landing() {
  const { data: stats } = usePoll(api.stats, 12_000)
  const { data: brands } = usePoll(() => api.brands('casino'), 15_000)
  const { data: streamersRes } = usePoll(api.streamers, 30_000)
  const total = useCountUp(stats?.totalVolume ?? 0)
  // verified, brand-merged casinos only — exclude unattributed + anomalous-volume (wash/internal)
  const top = (brands ?? []).filter((b) => b.attributed && !b.volumeSuspect).slice(0, 4).map((b) => ({ id: b.members[0]?.id ?? 0, label: b.brand, volume7d: b.volume7d }))
  const live = (streamersRes?.streamers ?? []).slice(0, 4)

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-white/7 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
          <Logo />
          <nav className="hidden items-center gap-7 text-sm text-white/60 md:flex">
            <a href="#features" className="hover:text-white">Features</a>
            <a href="#intel" className="hover:text-white">Live Intel</a>
            <a href="#free" className="hover:text-white">Free Access</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              to="/app"
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-gold-400 to-gold-600 px-4 py-2 text-sm font-semibold text-ink-950 hover:brightness-110"
            >
              Launch Dashboard <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="grid-noise absolute inset-0 opacity-40" />
        <div className="relative mx-auto max-w-7xl px-5 pb-14 pt-16 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-gold-500/30 bg-gold-500/10 px-3 py-1 text-[12px] font-semibold uppercase tracking-wider text-gold-400">
              <Globe size={13} /> Predict · Play · Win the World
            </span>
            <h1 className="mt-5 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              The <span className="text-gradient-gold">Intelligence Layer</span><br />for iGaming
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base text-white/55 sm:text-lg">
              Tracking <span className="font-semibold text-white/80">{fmtNum(stats?.casinosTracked ?? 0)} crypto casinos</span> — real-time on-chain
              volume, all-chain proof-of-reserves, trust ratings & streamer signals.{' '}
              <span className="font-semibold text-gold-400">100% free, no paywall.</span>
            </p>
            {/* Lead CTA: daily report email capture */}
            <EmailCapture />
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/app"
                className="rounded-xl border border-white/12 bg-white/5 px-6 py-3 text-sm font-semibold text-white/85 hover:bg-white/10"
              >
                Browse the live data <ArrowRight size={15} className="inline" />
              </Link>
            </div>

            {/* Live total */}
            <div className="mx-auto mt-10 inline-flex flex-col items-center">
              <div className="flex items-center gap-2 text-[12px] uppercase tracking-wider text-white/40">
                <LiveBadge /> Verified 7d volume
              </div>
              <div className="mt-1 font-display text-4xl font-bold tabular-nums text-gradient-gold sm:text-5xl">
                {fmtUsd(total, false)}
              </div>
              <div className="mt-1 text-sm text-white/45">
                across {stats?.entities ?? 0} watched entities · {fmtNum(stats?.uniquePlayers ?? 0)} counterparties · ETH + Tron
              </div>
            </div>
          </div>
        </div>
      </section>

      <TodayStrip />
      <Ticker />

      <CoverageBoard />

      {/* Live intel preview */}
      <section id="intel" className="mx-auto max-w-7xl px-5 py-16">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-xl font-semibold">Top Entities · Volume</h3>
              <Link to="/app/casinos" className="text-sm font-medium text-gold-400 hover:underline">View all →</Link>
            </div>
            <div className="space-y-3">
              {top.length === 0 && <p className="text-sm text-white/40">Indexing on-chain volume…</p>}
              {top.map((c, i) => (
                <div key={c.id} className="flex items-center gap-3">
                  <span className="w-5 text-center font-bold text-white/30">{i + 1}</span>
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-sm font-bold">
                    {c.label[0]}
                  </div>
                  <span className="flex-1 font-medium">{c.label}</span>
                  <span className="font-semibold tabular-nums text-gold-400">{fmtUsd(c.volume7d)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-xl font-semibold">Streamers Live Now</h3>
              <Link to="/app/streamers" className="text-sm font-medium text-gold-400 hover:underline">View all →</Link>
            </div>
            <div className="space-y-3">
              {!streamersRes?.enabled && (
                <p className="text-sm text-white/40">Streamer feed off — add Twitch credentials to enable.</p>
              )}
              {streamersRes?.enabled && live.length === 0 && (
                <p className="text-sm text-white/40">No casino streamers live right now.</p>
              )}
              {live.map((s) => (
                <div key={s.id} className="flex items-center gap-3">
                  <span className="live-dot h-2.5 w-2.5 rounded-full bg-rose-400" />
                  <span className="flex-1 font-medium">{s.handle}</span>
                  <span className="text-sm text-white/45">{s.platform}</span>
                  <span className="font-semibold tabular-nums text-mint-400">{fmtNum(s.viewers)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-7xl px-5 py-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Everything an operator needs to <span className="text-gradient-violet">out-think the market</span>
          </h2>
          <p className="mt-3 text-white/55">One platform. Every signal. Updated in real time.</p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 70}>
              <SpotlightCard className="h-full p-6">
                <div
                  className="grid h-11 w-11 place-items-center rounded-xl"
                  style={{ background: `${f.accent}1f`, color: f.accent }}
                >
                  <f.icon size={21} />
                </div>
                <h3 className="mt-4 font-display text-lg font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/50">{f.desc}</p>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Trust band */}
      <section className="mx-auto max-w-7xl px-5 py-12">
        <Card className="grid gap-6 p-8 sm:grid-cols-3">
          {[
            { icon: ShieldCheck, t: 'Provably Fair Sourcing', d: 'Signals derived from on-chain truth & audited feeds.' },
            { icon: Zap, t: 'Sub-second Updates', d: 'Streaming architecture keeps every metric live.' },
            { icon: Globe, t: 'Full-chain Coverage', d: 'ETH, TRX, SEI, BTC and SOL settlement mapped.' },
          ].map((x) => (
            <div key={x.t} className="flex gap-3">
              <x.icon size={22} className="mt-0.5 shrink-0 text-gold-400" />
              <div>
                <div className="font-semibold">{x.t}</div>
                <div className="text-sm text-white/50">{x.d}</div>
              </div>
            </div>
          ))}
        </Card>
      </section>

      {/* Free access / CTA */}
      <section id="free" className="mx-auto max-w-7xl px-5 py-16">
        <Card className="ring-gold relative overflow-hidden p-8 text-center sm:p-12">
          <div
            className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full blur-3xl"
            style={{ background: 'radial-gradient(circle, rgba(242,194,0,0.18), transparent 70%)' }}
          />
          <span className="relative inline-block rounded-full bg-gradient-to-r from-gold-400 to-gold-600 px-3 py-0.5 text-[11px] font-bold tracking-wide text-ink-950">
            100% FREE — FOR EVERYONE
          </span>
          <h2 className="relative mt-4 font-display text-3xl font-bold sm:text-4xl">
            Every feature. <span className="text-gradient-gold">Zero cost.</span>
          </h2>
          <p className="relative mx-auto mt-3 max-w-xl text-white/60">
            No plans, no paywalls, no credit card — ever. Just register with your email and a
            one-time code to unlock the entire platform.
          </p>
          <ul className="relative mx-auto mt-6 grid max-w-2xl grid-cols-2 gap-x-6 gap-y-2.5 text-left text-sm text-white/70 sm:grid-cols-3">
            {[
              'Real-time on-chain feed',
              'Whale & netflow alerts',
              'Wallet clustering',
              'Trust & sentiment board',
              'Custom reports & exports',
              'Full read API access',
            ].map((f) => (
              <li key={f} className="flex items-center gap-2">
                <span className="text-mint-400">✓</span> {f}
              </li>
            ))}
          </ul>
          <Link
            to="/app"
            className="relative mt-8 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-7 py-3 text-sm font-semibold text-ink-950 hover:brightness-110"
          >
            Open the dashboard <ArrowRight size={16} />
          </Link>
          <p className="relative mt-3 text-xs text-white/40">
            All data is open — no account, no password. Drop your email only to get the daily report.
          </p>
        </Card>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/7 bg-ink-900/40">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <Logo />
          <p className="text-sm text-white/40">© 2026 Tekel Data — The Intelligence Layer for iGaming</p>
          <div className="flex gap-5 text-sm text-white/50">
            <Link to="/app" className="hover:text-white">Dashboard</Link>
            <Link to="/daily" className="hover:text-white">Daily report</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
