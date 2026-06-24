import { useState } from 'react'
import { Bell, Search, Loader2, Check } from 'lucide-react'
import { Card, PageHead, ChainPill } from '../components/ui'
import { api, usePoll } from '../data/api'
import { Subscribe } from '../components/Subscribe'

// Casino alerts by email — no account. Pick a casino, drop your email, and get a
// note when its on-chain reserves move materially (double opt-in, one-click
// unsubscribe). Replaces the old login-gated personal watchlist.
export default function Watchlist() {
  const { data: brands } = usePoll(() => api.brands('casino'), 60_000)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const matches =
    q.trim().length >= 1
      ? (brands ?? []).filter((b) => b.brand.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
      : []

  async function subscribe(e: React.FormEvent) {
    e.preventDefault()
    if (!picked || !/.+@.+\..+/.test(email)) return
    setBusy(true)
    try {
      await api.casinoAlert(email, picked)
      setDone(picked)
      setPicked(null)
      setEmail('')
      setQ('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fade-up">
      <PageHead title="Casino Alerts" subtitle="Get an email when a casino's on-chain reserves move — no account, one-click unsubscribe" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Per-casino alert */}
        <Card spotlight className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <Bell size={18} className="text-gold-400" />
            <h3 className="font-display text-lg font-semibold">Alert me about a casino</h3>
          </div>

          {done && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-mint-400/20 bg-mint-400/10 px-3 py-2.5 text-[13px] text-mint-300">
              <Check size={15} /> Check your inbox to confirm <strong>{done}</strong> reserve alerts.
            </div>
          )}

          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35" />
            <input
              value={picked ?? q}
              onChange={(e) => { setPicked(null); setQ(e.target.value) }}
              placeholder="Search a casino…"
              className="w-full rounded-xl border border-white/10 bg-white/4 py-2.5 pl-9 pr-3 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none"
            />
          </div>
          {!picked && matches.length > 0 && (
            <div className="mt-2 divide-y divide-white/6 overflow-hidden rounded-xl border border-white/8">
              {matches.map((b) => (
                <button
                  key={b.brand}
                  onClick={() => { setPicked(b.brand); setQ(b.brand) }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition hover:bg-white/[0.04]"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{b.brand}</span>
                    <ChainPill chain={b.chains[0] ?? 'ETH'} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {picked && (
            <form onSubmit={subscribe} className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                className="flex-1 rounded-xl border border-white/12 bg-white/5 px-4 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-gold-500/50 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Bell size={15} />} Alert me about {picked}
              </button>
            </form>
          )}
          <p className="mt-3 text-[12px] leading-snug text-white/40">
            We email you only when {picked || 'the casino'}'s mapped on-chain reserves change materially over ~7 days. Observed wallet data — not a solvency statement. Double opt-in; unsubscribe anytime.
          </p>
        </Card>

        {/* Daily report */}
        <Card spotlight className="p-5 lg:col-span-1">
          <h3 className="mb-1 font-display text-lg font-semibold">Daily on-chain report</h3>
          <p className="mb-3 text-[13px] leading-snug text-white/50">The whole market in one email — verified casino flow, reserve watch and chain breakdown.</p>
          <Subscribe compact cta="Subscribe" />
        </Card>
      </div>
    </div>
  )
}
