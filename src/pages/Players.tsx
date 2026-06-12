import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, PageHead, StatCard, Bubble, Skeleton } from '../components/ui'
import { api, usePoll } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'
import { Users, Layers, Crown, Activity } from 'lucide-react'

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="glass rounded-lg px-3 py-2 text-xs">
      <div className="mb-1 text-white/50">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-white/70">{p.name}</span>
          <span className="ml-auto font-semibold">{typeof p.value === 'number' ? fmtUsd(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function Players() {
  const { data: flow } = usePoll(api.flow, 20_000)
  const { data: stats } = usePoll(api.stats, 15_000)
  const { data: entities } = usePoll(api.casinos, 15_000)

  const buckets = flow ?? []
  const whaleBucket = buckets.find((b) => b.name === 'Whale')
  const totalVol = buckets.reduce((s, b) => s + b.volume, 0) || 1
  const whaleShare = whaleBucket ? (whaleBucket.volume / totalVol) * 100 : 0
  const totalTx = buckets.reduce((s, b) => s + b.count, 0)
  const avgTx = totalTx ? totalVol / totalTx : 0
  const byCounterparties = (entities ?? []).slice().sort((a, b) => b.players - a.players).slice(0, 8)

  return (
    <div className="fade-up">
      <PageHead
        title="Flow Intelligence"
        subtitle="Counterparty segmentation & transaction-size distribution from real on-chain flow"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Unique Counterparties" value={fmtNum(stats?.uniquePlayers ?? 0)} icon={<Users size={18} />} accent="violet" />
        <StatCard label="Indexed Transfers" value={fmtNum(stats?.totalTransfers ?? 0)} icon={<Activity size={18} />} accent="mint" />
        <StatCard label="Whale Share of Volume" value={`${whaleShare.toFixed(0)}%`} icon={<Crown size={18} />} accent="gold" />
        <StatCard label="Avg Transfer Size" value={fmtUsd(avgTx)} icon={<Layers size={18} />} accent="gold" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-1">
          <h3 className="font-display text-lg font-semibold">Segments by Transfer Size</h3>
          <p className="mb-4 text-sm text-white/45">Real counterparties bucketed by USD value</p>
          <div className="space-y-3">
            {!flow && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            {buckets.map((s) => (
              <div key={s.name} className="rounded-xl bg-white/[0.03] p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="font-medium">{s.name}</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{s.share.toFixed(1)}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/8">
                  <div className="h-full rounded-full" style={{ width: `${s.share}%`, background: s.color }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-[12px] text-white/45">
                  <span>{fmtNum(s.players)} counterparties · {fmtNum(s.count)} tx</span>
                  <span className="font-semibold text-white/80">{fmtUsd(s.volume)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5 xl:col-span-2">
          <h3 className="font-display text-lg font-semibold">Volume by Segment</h3>
          <p className="mb-3 text-sm text-white/45">Where settlement value concentrates</p>
          <div className="h-72">
            {!flow ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buckets} margin={{ left: -4, right: 8, top: 6 }}>
                  <CartesianGrid stroke="#ffffff10" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: '#ffffff60', fontSize: 12 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: '#ffffff40', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtUsd(v)} width={56} />
                  <Tooltip content={<Tip />} cursor={{ fill: '#ffffff08' }} />
                  <Bar dataKey="volume" name="Volume" radius={[6, 6, 0, 0]}>
                    {buckets.map((b) => (
                      <Cell key={b.name} fill={b.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <h3 className="font-display text-lg font-semibold">Entities by Distinct Counterparties</h3>
        <p className="mb-4 text-sm text-white/45">A real on-chain proxy for active depositor reach</p>
        <div className="space-y-2.5">
          {byCounterparties.map((e, i) => {
            const max = byCounterparties[0]?.players || 1
            return (
              <div key={e.id} className="flex items-center gap-3">
                <span className="w-4 text-center text-sm font-bold text-white/30">{i + 1}</span>
                <Bubble seed={e.label} size={28} />
                <span className="w-32 shrink-0 truncate text-sm font-medium">{e.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/8">
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-400" style={{ width: `${(e.players / max) * 100}%` }} />
                </div>
                <span className="w-14 text-right text-sm font-semibold tabular-nums">{fmtNum(e.players)}</span>
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
