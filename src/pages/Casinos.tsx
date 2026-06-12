import { Fragment, useMemo, useState } from 'react'
import { Search, SlidersHorizontal, Wallet, ExternalLink, ChevronDown, ShieldCheck, Calendar, Percent, Coins } from 'lucide-react'
import { Card, PageHead, Bubble, TrustBadge, Delta, CategoryBadge, Skeleton } from '../components/ui'
import { api, usePoll, Entity } from '../data/api'
import { fmtUsd, fmtNum, shortHash, CHAIN_COLOR } from '../data/format'

// real multi-chain deposit split for one entity — the per-chain data we index
function ChainDist({ byChain }: { byChain: Entity['byChain'] }) {
  const total = byChain.reduce((s, c) => s + c.value, 0)
  if (total <= 0) return <span className="text-[11px] text-white/30">—</span>
  return (
    <div className="w-40">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/5">
        {byChain.map((c) => (
          <div key={c.chain} style={{ width: `${(c.value / total) * 100}%`, background: CHAIN_COLOR[c.chain] ?? '#888' }} title={`${c.chain} ${fmtUsd(c.value)}`} />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {byChain.slice(0, 5).map((c) => (
          <span key={c.chain} className="inline-flex items-center gap-1 text-[10px] text-white/45">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: CHAIN_COLOR[c.chain] ?? '#888' }} />{c.chain}
          </span>
        ))}
      </div>
    </div>
  )
}

function MetaCell({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-white/40">{icon}{label}</div>
      <div className="mt-0.5 text-sm font-medium text-white/85">{value}</div>
    </div>
  )
}

type SortKey = 'volume7d' | 'trust' | 'reserves' | 'players'

const EXPLORER: Record<string, (a: string) => string> = {
  ETH: (a) => `https://etherscan.io/address/${a}`,
  TRON: (a) => `https://tronscan.org/#/address/${a}`,
  SOL: (a) => `https://solscan.io/account/${a}`,
}

export default function Casinos() {
  const { data, loading } = usePoll(api.casinos, 15_000)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('volume7d')
  const [cat, setCat] = useState('all')
  const [open, setOpen] = useState<number | null>(null)

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
        subtitle="Watched entities ranked by real multi-chain volume — expand a casino for its profile & per-chain split"
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
                  <th className="px-4 py-3 font-medium">Chains</th>
                  <th className="px-4 py-3 font-medium">24h</th>
                  <th className="px-4 py-3 font-medium">Net Flow</th>
                  <th className="px-4 py-3 font-medium">Trust</th>
                  <th className="px-4 py-3 font-medium">Reserves</th>
                  <th className="px-4 py-3 font-medium">Counterparties</th>
                  <th className="px-4 py-3 font-medium">Address</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c: Entity, i) => {
                  const expandable = !!c.meta || c.byChain.length > 0
                  const isOpen = open === c.id
                  return (
                    <Fragment key={c.id}>
                      <tr
                        onClick={() => expandable && setOpen(isOpen ? null : c.id)}
                        className={`border-b border-white/5 transition hover:bg-white/[0.03] ${expandable ? 'cursor-pointer' : ''} ${isOpen ? 'bg-white/[0.03]' : ''}`}
                      >
                        <td className="px-4 py-3 font-bold text-white/30">{i + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            {c.meta?.logo ? (
                              <img src={c.meta.logo} alt="" className="h-7 w-7 rounded-lg object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                            ) : (
                              <Bubble seed={c.label} />
                            )}
                            <div>
                              <div className="flex items-center gap-1.5">
                                {expandable && <ChevronDown size={13} className={`text-white/30 transition ${isOpen ? 'rotate-180' : ''}`} />}
                                <span className="font-medium">{c.label}</span>
                                <CategoryBadge category={c.category} />
                              </div>
                              {c.meta && (
                                <div className="mt-0.5 text-[11px] text-white/40">
                                  {[c.meta.license, c.meta.foundedYear, c.meta.houseEdge != null ? `${c.meta.houseEdge}% edge` : null].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-semibold tabular-nums">{fmtUsd(c.volume7d)}</td>
                        <td className="px-4 py-3"><ChainDist byChain={c.byChain} /></td>
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
                          <a href={EXPLORER[c.chain]?.(c.address)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-mono text-[12px] text-white/50 hover:text-gold-400">
                            {shortHash(c.address)} <ExternalLink size={11} />
                          </a>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-white/5 bg-black/20">
                          <td colSpan={10} className="px-6 py-4">
                            <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
                              {c.meta?.license && <MetaCell icon={<ShieldCheck size={12} />} label="License" value={c.meta.license} />}
                              {c.meta?.foundedYear && <MetaCell icon={<Calendar size={12} />} label="Founded" value={c.meta.foundedYear} />}
                              {c.meta?.houseEdge != null && <MetaCell icon={<Percent size={12} />} label="House Edge" value={`${c.meta.houseEdge}%`} />}
                              {c.meta?.sportsHouseEdge != null && <MetaCell icon={<Percent size={12} />} label="Sports Edge" value={`${c.meta.sportsHouseEdge}%`} />}
                              {c.meta?.website && <MetaCell icon={<ExternalLink size={12} />} label="Site" value={<a href={c.meta.website} target="_blank" rel="noreferrer" className="text-gold-400 hover:underline">{c.meta.website.replace(/^https?:\/\//, '')}</a>} />}
                              {c.meta?.currencies?.length ? <MetaCell icon={<Coins size={12} />} label="Currencies" value={c.meta.currencies.slice(0, 8).join(', ')} /> : null}
                            </div>
                            {c.byChain.length > 0 && (
                              <div className="mt-4">
                                <div className="mb-2 text-[11px] uppercase tracking-wider text-white/40">Volume by chain · 7d (real indexed flow)</div>
                                <div className="flex flex-wrap gap-2">
                                  {c.byChain.map((b) => (
                                    <span key={b.chain} className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/4 px-2.5 py-1 text-[12px]">
                                      <span className="h-2 w-2 rounded-full" style={{ background: CHAIN_COLOR[b.chain] ?? '#888' }} />
                                      <span className="font-medium text-white/80">{b.chain}</span>
                                      <span className="tabular-nums text-white/50">{fmtUsd(b.value)}</span>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
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
