import { ReactNode, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Building2,
  Boxes,
  Radio,
  Gauge,
  Users,
  FileBarChart,
  Target,
  Search,
  Bell,
  Library,
  TrendingUp,
  Menu,
  X,
  ChevronLeft,
} from 'lucide-react'
import { Logo, LiveBadge } from './ui'
import { api, usePoll, SearchResults } from '../data/api'
import { Subscribe } from './Subscribe'

function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// header global search — debounced cross-entity lookup with a results dropdown
function SearchBox() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<SearchResults | null>(null)
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return }
    const t = setTimeout(() => void api.search(q).then(setRes).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const go = (href: string) => { setOpen(false); setQ(''); navigate(href) }
  const Item = ({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) => (
    <button onClick={onClick} className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.05]">
      <span className="truncate text-[13px] text-white/85">{title}</span>
      <span className="shrink-0 text-[11px] text-white/35">{sub}</span>
    </button>
  )
  const Group = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="mb-1"><div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/30">{label}</div>{children}</div>
  )
  const has = res && (res.casinos.length || res.directory.length || res.streamers.length || res.wallets.length)
  return (
    <div ref={ref} className="relative hidden sm:block">
      <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm text-white/40">
        <Search size={15} />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Search casinos, wallets, streamers…"
          className="w-56 bg-transparent text-white/80 placeholder:text-white/30 focus:outline-none"
        />
      </div>
      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 z-30 mt-2 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-white/10 bg-ink-900 p-2 shadow-2xl">
          {!has && <div className="px-2.5 py-3 text-[13px] text-white/40">No matches for “{q}”</div>}
          {res?.casinos.length ? <Group label="Casinos">{res.casinos.map((c) => <Item key={c.name} title={c.name} sub="tracked" onClick={() => go('/app/casinos')} />)}</Group> : null}
          {res?.directory.length ? <Group label="Directory">{res.directory.map((d) => <Item key={d.name} title={d.name} sub={d.domain ?? ''} onClick={() => go('/app/directory')} />)}</Group> : null}
          {res?.streamers.length ? <Group label="Streamers">{res.streamers.map((s) => <Item key={s.platform + s.handle} title={s.handle} sub={s.platform} onClick={() => go('/app/streamers')} />)}</Group> : null}
          {res?.wallets.length ? <Group label="Wallets">{res.wallets.map((w) => <Item key={w.address} title={w.label} sub={`${w.chain} · ${w.address.slice(0, 8)}…`} onClick={() => go('/app/watchlist')} />)}</Group> : null}
        </div>
      )}
    </div>
  )
}

// header notification bell — recent whale deposits/withdrawals, click to drill in
function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const { data } = usePoll(api.notifications, 60_000)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const items = data?.items ?? []
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative grid h-9 w-9 place-items-center rounded-lg border border-white/8 bg-white/4 text-white/60 hover:text-white">
        <Bell size={17} />
        {items.length > 0 && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-gold-400" />}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-white/10 bg-ink-900 shadow-2xl">
          <div className="border-b border-white/8 px-4 py-2.5 text-[13px] font-semibold">Recent whale activity</div>
          {items.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-white/40">No large movements in the last 48h</div>}
          {items.map((n, i) => (
            <button key={i} onClick={() => { setOpen(false); navigate(n.href) }} className="flex w-full items-start gap-3 border-b border-white/5 px-4 py-2.5 text-left hover:bg-white/[0.03]">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${n.type === 'deposit' ? 'bg-mint-400' : 'bg-rose-400'}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-white/85">{n.title}</div>
                <div className="text-[11px] text-white/40">{n.detail} · {relTime(n.ts)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


const NAV = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/casinos', label: 'Casinos', icon: Building2 },
  { to: '/app/directory', label: 'Directory', icon: Library },
  { to: '/app/markets', label: 'On-Chain Markets', icon: TrendingUp },
  { to: '/app/blockchain', label: 'Blockchain', icon: Boxes },
  { to: '/app/streamers', label: 'Streamers', icon: Radio },
  { to: '/app/sentiment', label: 'Trust & Reserves', icon: Gauge },
  { to: '/app/players', label: 'Flow Intel', icon: Users },
  { to: '/app/watchlist', label: 'Email Alerts', icon: Bell },
  { to: '/app/reports', label: 'Reports', icon: FileBarChart },
]

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  const current = NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))
  useEffect(() => {
    document.title = current ? `${current.label} · WCOIN.CASINO — On-Chain iGaming Intelligence` : 'WCOIN.CASINO'
  }, [current])

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 transform border-r border-white/7 bg-ink-900/85 backdrop-blur-xl transition-transform lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <Link to="/" onClick={() => setOpen(false)}>
            <Logo />
          </Link>
          <button className="lg:hidden text-white/50" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>

        <nav className="px-3 py-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `group mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-gradient-to-r from-gold-500/15 to-transparent text-white ring-1 ring-gold-500/25'
                    : 'text-white/55 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon size={18} className={isActive ? 'text-gold-400' : ''} />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="absolute inset-x-3 bottom-4">
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-gold-400">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-gold-400" />
              FREE · NO SIGN-UP
            </div>
            <p className="mb-2.5 mt-1.5 text-[12px] leading-snug text-white/50">
              All data is open. Get the daily on-chain report in your inbox — just your email.
            </p>
            <Subscribe compact cta="Subscribe" />
          </div>
        </div>
      </aside>

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />
      )}

      {/* Main */}
      <div className="flex min-h-screen flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-white/7 bg-ink-950/70 px-4 backdrop-blur-xl sm:px-6">
          <button className="lg:hidden text-white/70" onClick={() => setOpen(true)}>
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2 text-sm text-white/40">
            <Link to="/" className="hover:text-white/70 inline-flex items-center gap-1">
              <ChevronLeft size={15} /> Site
            </Link>
            <span className="text-white/20">/</span>
            <span className="text-white/80 font-medium">{current?.label ?? 'Overview'}</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <SearchBox />
            <LiveBadge />
            <NotificationsBell />
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-600 font-display text-sm font-bold">
              WC
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>

        <footer className="border-t border-white/6 px-6 py-5 text-center text-[12px] text-white/30">
          © 2026 WCOIN.CASINO — The Intelligence Layer for iGaming · Live on-chain data across 9 chains
        </footer>
      </div>
    </div>
  )
}
