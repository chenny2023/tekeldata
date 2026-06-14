import { Fragment, useEffect, useMemo, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Search, SlidersHorizontal, Wallet, ExternalLink, ChevronDown, ShieldCheck, ShieldAlert, Calendar, Percent, Coins, Star, Award, AlertTriangle, MessageSquare } from 'lucide-react'
import { Card, PageHead, Bubble, TrustBadge, Delta, CategoryBadge, ChainPill, Skeleton } from '../components/ui'
import { api, usePoll, Entity } from '../data/api'
import { fmtUsd, fmtNum, shortHash, CHAIN_COLOR } from '../data/format'

// casino.guru Safety Index (0–10, independent expert review) — colored on
// casino.guru's own bands: 8+ very good, 6–8 fair, <6 caution. An external
// reputation signal blended alongside our on-chain trust score.
function GuruChip({ score }: { score: number }) {
  const color = score >= 8 ? '#2ee6a6' : score >= 6 ? '#f5b100' : '#ff5c7a'
  return (
    <span
      title={`casino.guru Safety Index ${score}/10 — independent expert review`}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{ color }}
    >
      <ShieldCheck size={10} /> {score}
    </span>
  )
}

// Trustpilot consumer rating (★/5) — live page, Wayback fallback.
function TrustpilotChip({ score }: { score: number }) {
  const color = score >= 4 ? '#2ee6a6' : score >= 3 ? '#f5b100' : '#ff5c7a'
  return (
    <span
      title={`Trustpilot ${score}/5 — consumer rating`}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{ color }}
    >
      <Star size={10} /> {score}
    </span>
  )
}

// casino.org editorial rating (/5) — a recognised editorial review score.
function EditorialChip({ score }: { score: number }) {
  const color = score >= 4 ? '#2ee6a6' : score >= 3 ? '#f5b100' : '#ff5c7a'
  return (
    <span
      title={`casino.org editorial rating ${score}/5`}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{ color }}
    >
      <Award size={10} /> {score}
    </span>
  )
}

// the casino's own token — symbol + 24h move (CoinGecko). A financial-confidence
// signal for the operators that issue a token.
function TokenBadge({ token }: { token: NonNullable<Row['token']> }) {
  const ch = token.change24h ?? 0
  const color = ch >= 0 ? '#2ee6a6' : '#ff5c7a'
  const mc = token.marketCap
  const mcap = mc >= 1e9 ? `$${(mc / 1e9).toFixed(1)}B` : mc >= 1e6 ? `$${(mc / 1e6).toFixed(0)}M` : `$${(mc / 1e3).toFixed(0)}K`
  return (
    <span
      title={`$${token.symbol} — ${mcap} market cap · ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h (CoinGecko)`}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-bold"
    >
      <Coins size={10} className="text-gold-400" />
      <span className="text-white/70">${token.symbol}</span>
      <span style={{ color }} className="tabular-nums">{ch >= 0 ? '+' : ''}{ch.toFixed(1)}%</span>
    </span>
  )
}

// casino.guru complaints — the most actionable trust signal. Red when there are
// UNRESOLVED disputes, amber when complaints exist but were all resolved, green
// when there are none on record.
function ComplaintsChip({ count, unresolved }: { count: number; unresolved: number | null }) {
  const u = unresolved && unresolved > 0 ? unresolved : 0
  const color = u > 0 ? '#ff5c7a' : count > 0 ? '#f5b100' : '#2ee6a6'
  const desc = u > 0 ? `${count} complaints · ${u} unresolved` : count > 0 ? `${count} complaints in casino.guru's database` : 'no complaints on record'
  return (
    <span
      title={`casino.guru: ${desc}`}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{ color }}
    >
      <AlertTriangle size={10} /> {count}{u > 0 ? `·${u}!` : ''}
    </span>
  )
}

