import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, Plus, Trash2, Webhook, Activity, TrendingDown, Fish } from 'lucide-react'
import { Card, PageHead, ChainPill, Skeleton } from '../components/ui'
import { api, usePoll, getToken, AlertRule } from '../data/api'
import { fmtUsd, timeAgo } from '../data/format'

const KINDS = [
  { key: 'whale', label: 'Whale transfer', icon: <Fish size={14} />, hint: 'Fire when a single transfer on the target exceeds the amount.', unit: '$', dWindow: false },
  { key: 'netflow', label: 'Net outflow', icon: <Activity size={14} />, hint: 'Fire when withdrawals minus deposits exceed the amount over the window — liquidity-stress signal.', unit: '$', dWindow: true },
  { key: 'reserve_drop', label: 'Reserve drop', icon: <TrendingDown size={14} />, hint: 'Fire when on-chain reserves fall by more than the percent.', unit: '%', dWindow: false },
] as const

export default function Alerts() {
  const loggedIn = !!getToken()
  const [tick, setTick] = useState(0)
  const { data: rules } = usePoll(api.alertRules, 20_000, [tick])
  const { data: events } = usePoll(() => api.alertEvents(60), 8_000)
  const { data: entities } = usePoll(api.casinos, 30_000)

  const [kind, setKind] = useState<'whale' | 'netflow' | 'reserve_drop'>('whale')
  const [scope, setScope] = useState('all')
  const [threshold, setThreshold] = useState(100000)
  const [windowH, setWindowH] = useState(24)
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)
  const meta = KINDS.find((k) => k.key === kind)!

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const scopeLabel = scope === 'all' ? 'All watched entities' : (entities ?? []).find((x) => String(x.id) === scope)?.label
      await api.createAlertRule({ kind, scope, scopeLabel, threshold, windowH, webhook: webhook || undefined })
      setWebhook('')
      setTick((t) => t + 1)
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: number) {
    await api.deleteAlertRule(id)
    setTick((t) => t + 1)
  }

  if (!loggedIn) {
    return (
      <div className="fade-up">
        <PageHead title="Alerts" subtitle="Get notified the moment a watched entity moves" />
        <Card className="p-8 text-center">
          <BellRing size={32} className="mx-auto text-gold-400" />
          <p className="mt-3 text-white/60"><Link to="/login" className="font-semibold text-gold-400 underline">Sign in</Link> to create alert rules and receive whale, net-flow and reserve notifications.</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="fade-up">
      <PageHead title="Alerts" subtitle="Rules evaluated live against the indexer — in-app feed + optional webhook push" right={<BellRing size={18} className="text-gold-400" />} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* rule builder */}
        <Card className="p-5">
          <h3 className="mb-3 font-display text-lg font-semibold">New rule</h3>
          <form onSubmit={create} className="space-y-3">
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Trigger</label>
              <div className="grid grid-cols-1 gap-1.5">
                {KINDS.map((k) => (
                  <button key={k.key} type="button" onClick={() => { setKind(k.key); setThreshold(k.key === 'reserve_drop' ? 20 : 100000) }}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition ${kind === k.key ? 'border-gold-500/40 bg-gold-500/12 text-gold-400' : 'border-white/10 bg-white/3 text-white/60 hover:bg-white/6'}`}>
                    {k.icon}<span className="font-medium">{k.label}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-white/40">{meta.hint}</p>
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-white/55">Target</label>
              <select value={scope} onChange={(e) => setScope(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-sm focus:border-gold-500/40 focus:outline-none">
                <option value="all" className="bg-ink-800">All watched entities</option>
                {(entities ?? []).slice(0, 60).map((x) => (
                  <option key={x.id} value={x.id} className="bg-ink-800">{x.label}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-[13px] text-white/55">Threshold ({meta.unit})</label>
                <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="w-full rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-sm tabular-nums focus:border-gold-500/40 focus:outline-none" />
              </div>
              {meta.dWindow && (
                <div className="w-24">
                  <label className="mb-1 block text-[13px] text-white/55">Window</label>
                  <select value={windowH} onChange={(e) => setWindowH(Number(e.target.value))} className="w-full rounded-xl border border-white/10 bg-white/4 px-2 py-2 text-sm focus:border-gold-500/40 focus:outline-none">
                    {[1, 6, 24, 72].map((h) => <option key={h} value={h} className="bg-ink-800">{h}h</option>)}
                  </select>
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-[13px] text-white/55"><Webhook size={12} /> Webhook URL (optional)</label>
              <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://hooks.…" className="w-full rounded-xl border border-white/10 bg-white/4 px-3 py-2 font-mono text-[12px] placeholder:text-white/25 focus:border-gold-500/40 focus:outline-none" />
            </div>
            <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60">
              <Plus size={15} /> Create rule
            </button>
          </form>
        </Card>

        {/* active rules + event feed */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-5">
            <h3 className="mb-3 font-display text-lg font-semibold">Active rules</h3>
            {!rules ? <Skeleton className="h-16 w-full" /> : rules.length === 0 ? (
              <p className="text-sm text-white/40">No rules yet — create one to start watching.</p>
            ) : (
              <div className="space-y-2">
                {rules.map((r: AlertRule) => (
                  <div key={r.id} className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5 text-sm">
                    <span className="text-gold-400">{KINDS.find((k) => k.key === r.kind)?.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">
                        {KINDS.find((k) => k.key === r.kind)?.label} · {r.kind === 'reserve_drop' ? `${r.threshold}%` : fmtUsd(r.threshold)}{r.kind === 'netflow' ? ` / ${r.window_h}h` : ''}
                      </div>
                      <div className="text-[12px] text-white/45">{r.scope_label ?? 'All entities'}{r.webhook ? ' · webhook' : ''}</div>
                    </div>
                    <button onClick={() => remove(r.id)} className="rounded-lg p-1.5 text-white/40 hover:bg-rose-400/10 hover:text-rose-400"><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-semibold">Triggered alerts</h3>
              <span className="live-dot h-2 w-2 rounded-full bg-mint-400" />
            </div>
            {!events ? <Skeleton className="h-32 w-full" /> : events.length === 0 ? (
              <p className="text-sm text-white/40">No alerts fired yet. They appear here the instant a rule matches.</p>
            ) : (
              <div className="max-h-[460px] space-y-2 overflow-y-auto">
                {events.map((ev: any) => (
                  <div key={ev.id} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-sm font-medium">{ev.title}</span>
                      {ev.chain && <ChainPill chain={ev.chain} />}
                      <span className="text-[11px] text-white/40">{timeAgo(ev.ts)}</span>
                    </div>
                    {ev.detail && <div className="mt-1 text-[12px] text-white/50">{ev.detail}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
