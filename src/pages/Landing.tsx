import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Boxes,
  Radio,
  Gauge,
  Users,
  FileBarChart,
  Code2,
  ArrowDownRight,
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Globe,
} from 'lucide-react'
import { Logo, Card, ChainPill, LiveBadge } from '../components/ui'
import { api, usePoll, useLiveFeed, useCountUp } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

const FEATURES = [
  { icon: Boxes, title: 'Blockchain Mapping', desc: 'Track casino wallets across ETH, TRX, SEI, BTC & SOL with full on-chain flow visibility.', accent: '#8b3df0' },
  { icon: Radio, title: 'Streamer Analytics', desc: 'Monitor gambling streamers, affiliations and player-acquisition performance in real time.', accent: '#f5b100' },
  { icon: Users, title: 'Player Segmentation', desc: 'Cohort analysis and LTV modelling to surface your highest-value segments.', accent: '#2ee6a6' },
  { icon: Gauge, title: 'Real-time Dashboards', desc: 'Live deposits, withdrawals, player activity and market trends — updated by the second.', accent: '#5b8cff' },
  { icon: FileBarChart, title: 'Custom Reports', desc: 'On-demand report generation with flexible filters and CSV / JSON / PDF export.', accent: '#ff8a3d' },
  { icon: Code2, title: 'API Access', desc: 'Pipe intelligence directly into your stack — REST endpoints & real-time webhooks.', accent: '#c79bff' },
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

export default function Landing() {
  const { data: stats } = usePoll(api.stats, 12_000)
  const { data: entities } = usePoll(api.casinos, 15_000)
  const { data: streamersRes } = usePoll(api.streamers, 30_000)
  const total = useCountUp(stats?.totalVolume ?? 0)
  const top = (entities ?? []).slice(0, 4)
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
            <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-white/70 hover:text-white">
              Log in
            </Link>
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
              Real-time on-chain analytics, casino leaderboards, streamer monitoring and player
              intelligence — purpose-built for casino operators on the WCOIN network.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-6 py-3 text-sm font-semibold text-ink-950 hover:brightness-110"
              >
                Sign up free <ArrowRight size={16} />
              </Link>
              <Link
                to="/app"
                className="rounded-xl border border-white/12 bg-white/5 px-6 py-3 text-sm font-semibold text-white/85 hover:bg-white/10"
              >
                Browse the live data
              </Link>
            </div>

            {/* Live total */}
            <div className="mx-auto mt-10 inline-flex flex-col items-center">
              <div className="flex items-center gap-2 text-[12px] uppercase tracking-wider text-white/40">
                <LiveBadge /> Total volume tracked
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

      <Ticker />

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
          {FEATURES.map((f) => (
            <Card key={f.title} hover className="p-6">
              <div
                className="grid h-11 w-11 place-items-center rounded-xl"
                style={{ background: `${f.accent}1f`, color: f.accent }}
              >
                <f.icon size={21} />
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-white/50">{f.desc}</p>
            </Card>
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
            style={{ background: 'radial-gradient(circle, rgba(245,177,0,0.18), transparent 70%)' }}
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
            to="/login"
            className="relative mt-8 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-7 py-3 text-sm font-semibold text-ink-950 hover:brightness-110"
          >
            Create your free account <ArrowRight size={16} />
          </Link>
          <p className="relative mt-3 text-xs text-white/40">
            Prefer to look first? <Link to="/app" className="text-white/60 hover:underline">Browse read-only</Link> — no account needed.
          </p>
        </Card>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/7 bg-ink-900/40">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <Logo />
          <p className="text-sm text-white/40">© 2026 WCOIN.CASINO — The Intelligence Layer for iGaming</p>
          <div className="flex gap-5 text-sm text-white/50">
            <Link to="/login" className="hover:text-white">Sign up free</Link>
            <Link to="/app" className="hover:text-white">Browse data</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
