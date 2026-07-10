import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mail, ArrowRight, ArrowLeft, Loader2, KeyRound } from 'lucide-react'
import { Logo } from '../components/ui'
import { api, setToken } from '../data/api'

export default function Login() {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [delivered, setDelivered] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const res = await api.requestCode(email.trim())
      setDelivered(res.delivered)
      setDevCode(res.devCode ?? null)
      if (res.devCode) setCode(res.devCode)
      setStep('code')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const res = await api.verifyCode(email.trim(), code.trim())
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
          style={{ background: 'radial-gradient(circle, rgba(242,194,0,0.25), transparent 70%)' }}
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
            100% free — no password, no payment. Sign in with just your email and a one-time code
            to unlock every feature: live on-chain intelligence, watchlists, alerts and trust votes.
          </p>
        </div>
        <span className="relative text-sm text-white/30">© 2026 Tekel Data</span>
      </div>

      {/* Right form */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 lg:hidden"><Logo /></div>
          <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white">
            <ArrowLeft size={15} /> Back to site
          </Link>

          {step === 'email' ? (
            <>
              <h1 className="font-display text-2xl font-bold">Sign in — it's free</h1>
              <p className="mt-1 text-sm text-white/50">
                Enter your email and we'll send a 6-digit code. No password needed.
              </p>
              <form className="mt-5 space-y-3" onSubmit={requestCode}>
                <div>
                  <label className="mb-1 block text-[13px] text-white/55">Email</label>
                  <div className="relative">
                    <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35" />
                    <input
                      type="email"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@email.com"
                      className="w-full rounded-xl border border-white/10 bg-white/4 py-2.5 pl-9 pr-3.5 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none"
                    />
                  </div>
                </div>
                {err && <div className="rounded-lg bg-rose-400/10 px-3 py-2 text-[13px] text-rose-400">{err}</div>}
                <button
                  type="submit"
                  disabled={busy}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Send me a code
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="font-display text-2xl font-bold">Enter your code</h1>
              <p className="mt-1 text-sm text-white/50">
                {delivered ? (
                  <>We sent a 6-digit code to <span className="text-white/80">{email}</span>.</>
                ) : (
                  <>Enter the 6-digit code for <span className="text-white/80">{email}</span>.</>
                )}
              </p>

              {devCode && (
                <div className="mt-4 rounded-lg border border-gold-500/25 bg-gold-500/8 px-3 py-2 text-[13px] text-gold-300">
                  Email delivery isn't configured on this server yet, so your code is{' '}
                  <span className="font-mono font-semibold text-white">{devCode}</span>. Set
                  <code className="mx-1 text-white/70">RESEND_API_KEY</code> to send real emails.
                </div>
              )}

              <form className="mt-5 space-y-3" onSubmit={verify}>
                <div>
                  <label className="mb-1 block text-[13px] text-white/55">6-digit code</label>
                  <div className="relative">
                    <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35" />
                    <input
                      type="text"
                      required
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      className="w-full rounded-xl border border-white/10 bg-white/4 py-2.5 pl-9 pr-3.5 text-center text-lg font-mono tracking-[0.45em] placeholder:text-white/25 focus:border-gold-500/40 focus:outline-none"
                    />
                  </div>
                </div>
                {err && <div className="rounded-lg bg-rose-400/10 px-3 py-2 text-[13px] text-rose-400">{err}</div>}
                <button
                  type="submit"
                  disabled={busy || code.length < 6}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Verify & continue
                </button>
              </form>

              <p className="mt-5 text-center text-[13px] text-white/45">
                <button onClick={() => { setCode(''); requestCode() }} disabled={busy} className="font-semibold text-gold-400 hover:underline disabled:opacity-50">
                  Resend code
                </button>
                {' '}·{' '}
                <button
                  onClick={() => { setStep('email'); setCode(''); setDevCode(null); setErr(null) }}
                  className="text-white/55 hover:underline"
                >
                  Use a different email
                </button>
              </p>
            </>
          )}

          <p className="mt-5 text-center text-[13px] text-white/45">
            Free forever — no password, no payment.
          </p>
        </div>
      </div>
    </div>
  )
}
