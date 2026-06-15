import { TrendingUp, Boxes, ExternalLink, Layers } from 'lucide-react'
import { Card, PageHead, Skeleton } from '../components/ui'
import { api, usePoll } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

function pct(prices: string[] | null): number | null {
  if (!prices || !prices.length) return null
  const p = Number(prices[0])
  return Number.isFinite(p) ? Math.round(p * 100) : null
}

export default function Markets() {
  const { data: pm, loading: lpm } = usePoll(api.predictions, 60_000)
  const { data: proto, loading: lproto } = usePoll(() => api.protocols(), 120_000)

  return (
    <div className="fade-up">
      <PageHead
        title="On-Chain Markets"
        subtitle="The transparent side of iGaming — prediction markets and on-chain betting protocols, live from the chain"
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Prediction Mkt TVL</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <Boxes size={18} className="text-mint-400" />
            {proto ? fmtUsd(proto.totalTvl) : '—'}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">On-chain Protocols</div>
          <div className="mt-1 font-display text-2xl font-bold tabular-nums">{proto?.count ?? '—'}</div>
        </Card>
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Polymarket · top vol</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <TrendingUp size={18} className="text-violet-400" />
            {pm ? fmtUsd(pm.totalVolume) : '—'}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Live markets</div>
          <div className="mt-1 font-display text-2xl font-bold tabular-nums">{pm?.count ?? '—'}</div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Top prediction markets */}
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
            <TrendingUp size={16} className="text-violet-400" />
            <h3 className="font-display text-base font-bold">Top Prediction Markets</h3>
            <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-white/50">Polymarket</span>
          </div>
          {lpm && !pm ? (
            <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              {(pm?.markets ?? []).map((m) => {
                const yes = pct(m.prices)
                return (
                  <a
                    key={m.id}
                    href={m.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5 transition hover:bg-white/[0.03]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-white/85">{m.question}</div>
                      <div className="mt-0.5 text-[11px] text-white/40">{fmtUsd(m.volume ?? 0)} vol</div>
                    </div>
                    {yes != null && (
                      <div className="shrink-0 text-right">
                        <div className={`text-sm font-bold tabular-nums ${yes >= 50 ? 'text-mint-400' : 'text-white/60'}`}>{yes}%</div>
                        <div className="text-[10px] text-white/35">{Array.isArray(m.outcomes) ? m.outcomes[0] : 'Yes'}</div>
                      </div>
                    )}
                  </a>
                )
              })}
            </div>
          )}
        </Card>

        {/* On-chain protocols by TVL */}
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
            <Layers size={16} className="text-mint-400" />
            <h3 className="font-display text-base font-bold">On-Chain Protocols</h3>
            <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-white/50">by TVL</span>
          </div>
          {lproto && !proto ? (
            <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              {(proto?.protocols ?? []).map((p, i) => (
                <a
                  key={p.slug}
                  href={p.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5 transition hover:bg-white/[0.03]"
                >
                  <span className="w-5 text-right text-[12px] tabular-nums text-white/30">{i + 1}</span>
                  {p.logo ? <img src={p.logo} alt="" className="h-6 w-6 rounded-full bg-white/5" /> : <div className="h-6 w-6 rounded-full bg-white/8" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 truncate text-[13px] font-medium">
                      {p.name}
                      {p.url && <ExternalLink size={10} className="shrink-0 text-white/25" />}
                    </div>
                    <div className="truncate text-[11px] text-white/40">{p.category} · {p.chains}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[13px] font-semibold tabular-nums text-white/85">{fmtUsd(p.tvl ?? 0)}</div>
                    {p.change_7d != null && (
                      <div className={`text-[10px] tabular-nums ${p.change_7d >= 0 ? 'text-mint-400' : 'text-rose-400'}`}>
                        {p.change_7d >= 0 ? '+' : ''}{p.change_7d.toFixed(1)}% 7d
                      </div>
                    )}
                  </div>
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-3 text-[12px] text-white/35">
        Prediction-market odds & volume from Polymarket; on-chain protocol TVL from DefiLlama. Everything here is fully
        on-chain and verifiable — the most transparent corner of iGaming. {fmtNum(proto?.count ?? 0)} protocols tracked.
      </p>
    </div>
  )
}
