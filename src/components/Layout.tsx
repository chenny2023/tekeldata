import { ReactNode, useEffect, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Building2,
  Boxes,
  Radio,
  Gauge,
  Users,
  FileBarChart,
  Code2,
  Target,
  Search,
  Bell,
  Library,
  TrendingUp,
  Menu,
  X,
  ChevronLeft,
  LogOut,
} from 'lucide-react'
import { Logo, LiveBadge } from './ui'
import { api, getToken, setToken, AuthUser } from '../data/api'

// derive a friendly display name from an email (chennywang@live.com → chennywang)
function nameFromEmail(email: string): string {
  return (email.split('@')[0] || email).replace(/[._-]+/g, ' ').trim()
}
function initials(email: string): string {
  const n = nameFromEmail(email)
  const parts = n.split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || 'WC'
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
  { to: '/app/watchlist', label: 'Watchlist', icon: Target },
  { to: '/app/alerts', label: 'Alerts', icon: Bell },
  { to: '/app/reports', label: 'Reports', icon: FileBarChart },
  { to: '/app/api', label: 'API Access', icon: Code2 },
]

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const loc = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!getToken()) return
    let alive = true
    api.me().then((r) => alive && setUser(r.user)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  function logout() {
    api.logout().catch(() => {})
    setToken(null)
    navigate('/login')
  }
  const current = NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))

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
          {user ? (
            <div className="glass flex items-center gap-3 rounded-2xl p-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-600 text-sm font-bold">
                {initials(user.email)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold capitalize">{nameFromEmail(user.email)}</div>
                <div className="truncate text-[11px] text-white/40">{user.email}</div>
              </div>
              <button onClick={logout} title="Log out" className="shrink-0 text-white/40 hover:text-rose-400">
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <div className="glass rounded-2xl p-4">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-gold-400">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-gold-400" />
                100% FREE
              </div>
              <p className="mt-1.5 text-[12px] leading-snug text-white/50">
                Every feature is free. Sign up with just your email to unlock alerts, votes & the full API.
              </p>
              <Link to="/login" className="mt-3 block rounded-lg bg-gradient-to-r from-gold-400 to-gold-600 py-1.5 text-center text-[13px] font-semibold text-ink-950 hover:brightness-110">
                Sign up free
              </Link>
            </div>
          )}
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

          <div className="ml-auto hidden items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm text-white/40 sm:flex">
            <Search size={15} />
            <input
              placeholder="Search casinos, wallets, streamers…"
              className="w-56 bg-transparent text-white/80 placeholder:text-white/30 focus:outline-none"
            />
          </div>
          <LiveBadge />
          <button className="relative grid h-9 w-9 place-items-center rounded-lg border border-white/8 bg-white/4 text-white/60 hover:text-white">
            <Bell size={17} />
            <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-gold-400" />
          </button>
          <div
            title={user?.email ?? ''}
            className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-600 font-display text-sm font-bold"
          >
            {user ? initials(user.email) : 'WC'}
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
