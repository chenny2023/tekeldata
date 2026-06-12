import { useState } from 'react'
import { Copy, Check, Code2, Zap, Activity, Radio } from 'lucide-react'
import { Card, PageHead, Skeleton } from '../components/ui'
import { api, usePoll } from '../data/api'
import { fmtNum } from '../data/format'

const BASE = typeof window !== 'undefined' ? window.location.origin : ''

const ENDPOINTS: { method: string; path: string; desc: string }[] = [
  { method: 'GET', path: '/api/stats', desc: 'Global totals: volume, reserves, counterparties, chain split' },
  { method: 'GET', path: '/api/entities', desc: 'Entity leaderboard (volume, trust, reserves, net flow)' },
  { method: 'GET', path: '/api/transfers', desc: 'Transfer feed — filter by chain, dir, min, limit' },
  { method: 'GET', path: '/api/series', desc: '6-hour bucketed deposit/withdrawal time-series' },
  { method: 'GET', path: '/api/flow', desc: 'Counterparty segmentation by transfer size' },
  { method: 'GET', path: '/api/streamers', desc: 'Live Twitch casino streamers (if configured)' },
  { method: 'GET', path: '/api/stream', desc: 'Server-Sent Events — live transfer push' },
  { method: 'GET', path: '/api/watchlist', desc: 'List tracked addresses' },
  { method: 'POST', path: '/api/watchlist', desc: 'Add an address to the indexer' },
  { method: 'DELETE', path: '/api/watchlist/:id', desc: 'Stop tracking an address' },
]

export default function ApiAccess() {
  const { data: health } = usePoll(api.health, 10_000)
  const [copied, setCopied] = useState('')

  function copy(text: string, id: string) {
    navigator.clipboard?.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 1400)
  }

  const snippet = `curl ${BASE}/api/transfers?chain=ETH&min=100000&limit=50`

  return (
    <div className="fade-up">
      <PageHead
        title="API Access"
        subtitle="Every dashboard metric is served by a live REST endpoint — pipe it anywhere"
        right={<span className="rounded-lg bg-mint-400/12 px-3 py-1.5 text-[12px] font-semibold text-mint-400 ring-1 ring-mint-400/30">No key required (local)</span>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-2 flex items-center gap-2"><Code2 size={18} className="text-violet-400" /><h3 className="font-display text-lg font-semibold">Quick start</h3></div>
          <div className="relative overflow-hidden rounded-xl border border-white/8 bg-black/50">
            <button onClick={() => copy(snippet, 'snip')} className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-white/6 text-white/60 hover:text-gold-400">
              {copied === 'snip' ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-mint-400"><code>{snippet}</code></pre>
          </div>
          <p className="mt-2 text-[12px] text-white/40">
            For the live stream: <code className="text-white/70">new EventSource('{BASE}/api/stream')</code>. Add
            an auth layer (API keys / JWT) in <code className="text-white/70">server/src/api.ts</code> before exposing publicly.
          </p>

          <h3 className="mb-3 mt-5 font-display text-lg font-semibold">Endpoints</h3>
          <div className="divide-y divide-white/6 rounded-xl border border-white/8">
            {ENDPOINTS.map((e) => (
              <div key={e.method + e.path} className="flex items-center gap-3 p-3">
                <span className={`w-14 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[11px] font-bold ${e.method === 'GET' ? 'bg-mint-400/12 text-mint-400' : e.method === 'POST' ? 'bg-violet-500/15 text-violet-300' : 'bg-rose-400/12 text-rose-400'}`}>{e.method}</span>
                <code className="shrink-0 font-mono text-[13px] text-white/85">{e.path}</code>
                <span className="ml-auto hidden truncate text-[13px] text-white/45 sm:block">{e.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2"><Activity size={17} className="text-gold-400" /><h3 className="font-display text-lg font-semibold">Live status</h3></div>
            {!health ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <div className="space-y-2.5 text-sm">
                <Row label="API" value={<span className="text-mint-400">● online</span>} />
                <Row label="Environment" value={health.env} />
                <Row label="Watched addresses" value={String(health.watchlist)} />
                <Row label="Indexed transfers" value={fmtNum(health.transfers)} />
                <Row label="ETH last block" value={health.evmLastBlock.toLocaleString()} />
                <Row label="History depth" value={`${health.historyDays.toFixed(1)} days`} />
                <Row label="Deep backfill" value={health.backfillPct >= 100 ? <span className="text-mint-400">complete</span> : `${health.backfillPct}%`} />
                <Row label="Twitch module" value={health.twitch ? <span className="text-mint-400">enabled</span> : <span className="text-white/40">off</span>} />
              </div>
            )}
          </Card>
          <Card className="p-5">
            <div className="mb-2 flex items-center gap-2"><Zap size={17} className="text-gold-400" /><h3 className="font-display text-lg font-semibold">Real-time</h3></div>
            <p className="text-[13px] text-white/50">The <code className="text-white/70">/api/stream</code> SSE endpoint pushes every newly-indexed transfer the moment it lands on-chain.</p>
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-[13px]">
              <Radio size={14} className="text-mint-400" /> <span className="text-white/70">SSE connected on this dashboard</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 pb-2">
      <span className="text-white/50">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  )
}