// 30d daily volume history for one entity, stacked by chain — loads when a row
// expands; thin until the chain backfills deepen, then fills in automatically
function EntityHistory({ id }: { id: number }) {
  const [data, setData] = useState<{ chains: string[]; series: ({ t: number } & Record<string, number>)[] } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    api.entitySeries(id, 30).then((d) => alive && setData(d)).catch(() => alive && setFailed(true))
    return () => { alive = false }
  }, [id])
  if (failed) return null
  if (!data) return <Skeleton className="h-28 w-full" />
  const hasData = data.series.some((p) => data.chains.some((c) => (p[c] ?? 0) > 0))
  if (!hasData) return <p className="text-[12px] text-white/35">No indexed history in the last 30 days yet — backfill in progress.</p>
  const rows = data.series.map((p) => ({ ...p, label: new Date(p.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }))
  return (
    <div className="h-36">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="label" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis hide />
          <Tooltip
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="glass rounded-lg px-3 py-2 text-xs">
                  <div className="mb-1 text-white/50">{label}</div>
                  {payload.filter((p: any) => p.value > 0).map((p: any) => (
                    <div key={p.name} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                      <span className="text-white/70">{p.name}</span>
                      <span className="ml-auto pl-3 font-semibold">{fmtUsd(p.value)}</span>
                    </div>
                  ))}
                </div>
              ) : null
            }
          />
          {data.chains.map((c) => (
            <Area key={c} type="monotone" dataKey={c} stackId="v" stroke={CHAIN_COLOR[c] ?? '#888'} fill={CHAIN_COLOR[c] ?? '#888'} fillOpacity={0.25} strokeWidth={1.5} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

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

// money-flow Sankey: sources → entity → destinations, bands sized by real $ flow
function MoneyFlow({ id }: { id: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.entityFlow>> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    api.entityFlow(id, 30).then((d) => alive && setData(d)).catch(() => alive && setFailed(true))
    return () => { alive = false }
  }, [id])
  if (failed) return null
  if (!data) return <Skeleton className="h-40 w-full" />
  const sources = data.sources, sinks = data.sinks
  const totalIn = sources.reduce((s, n) => s + n.usd, 0)
  const totalOut = sinks.reduce((s, n) => s + n.usd, 0)
  if (totalIn === 0 && totalOut === 0) return <p className="text-[12px] text-white/35">No directional flow indexed in the last 30 days yet.</p>

  const W = 820
  const rows = Math.max(sources.length, sinks.length, 1)
  const H = Math.max(150, rows * 32 + 30)
  const top = 16, usable = H - top - 16
  const ENTX = 402, SRCX = 150, SNKX = 660

  // stacked bands on each side, proportional to share of that side's total
  const band = (nodes: typeof sources, total: number) => {
    let y = top
    return nodes.map((n) => {
      const h = total > 0 ? (n.usd / total) * usable : 0
      const seg = { ...n, y, h, mid: y + h / 2 }
      y += h
      return seg
    })
  }
  const src = band(sources, totalIn)
  const snk = band(sinks, totalOut)
  const IN = '#2ee6a6', OUT = '#f5b100'

  // links also stacked along the entity bar (left = inflow order, right = outflow)
  let ly = top
  const inLinks = src.map((s) => { const h = s.h; const o = { s, ey: ly, eh: h }; ly += h; return o })
  let ry = top
  const outLinks = snk.map((s) => { const h = s.h; const o = { s, ey: ry, eh: h }; ry += h; return o })

  const path = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }}>
      {/* inflow links */}
      {inLinks.map((l, i) => (
        <path key={'il' + i} d={path(SRCX + 8, l.s.mid, ENTX, l.ey + l.eh / 2)} stroke={IN} strokeOpacity={0.28} strokeWidth={Math.max(1, l.eh)} fill="none" />
      ))}
      {/* outflow links */}
      {outLinks.map((l, i) => (
        <path key={'ol' + i} d={path(ENTX + 8, l.ey + l.eh / 2, SNKX, l.s.mid)} stroke={OUT} strokeOpacity={0.28} strokeWidth={Math.max(1, l.eh)} fill="none" />
      ))}
      {/* source nodes */}
      {src.map((s, i) => (
        <g key={'s' + i}>
          <rect x={SRCX} y={s.y} width={8} height={Math.max(2, s.h)} rx={2} fill={IN} fillOpacity={s.named ? 0.95 : 0.45} />
          <text x={SRCX - 6} y={s.mid + 3} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.7)">{s.name}</text>
          <text x={SRCX - 6} y={s.mid + 15} textAnchor="end" fontSize={9} fill="rgba(255,255,255,0.35)">{fmtUsd(s.usd)}</text>
        </g>
      ))}
      {/* entity node */}
      <rect x={ENTX} y={top} width={8} height={usable} rx={2} fill="#8b3df0" />
      {/* sink nodes */}
      {snk.map((s, i) => (
        <g key={'k' + i}>
          <rect x={SNKX} y={s.y} width={8} height={Math.max(2, s.h)} rx={2} fill={OUT} fillOpacity={s.named ? 0.95 : 0.45} />
          <text x={SNKX + 14} y={s.mid + 3} fontSize={11} fill="rgba(255,255,255,0.7)">{s.name}</text>
          <text x={SNKX + 14} y={s.mid + 15} fontSize={9} fill="rgba(255,255,255,0.35)">{fmtUsd(s.usd)}</text>
        </g>
      ))}
    </svg>
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
  XRP: (a) => `https://xrpscan.com/account/${a}`,
  BTC: (a) => `https://blockstream.info/address/${a}`,
  LTC: (a) => `https://litecoinspace.org/address/${a}`,
}

