import { useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Boxes, Filter, ExternalLink } from 'lucide-react'
import { Card, PageHead, ChainPill, LiveBadge, Bubble, EmptyState } from '../components/ui'
import { api, usePoll, useLiveFeed } from '../data/api'
import { fmtUsd, timeAgo, shortHash, CHAIN_COLOR } from '../data/format'

const TX_URL: Record<string, (h: string) => string> = {
  ETH: (h) => `https://etherscan.io/tx/${h}`,
  TRON: (h) => `https://tronscan.org/#/transaction/${h}`,
  BSC: (h) => `https://bscscan.com/tx/${h}`,
  BASE: (h) => `https://basescan.org/tx/${h}`,
  ARB: (h) => `https://arbiscan.io/tx/${h}`,
  OP: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  POLYGON: (h) => `https://polygonscan.com/tx/${h}`,
  AVAX: (h) => `https://snowtrace.io/tx/${h}`,
  SOL: (h) => `https://solscan.io/tx/${h}`,
}

export default function Blockchain() {
  const feed = useLiveFeed(120)
  const { data: stats } = usePoll(api.stats, 12_000)
  const [chain, setChain] = useState('ALL')
  const [dir, setDir] = useState<'ALL' | 'in' | 'out'>('ALL')
  const [minAmt, setMinAmt] = useState(0)

  const rows = useMemo(
    () =>
      feed.filter(
        (t) =>
          (chain === 'ALL' || t.chain === chain) &&
          (dir === 'ALL' || t.direction === dir) &&
          t.usd >= minAmt,
      ),
    [feed, chain, dir, minAmt],
  )

  const whales = feed.filter((t) => t.usd > 100_000).slice(0, 6)
  const win = feed.slice(0, 60)
  const inflow = win.filter((t) => t.direction === 'in').reduce((s, t) => s + t.usd, 0)
  const outflow = win.filter((t) => t.direction === 'out').reduce((s, t) => s + t.usd, 0)

  // chains offered in the filter = those with indexed volume, plus any seen live
  const chainSplit = (stats?.chainSplit ?? []).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
  const chainCount = chainSplit.length
  const CHAINS = useMemo(() => {
    const set = new Set<string>(chainSplit.map((c) => c.chain))
    for (const t of feed) set.add(t.chain)
    return ['ALL', ...[...set].sort()]
  }, [stats, feed])

  return (
    <div className="fade-up">
      <PageHead
        title="Blockchain Mapping"
        subtitle="Real-time deposit & withdrawal flow across 9 chains — stablecoins & native settlement"
        right={<LiveBadge />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Net Flow · live 60</div>
          <div className={`mt-1 font-display text-2xl font-bold ${inflow >= outflow ? 'text-mint-400' : 'text-rose-400'}`}>
            {inflow >= outflow ? '+' : '−'}{fmtUsd(Math.abs(inflow - outflow))}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Inflow</div>
          <div className="mt-1 font-display text-2xl font-bold text-mint-400">{fmtUsd(inflow)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Outflow</div>
          <div className="mt-1 font-display text-2xl font-bold text-gold-400">{fmtUsd(outflow)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Chains Mapped</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <Boxes size={20} className="text-violet-400" /> {chainCount || 9}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Filter size={15} className="text-white/40" />
            {CHAINS.map((c) => (
              <button key={c} onClick={() => setChain(c)} className={`rounded-lg px-2.5 py-1 text-[12px] font-semibold transition ${chain === c ? 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40' : 'text-white/50 hover:bg-white/5'}`}>
                {c}
              </button>
            ))}
            <div className="mx-1 h-4 w-px bg-white/10" />
            {([['ALL', 'All'], ['in', 'Deposits'], ['out', 'Withdrawals']] as const).map(([d, label]) => (
              <button key={d} onClick={() => setDir(d)} className={`rounded-lg px-2.5 py-1 text-[12px] font-semibold transition ${dir === d ? 'bg-gold-500/15 text-gold-400 ring-1 ring-gold-500/30' : 'text-white/50 hover:bg-white/5'}`}>
                {label}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-[12px] text-white/50">
              Min ${minAmt >= 1000 ? `${minAmt / 1000}K` : minAmt}
              <input type="range" min={0} max={200000} step={5000} value={minAmt} onChange={(e) => setMinAmt(Number(e.target.value))} className="accent-gold-500" />
            </label>
          </div>

          <div className="max-h-[560px] overflow-y-auto">
            {rows.length === 0 ? (
              <EmptyState title="Listening for on-chain transfers…" hint="New USDT/USDC events stream in live as blocks are indexed." />
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-ink-900/90 backdrop-blur">
                  <tr className="text-left text-[12px] uppercase tracking-wider text-white/40">
                    <th className="px-2 py-2 font-medium">Type</th>
                    <th className="px-2 py-2 font-medium">Entity</th>
                    <th className="px-2 py-2 font-medium">Amount</th>
                    <th className="px-2 py-2 font-medium">Chain</th>
                    <th className="px-2 py-2 font-medium">Counterparty</th>
                    <th className="px-2 py-2 font-medium text-right">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t, i) => (
                    <tr key={`${t.chain}:${t.tx_hash}:${t.counterparty}:${i}`} className={`border-b border-white/5 ${i === 0 ? 'row-flash' : ''}`}>
                      <td className="px-2 py-2.5">
                        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${t.direction === 'in' ? 'bg-mint-400/12 text-mint-400' : 'bg-rose-400/12 text-rose-400'}`}>
                          {t.direction === 'in' ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />}
                          {t.direction === 'in' ? 'In' : 'Out'}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 font-medium">{t.label}</td>
                      <td className="px-2 py-2.5 font-semibold tabular-nums">
                        {fmtUsd(t.usd)} <span className="text-[11px] font-normal text-white/40">{t.token}</span>
                      </td>
                      <td className="px-2 py-2.5"><ChainPill chain={t.chain} /></td>
                      <td className="px-2 py-2.5 font-mono text-[12px] text-white/50">{shortHash(t.counterparty)}</td>
                      <td className="px-2 py-2.5 text-right">
                        <a href={TX_URL[t.chain]?.(t.tx_hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-white/40 hover:text-gold-400">
                          {timeAgo(t.ts)} <ExternalLink size={10} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <h3 className="mb-3 font-display text-lg font-semibold">🐋 Whale Alerts</h3>
            <div className="space-y-2.5">
              {whales.length === 0 && <p className="text-sm text-white/40">Watching for transfers &gt; $100K…</p>}
              {whales.map((t, i) => (
                <div key={`${t.chain}:${t.tx_hash}:${t.counterparty}:${i}`} className="flex items-center gap-3 rounded-lg bg-white/[0.03] p-2.5">
                  <Bubble seed={t.label} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.label}</div>
                    <div className="text-[11px] text-white/40">{t.direction === 'in' ? 'deposit' : 'withdrawal'} · {timeAgo(t.ts)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-gold-400 tabular-nums">{fmtUsd(t.usd)}</div>
                    <ChainPill chain={t.chain} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="mb-3 font-display text-lg font-semibold">Chain Distribution</h3>
            <div className="space-y-3">
              {(() => {
                const total = chainSplit.reduce((s, c) => s + c.value, 0) || 1
                return chainSplit.map((c) => {
                  const pct = (c.value / total) * 100
                  const color = CHAIN_COLOR[c.chain] ?? '#888'
                  return (
                    <div key={c.chain}>
                      <div className="mb-1 flex justify-between text-[13px]">
                        <span className="flex items-center gap-1.5 text-white/70">
                          <span className="h-2 w-2 rounded-full" style={{ background: color }} />{c.chain}
                        </span>
                        <span className="tabular-nums text-white/45">{fmtUsd(c.value)} · <span className="font-semibold text-white/80">{pct.toFixed(1)}%</span></span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
