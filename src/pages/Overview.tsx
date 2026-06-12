import { useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Activity, Building2, Wallet, Users, ArrowDownRight, ArrowUpRight, Radio } from 'lucide-react'
import { Card, PageHead, StatCard, Bubble, ChainPill, Delta, CategoryBadge, EmptyState, Skeleton } from '../components/ui'
import { api, usePoll, useLiveFeed, useCountUp } from '../data/api'
import { fmtUsd, fmtNum, timeAgo, CHAIN_COLOR } from '../data/format'

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="glass rounded-lg px-3 py-2 text-xs">
      <div className="mb-1 text-white/50">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="capitalize text-white/70">{p.name}</span>
          <span className="ml-auto font-semibold">{fmtUsd(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function Overview() {
  const [days, setDays] = useState(7)
  const { data: stats } = usePoll(api.stats, 12_000)
  const { data: series } = usePoll(() => api.series(days), 30_000, [days])
  const { data: entities } = usePoll(api.casinos, 15_000)
  const { data: streamersRes } = usePoll(api.streamers, 30_000)
  const feed = useLiveFeed(8)

  const animTotal = useCountUp(stats?.totalVolume ?? 0)
  const chainSplit = (stats?.chainSplit ?? []).map((c) => ({ ...c, color: CHAIN_COLOR[c.chain] ?? '#888' }))
  const totalChain = chainSplit.reduce((s, c) => s + c.value, 0) || 1
  const top = (entities ?? []).slice(0, 5)
  const liveStreamers = (streamersRes?.streamers ?? []).slice(0, 5)

  const chartData = (series ?? []).map((p) => ({
    label: new Date(p.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' }),
    deposits: p.deposits,
    withdrawals: p.withdrawals,
  }))

  return (
    <div className="fade-up">
      <PageHead
        title="Market Overview"
        subtitle={`Live multi-chain intelligence — real stablecoin & native settlement across ${chainSplit.length || 9} indexed chains`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Volume Tracked" value={fmtUsd(animTotal)} accent="gold" icon={<Activity size={18} />} />
        <StatCard label="On-chain Reserves" value={fmtUsd(stats?.reserves ?? 0)} accent="violet" icon={<Wallet size={18} />} />
        <StatCard label="Unique Counterparties" value={fmtNum(stats?.uniquePlayers ?? 0)} accent="mint" icon={<Users size={18} />} />
        <StatCard label="Entities Watched" value={String(stats?.entities ?? 0)} accent="gold" icon={<Building2 size={18} />} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-display text-lg font-semibold">On-chain Flow</h3>
              <p className="text-sm text-white/45">Deposits vs withdrawals across the indexed window</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex gap-1 rounded-lg border border-white/8 bg-white/4 p-0.5">
                {[7, 14, 30].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={`rounded-md px-2 py-0.5 text-[12px] font-semibold transition ${
                      days === d ? 'bg-gold-500/15 text-gold-400' : 'text-white/45 hover:text-white'
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
              <div className="hidden gap-4 text-xs sm:flex">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-500" /> Deposits</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-gold-500" /> Withdrawals</span>
              </div>
            </div>
          </div>
          <div className="h-64">
            {chartData.length === 0 ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ left: -8, right: 6, top: 4 }}>
                  <defs>
                    <linearGradient id="dep" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b3df0" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#8b3df0" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="wd" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f5b100" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#f5b100" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#ffffff10" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#ffffff40', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={40} />
                  <YAxis tick={{ fill: '#ffffff40', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtUsd(v)} width={56} />
                  <Tooltip content={<ChartTip />} />
                  <Area type="monotone" dataKey="deposits" stroke="#8b3df0" strokeWidth={2} fill="url(#dep)" />
                  <Area type="monotone" dataKey="withdrawals" stroke="#f5b100" strokeWidth={2} fill="url(#wd)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold">Volume by Chain</h3>
            {chainSplit.length > 0 && (
              <span className="rounded-lg bg-white/6 px-2 py-0.5 text-[12px] font-semibold text-white/70">{chainSplit.length} chains</span>
            )}
          </div>
          <p className="text-sm text-white/45">Share of indexed settlement · 7d</p>
          <div className="mt-2 flex items-center justify-center">
            <div className="h-44 w-44">
              {chainSplit.length === 0 ? (
                <Skeleton className="h-full w-full rounded-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={chainSplit} dataKey="value" nameKey="chain" innerRadius={48} outerRadius={70} paddingAngle={3} stroke="none">
                      {chainSplit.map((c) => (
                        <Cell key={c.chain} fill={c.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTip />} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
          <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto pr-1">
            {chainSplit.map((c) => (
              <div key={c.chain} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                <span className="text-white/70">{c.chain}</span>
                <span className="ml-auto tabular-nums text-white/45">{fmtUsd(c.value)}</span>
                <span className="w-12 text-right font-semibold tabular-nums">{((c.value / totalChain) * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold">Live Transfers</h3>
            <span className="live-dot h-2 w-2 rounded-full bg-mint-400" />
          </div>
          <div className="space-y-2">
            {feed.length === 0 && <EmptyState title="Awaiting on-chain events…" />}
            {feed.map((t, i) => (
              <div key={`${t.chain}:${t.tx_hash}:${t.counterparty}:${i}`} className="row-flash flex items-center gap-2.5 rounded-lg px-1 py-1.5">
                <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${t.direction === 'in' ? 'bg-mint-400/12 text-mint-400' : 'bg-rose-400/12 text-rose-400'}`}>
                  {t.direction === 'in' ? <ArrowDownRight size={15} /> : <ArrowUpRight size={15} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.label}</div>
                  <div className="text-[11px] text-white/40">{timeAgo(t.ts)}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums">{fmtUsd(t.usd)}</div>
                  <ChainPill chain={t.chain} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-3 font-display text-lg font-semibold">Top Entities · Volume</h3>
          <div className="space-y-2.5">
            {!entities && <Skeleton className="h-40 w-full" />}
            {top.map((c, i) => (
              <div key={c.id} className="flex items-center gap-3">
                <span className="w-4 text-center text-sm font-bold text-white/30">{i + 1}</span>
                <Bubble seed={c.label} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{c.label}</span>
                    <CategoryBadge category={c.category} />
                  </div>
                  <div className="text-[11px] text-white/40">{fmtNum(c.players)} counterparties</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums">{fmtUsd(c.volume7d)}</div>
                  <Delta value={c.change24h} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold">Streamers Live</h3>
            <Radio size={16} className="text-white/30" />
          </div>
          {!streamersRes ? (
            <Skeleton className="h-28 w-full" />
          ) : !streamersRes.enabled ? (
            <EmptyState
              title="Streamer feed off"
              hint="Add Twitch API credentials to .env to monitor live casino streamers."
              icon={<Radio size={28} />}
            />
          ) : liveStreamers.length === 0 ? (
            <EmptyState title="No casino streamers live right now" />
          ) : (
            <div className="space-y-2.5">
              {liveStreamers.map((s) => (
                <div key={s.id} className="flex items-center gap-3">
                  <div className="relative">
                    <Bubble seed={s.handle} size={32} />
                    <span className="live-dot absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-rose-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.handle}</div>
                    <div className="truncate text-[11px] text-white/40">{s.title}</div>
                  </div>
                  <div className="text-right text-sm font-semibold tabular-nums text-mint-400">
                    {fmtNum(s.viewers)}
                    <div className="text-[10px] font-normal text-white/40">viewers</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
