import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, ExternalLink, Loader2, Target } from 'lucide-react'
import { Card, PageHead, ChainPill, CategoryBadge, Skeleton, EmptyState } from '../components/ui'
import { api, usePoll, getToken } from '../data/api'
import { shortHash } from '../data/format'

const EXPLORER: Record<string, (a: string) => string> = {
  ETH: (a) => `https://etherscan.io/address/${a}`,
  TRON: (a) => `https://tronscan.org/#/address/${a}`,
}

export default function Watchlist() {
  const { data, loading } = usePoll(api.watchlist, 8_000)
  const [form, setForm] = useState({ chain: 'ETH', address: '', label: '', category: 'casino' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const loggedIn = !!getToken()

  const rows = (data ?? []).filter((r) => r.active)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!form.address.trim() || !form.label.trim()) {
      setErr('Address and label are required')
      return
    }
    setBusy(true)
    try {
      await api.addWatch(form)
      setForm({ ...form, address: '', label: '' })
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    await api.removeWatch(id)
  }

  return (
    <div className="fade-up">
      <PageHead
        title="Watchlist"
        subtitle="Curate the on-chain addresses the indexer tracks — this is your intelligence edge"
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-1">
          <div className="mb-3 flex items-center gap-2">
            <Target size={18} className="text-gold-400" />
            <h3 className="font-display text-lg font-semibold">Add Address</h3>
          </div>
          <form onSubmit={add} className="space-y-3">
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Chain</label>
              <div className="grid grid-cols-2 gap-2">
                {['ETH', 'TRON'].map((c) => (
                  <button key={c} type="button" onClick={() => setForm({ ...form, chain: c })} className={`rounded-xl border py-2 text-sm font-semibold transition ${form.chain === c ? 'border-gold-500/40 bg-gold-500/12 text-gold-400' : 'border-white/10 bg-white/3 text-white/55 hover:bg-white/6'}`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Label</label>
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Stake — Hot Wallet" className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={form.chain === 'ETH' ? '0x…' : 'T…'} className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 font-mono text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm focus:border-gold-500/40 focus:outline-none">
                {['casino', 'exchange', 'whale', 'other'].map((c) => <option key={c} value={c} className="bg-ink-800 capitalize">{c}</option>)}
              </select>
            </div>
            {err && <div className="rounded-lg bg-rose-400/10 px-3 py-2 text-[13px] text-rose-400">{err}</div>}
            {!loggedIn && (
              <div className="rounded-lg bg-gold-500/10 px-3 py-2 text-[13px] text-gold-400">
                <Link to="/login" className="font-semibold underline">Sign in</Link> to add or remove tracked addresses.
              </div>
            )}
            <button type="submit" disabled={busy || !loggedIn} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Track address
            </button>
            <p className="text-[12px] leading-snug text-white/40">
              The indexer immediately begins pulling this address's real USDT/USDC flow. New entries appear in the
              leaderboard within a cycle or two.
            </p>
          </form>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h3 className="mb-3 font-display text-lg font-semibold">Tracked Addresses ({rows.length})</h3>
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No addresses tracked" hint="Add a casino hot-wallet or deposit address to begin." />
          ) : (
            <div className="divide-y divide-white/6">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-3">
                  <ChainPill chain={r.chain} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{r.label}</span>
                      <CategoryBadge category={r.category} />
                    </div>
                    <a href={EXPLORER[r.chain]?.(r.address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-white/45 hover:text-gold-400">
                      {shortHash(r.address, 10)} <ExternalLink size={11} />
                    </a>
                  </div>
                  <button onClick={() => remove(r.id)} className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-white/50 hover:bg-rose-400/15 hover:text-rose-400" title="Stop tracking">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
