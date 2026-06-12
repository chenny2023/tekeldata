import { useMemo, useState } from 'react'
import { Search, SlidersHorizontal, Wallet, ExternalLink } from 'lucide-react'
import { Card, PageHead, Bubble, TrustBadge, Delta, ChainPill, CategoryBadge, Skeleton } from '../components/ui'
import { api, usePoll, Entity } from '../data/api'
import { fmtUsd, fmtNum, shortHash } from '../data/format'

type SortKey = 'volume7d' | 'trust' | 'reserves' | 'players'

const EXPLORER: Record<string, (a: string) => string> = {
  ETH: (a) => `https://etherscan.io/address/${a}`,
  TRON: (a) => `https://tronscan.org/#/address/${a}`,
}

export default function Casinos() {
  const { data, loading } = usePoll(api.casinos, 15_000)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('volume7d')
  const [cat, setCat] = useState('all')

  const rows = useMemo(() => {
    return (data ?? [])
      .filter((c) => c.label.toLowerCase().includes(q.toLowerCase()))
      .filter((c) => cat === 'all' || c.category === cat)
      .sort((a, b) => (b[sort] as number) - (a[sort] as number))
  }, [data, q, sort, cat])

  const cats = ['all', 'casino', 'exchange', 'whale', 'other']

  return (
    <div className="fade-up">
      <PageHead
        title="Entity Leaderboard"
        subtitle="Watched on-chain entities ranked by real USDT/USDC volume, trust & reserves"
        right={
          <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm">
            <Search size={15} className="text-white/40" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-36 bg-transparent placeholder:text-white/30 focus:outline-none" />
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-white/50">
        <SlidersHorizontal size={15} />
        <span>Sort</span>
        {([['volume7d', 'Volume'], ['trust', 'Trust'], ['reserves', 'Reserves'], ['players', 'Counterparties']] as [SortKey, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setSort(k)} className={`rounded-lg px-2.5 py-1 text-[13px] font-medium transition ${sort === k ? 'bg-gold-500/15 text-gold-400 ring-1 ring-gold-500/30' : 'text-white/50 hover:bg-white/5'}`}>
            {label}
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-white/10" />
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)} className={`rounded-lg px-2.5 py-1 text-[13px] font-medium capitalize transition ${cat === c ? 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40' : 'text-white/50 hover:bg-white/5'}`}>
            {c}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-white/8 text-left text-[12px] uppercase tracking-wider text-white/40">
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Entity</th>
                  <th className="px-4 py-3 font-medium">Volume</th>
                  <th className="px-4 py-3 font-medium">24h</th>
                  <th className="px-4 py-3 font-medium">Net Flow</th>
                  <th className="px-4 py-3 font-medium">Trust</th>
                  <th className="px-4 py-3 font-medium">Reserves</th>
                  <th className="px-4 py-3 font-medium">Counterparties</th>
                  <th className="px-4 py-3 font-medium">Address</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c: Entity, i) => (
                  <tr key={c.id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-4 py-3 font-bold text-white/30">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Bubble seed={c.label} />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{c.label}</span>
                            <CategoryBadge category={c.category} />
                          </div>
                          <div className="mt-0.5"><ChainPill chain={c.chain} /></div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums">{fmtUsd(c.volume7d)}</td>
                    <td className="px-4 py-3"><Delta value={c.change24h} /></td>
                    <td className={`px-4 py-3 font-semibold tabular-nums ${c.net7d >= 0 ? 'text-mint-400' : 'text-rose-400'}`}>
                      {c.net7d >= 0 ? '+' : '−'}{fmtUsd(Math.abs(c.net7d))}
                    </td>
                    <td className="px-4 py-3"><TrustBadge score={c.trust} /></td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 tabular-nums text-white/80">
                        <Wallet size={13} className="text-gold-400" />{fmtUsd(c.reserves)}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-white/70">{fmtNum(c.players)}</td>
                    <td className="px-4 py-3">
                      <a href={EXPLORER[c.chain]?.(c.address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-white/50 hover:text-gold-400">
                        {shortHash(c.address)} <ExternalLink size={11} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-white/35">
        Showing real on-chain entities from your watchlist. Add competitor casino deposit/hot-wallet
        addresses on the <a href="/app/watchlist" className="text-gold-400 hover:underline">Watchlist</a> to make this leaderboard yours.
      </p>
    </div>
  )
}
