import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Building2, Radio, ArrowRight, ArrowLeft, Loader2 } from 'lucide-react'
import { Logo } from '../components/ui'
import { api, setToken } from '../data/api'

export default function Login() {
  const [role, setRole] = useState<'casino' | 'streamer'>('casino')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const res =
        mode === 'register'
          ? await api.register(email, password, role)
          : await api.login(email, password)
      setToken(res.token)
      nav('/app')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left brand panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex">
        <div className="grid-noise absolute inset-0 opacity-30" />
        <div
          className="absolute -left-20 top-20 h-72 w-72 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(245,177,0,0.25), transparent 70%)' }}
        />
        <div
          className="absolute bottom-10 right-0 h-80 w-80 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(139,61,240,0.22), transparent 70%)' }}
        />
        <Link to="/" className="relative"><Logo size={34} /></Link>
        <div className="relative">
          <h2 className="font-display text-4xl font-bold leading-tight">
            The intelligence layer<br />behind every <span className="text-gradient-gold">winning</span> operator.
          </h2>
          <p className="mt-4 max-w-md text-white/55">
            Log in to manage your watchlist, vote on entity trust, and pipe live on-chain
            intelligence into your operation.
          </p>
        </div>
        <span className="relative text-sm text-white/30">© 2026 WCOIN.CASINO</span>
      </div>

      {/* Right form */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 lg:hidden"><Logo /></div>
          <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white">
            <ArrowLeft size={15} /> Back to site
          </Link>
          <h1 className="font-display text-2xl font-bold">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-1 text-sm text-white/50">
            {mode === 'login' ? 'Sign in to your portal.' : 'First account created becomes the admin.'}
          </p>

          {mode === 'register' && (
            <div className="mt-5 grid grid-cols-2 gap-2">
              {(
                [
                  ['casino', 'Casino', Building2],
                  ['streamer', 'Streamer', Radio],
                ] as const
              ).map(([k, label, Icon]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setRole(k)}
                  className={`flex items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-semibold transition ${
                    role === k
                      ? 'border-gold-500/40 bg-gold-500/12 text-gold-400'
                      : 'border-white/10 bg-white/3 text-white/55 hover:bg-white/6'
                  }`}
                >
                  <Icon size={16} /> {label}
                </button>
              ))}
            </div>
          )}

          <form className="mt-5 space-y-3" onSubmit={submit}>
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@casino.com"
                className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-white/55">
                Password {mode === 'register' && <span className="text-white/35">(min 8 chars)</span>}
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none"
              />
            </div>
            {err && <div className="rounded-lg bg-rose-400/10 px-3 py-2 text-[13px] text-rose-400">{err}</div>}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="mt-5 text-center text-[13px] text-white/45">
            {mode === 'login' ? (
              <>No account?{' '}
                <button onClick={() => { setMode('register'); setErr(null) }} className="font-semibold text-gold-400 hover:underline">
                  Register
                </button>
              </>
            ) : (
              <>Already registered?{' '}
                <button onClick={() => { setMode('login'); setErr(null) }} className="font-semibold text-gold-400 hover:underline">
                  Sign in
                </button>
              </>
            )}
            {' '}· <Link to="/app" className="text-white/55 hover:underline">browse read-only</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