// unified row shape so Brand and per-wallet Entity render through one table
interface Row {
  rid: string
  name: string
  category: string
  meta: Entity['meta']
  volume7d: number
  change24h: number
  net7d: number
  trust: number
  reserves: number
  players: number
  byChain: { chain: string; value: number }[]
  histId: number
  safetyIndex: number | null
  trustpilot: number | null
  editorial: number | null
  complaints: number | null
  unresolved: number | null
  userReviews: number | null
  token: Entity['token']
  risk: { hits: number; usd: number } | null
  address?: string
  chain?: string
  wallets?: number
  members?: { id: number; label: string; chain: string; address: string; volume7d: number }[]
}

export default function Casinos() {
  const [view, setView] = useState<'brand' | 'wallet'>('brand')
  // fetch every category so the exchange/whale tabs work, but default the view
  // to casinos only — non-iGaming entities are never grouped in by default
  const { data: entityData, loading: el } = usePoll(() => api.casinos('all'), 15_000)
  const { data: brandData, loading: bl } = usePoll(() => api.brands('all'), 15_000)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('volume7d')
  const [cat, setCat] = useState('casino')
  const [open, setOpen] = useState<string | null>(null)
  const loading = view === 'brand' ? bl : el

  const rows: Row[] = useMemo(() => {
    const src: Row[] =
      view === 'brand'
        ? (brandData ?? []).map((b) => ({
            rid: 'b:' + b.category + ':' + b.brand,
            name: b.brand,
            category: b.category,
            meta: b.meta,
            volume7d: b.volume7d,
            change24h: b.change24h,
            net7d: b.net7d,
            trust: b.trust,
            reserves: b.reserves,
            players: b.players,
            byChain: b.byChain,
            histId: b.members[0]?.id ?? 0,
            safetyIndex: b.safetyIndex,
            trustpilot: b.trustpilot,
            editorial: b.editorial,
            complaints: b.complaints,
            unresolved: b.unresolved,
            userReviews: b.userReviews,
            token: b.token,
            risk: b.risk,
            wallets: b.wallets,
            members: b.members,
          }))
        : (entityData ?? []).map((e) => ({
            rid: 'w:' + e.id,
            name: e.label,
            category: e.category,
            meta: e.meta,
            volume7d: e.volume7d,
            change24h: e.change24h,
            net7d: e.net7d,
            trust: e.trust,
            reserves: e.reserves,
            players: e.players,
            byChain: e.byChain,
            histId: e.id,
            safetyIndex: e.safetyIndex,
            trustpilot: e.trustpilot,
            editorial: e.editorial,
            complaints: e.complaints,
            unresolved: e.unresolved,
            userReviews: e.userReviews,
            token: e.token,
            risk: e.risk,
            address: e.address,
            chain: e.chain,
          }))
    return src
      .filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
      .filter((c) => cat === 'all' || c.category === cat)
      .sort((a, b) => (b[sort] as number) - (a[sort] as number))
  }, [view, brandData, entityData, q, sort, cat])

  const cats = ['all', 'casino', 'exchange', 'whale', 'other']

  return (
    <div className="fade-up">
      <PageHead
        title="Entity Leaderboard"
        subtitle={view === 'brand' ? 'Casinos clustered across all their wallets & chains — circus-style brand totals from real indexed flow' : 'Every watched wallet, ranked by real multi-chain volume'}
        right={
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5 rounded-xl border border-white/8 bg-white/4 p-0.5 text-sm">
              {(['brand', 'wallet'] as const).map((v) => (
                <button key={v} onClick={() => { setView(v); setOpen(null) }} className={`rounded-lg px-3 py-1.5 font-semibold capitalize transition ${view === v ? 'bg-gold-500/15 text-gold-400' : 'text-white/50 hover:text-white'}`}>
                  {v === 'brand' ? 'By brand' : 'By wallet'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm">
              <Search size={15} className="text-white/40" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-32 bg-transparent placeholder:text-white/30 focus:outline-none" />
            </div>
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
                  <th className="px-4 py-3 font-medium">{view === 'brand' ? 'Wallets' : 'Address'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c, i) => {
                  const expandable = !!c.meta || c.byChain.length > 0 || (c.members?.length ?? 0) > 0
                  const isOpen = open === c.rid
                  return (
                    <Fragment key={c.rid}>
                      <tr
                        onClick={() => expandable && setOpen(isOpen ? null : c.rid)}
                        className={`border-b border-white/5 transition hover:bg-white/[0.03] ${expandable ? 'cursor-pointer' : ''} ${isOpen ? 'bg-white/[0.03]' : ''}`}
                      >
                        <td className="px-4 py-3 font-bold text-white/30">{i + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            {c.meta?.logo ? (
                              <img src={c.meta.logo} alt="" className="h-7 w-7 rounded-lg object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                            ) : (
                              <Bubble seed={c.name} />
                            )}
                            <div>
                              <div className="flex items-center gap-1.5">
                                {expandable && <ChevronDown size={13} className={`text-white/30 transition ${isOpen ? 'rotate-180' : ''}`} />}
                                <span className="font-medium">{c.name}</span>
                                <CategoryBadge category={c.category} />
                                {c.risk && (
                                  <span title={`Transacted with ${c.risk.hits} OFAC-sanctioned counterparty event(s) · ${fmtUsd(c.risk.usd)}`} className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-400">
                                    <ShieldAlert size={11} /> OFAC
                                  </span>
                                )}
                                {c.token && <TokenBadge token={c.token} />}
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
                        <td className="px-4 py-3">
                          <div className="flex flex-col items-start gap-1">
                            <TrustBadge score={c.trust} />
                            <div className="flex items-center gap-1.5">
                              {c.safetyIndex != null && <GuruChip score={c.safetyIndex} />}
                              {c.trustpilot != null && <TrustpilotChip score={c.trustpilot} />}
                              {c.editorial != null && <EditorialChip score={c.editorial} />}
                              {c.complaints != null && <ComplaintsChip count={c.complaints} unresolved={c.unresolved} />}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 tabular-nums text-white/80">
                            <Wallet size={13} className="text-gold-400" />{fmtUsd(c.reserves)}
                          </span>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-white/70">{fmtNum(c.players)}</td>
                        <td className="px-4 py-3">
                          {view === 'brand' ? (
                            <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/6 px-2 py-0.5 text-[12px] font-semibold text-white/70">{c.wallets} wallet{c.wallets === 1 ? '' : 's'}</span>
                          ) : (
                            <a href={EXPLORER[c.chain ?? '']?.(c.address ?? '')} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-mono text-[12px] text-white/50 hover:text-gold-400">
                              {shortHash(c.address ?? '')} <ExternalLink size={11} />
                            </a>
                          )}
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
                              {c.safetyIndex != null && <MetaCell icon={<ShieldCheck size={12} />} label="casino.guru" value={`${c.safetyIndex} / 10`} />}
                              {c.trustpilot != null && <MetaCell icon={<Star size={12} />} label="Trustpilot" value={`${c.trustpilot} / 5`} />}
                              {c.editorial != null && <MetaCell icon={<Award size={12} />} label="casino.org" value={`${c.editorial} / 5`} />}
                              {c.complaints != null && <MetaCell icon={<AlertTriangle size={12} />} label="Complaints" value={`${c.complaints}${c.unresolved ? ` · ${c.unresolved} unresolved` : ''}`} />}
                              {c.userReviews != null && <MetaCell icon={<MessageSquare size={12} />} label="User reviews" value={`${c.userReviews}`} />}
                              {c.token && <MetaCell icon={<Coins size={12} />} label={`$${c.token.symbol} token`} value={`$${c.token.price < 0.01 ? c.token.price.toPrecision(2) : c.token.price.toFixed(c.token.price < 1 ? 4 : 2)} · ${c.token.change24h != null ? `${c.token.change24h >= 0 ? '+' : ''}${c.token.change24h.toFixed(1)}% 24h` : ''}`} />}
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
                            {c.members && c.members.length > 0 && (
                              <div className="mt-4">
                                <div className="mb-2 text-[11px] uppercase tracking-wider text-white/40">{c.members.length} clustered wallet{c.members.length === 1 ? '' : 's'} (grouped by block-explorer attribution)</div>
                                <div className="space-y-1">
                                  {c.members.map((m) => (
                                    <div key={m.id} className="flex items-center gap-2 text-[12px]">
                                      <ChainPill chain={m.chain} />
                                      <span className="text-white/60">{m.label}</span>
                                      <a href={EXPLORER[m.chain]?.(m.address)} target="_blank" rel="noreferrer" className="font-mono text-white/40 hover:text-gold-400">{shortHash(m.address)}</a>
                                      <span className="ml-auto tabular-nums text-white/55">{fmtUsd(m.volume7d)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {c.histId > 0 && (
                              <div className="mt-4">
                                <div className="mb-2 text-[11px] uppercase tracking-wider text-white/40">Daily volume · 30d, stacked by chain{view === 'brand' ? ' (largest wallet)' : ''}</div>
                                <EntityHistory id={c.histId} />
                              </div>
                            )}
                            {c.histId > 0 && (
                              <div className="mt-4">
                                <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-white/40">
                                  <span>Money flow · 30d{view === 'brand' ? ' (largest wallet)' : ''}</span>
                                  <span className="flex gap-3 normal-case tracking-normal">
                                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-mint-400" />deposits in</span>
                                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-gold-500" />withdrawals out</span>
                                  </span>
                                </div>
                                <MoneyFlow id={c.histId} />
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
