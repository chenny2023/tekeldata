import { useState } from 'react'
import { Sparkles, Loader2, CheckCircle2, AlertTriangle, ShieldX, FileText } from 'lucide-react'
import { Card, PageHead, Skeleton } from '../components/ui'
import { api, usePoll, type ContentPreview } from '../data/api'
import { timeAgo } from '../data/format'

const TYPES = [
  { key: 'daily_market_thread', label: 'Daily Market Thread', desc: 'Multi-tweet market snapshot thread (13:00 UTC)' },
  { key: 'top_ranking_image_post', label: 'Top Ranking Post', desc: 'Verified flow ranking + image card (16:00 UTC)' },
  { key: 'rotating_signal_post', label: 'Rotating Signal', desc: 'Single reserve/chain/unattributed signal (20:00 UTC)' },
] as const

function StatusPill({ status, risk }: { status: string; risk?: string }) {
  const ok = status === 'qa_pass' || status === 'qa_pass_no_x_keys' || status === 'published'
  const danger = status === 'risk_high' || status === 'generation_fail'
  const cls = ok ? 'bg-mint-400/15 text-mint-400' : danger ? 'bg-rose-400/15 text-rose-400' : 'bg-gold-500/15 text-gold-400'
  const Icon = ok ? CheckCircle2 : danger ? ShieldX : AlertTriangle
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold ${cls}`}>
      <Icon size={13} /> {status}{risk ? ` · risk ${risk}` : ''}
    </span>
  )
}

function Preview({ res }: { res: ContentPreview }) {
  if (res.status === 'disabled')
    return <div className="rounded-xl border border-gold-500/25 bg-gold-500/8 px-4 py-3 text-[13px] text-gold-400">OpenRouter not configured — set <code>OPENROUTER_API_KEY</code> in the server env.</div>
  if (res.error && !res.data) return <div className="rounded-xl bg-rose-400/10 px-4 py-3 text-[13px] text-rose-400">{res.status}: {res.error}</div>
  const d = res.data ?? {}
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={res.status} risk={res.risk} />
        {res.status.startsWith('qa_pass') && <span className="text-[12px] text-white/45">Passed QA — would publish when X keys are set. Nothing was posted.</span>}
        {(res.status === 'risk_high' || res.status === 'qa_fail') && <span className="text-[12px] text-rose-300/80">Auto-skipped — would NOT be posted.</span>}
      </div>
      {res.qa && res.qa.failures.length > 0 && (
        <div className="rounded-xl bg-rose-400/8 px-4 py-2.5 text-[13px] text-rose-300">
          QA failures: {res.qa.failures.join(' · ')}
        </div>
      )}
      {d.tweets && d.tweets.length > 0 && (
        <div className="space-y-2">
          {d.tweets.map((t, i) => (
            <div key={i} className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
              <div className="mb-1 text-[11px] text-white/35">Tweet {i + 1} · {t.text.length}/280</div>
              <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-white/85">{t.text}</div>
            </div>
          ))}
        </div>
      )}
      {d.post_text && (
        <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
          <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-white/85">{d.post_text}</div>
        </div>
      )}
      {d.image?.rows && d.image.rows.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-semibold">{d.image.title}</div>
          {d.image.subtitle && <div className="text-[12px] text-white/50">{d.image.subtitle}</div>}
          <div className="mt-2 divide-y divide-white/6">
            {d.image.rows.map((r) => (
              <div key={r.rank} className="flex items-center gap-3 py-1.5 text-sm">
                <span className="w-5 text-center font-bold text-white/30">{r.rank}</span>
                <span className="flex-1 font-medium">{r.brand}</span>
                <span className="tabular-nums text-gold-400">{r.value}</span>
              </div>
            ))}
          </div>
          {d.image.footer && <div className="mt-2 text-[11px] text-white/35">{d.image.footer}</div>}
        </Card>
      )}
      {d.data_notes && d.data_notes.length > 0 && <div className="text-[12px] text-white/40">Notes: {d.data_notes.join(' · ')}</div>}
    </div>
  )
}

export default function Content() {
  const [type, setType] = useState<string>('daily_market_thread')
  const [res, setRes] = useState<ContentPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: logData } = usePoll(api.contentLog, 20_000)

  async function run(t: string) {
    setType(t)
    setBusy(true)
    setRes(null)
    try {
      setRes(await api.contentPreview(t))
    } catch (e) {
      setRes({ status: 'error', error: String((e as Error).message) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fade-up">
      <PageHead title="Social Content" subtitle="Preview the automated X content (Grok → QA) before it publishes. Preview never posts." right={<Sparkles size={18} className="text-gold-400" />} />

      <div className="grid gap-3 sm:grid-cols-3">
        {TYPES.map((t) => (
          <Card key={t.key} hover className={`cursor-pointer p-4 ${type === t.key ? 'ring-1 ring-gold-500/40' : ''}`} onClick={() => run(t.key)}>
            <div className="flex items-center justify-between">
              <div className="font-medium">{t.label}</div>
              {busy && type === t.key ? <Loader2 size={15} className="animate-spin text-gold-400" /> : <FileText size={15} className="text-white/30" />}
            </div>
            <div className="mt-1 text-[12px] text-white/45">{t.desc}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-base font-semibold">Preview · {TYPES.find((t) => t.key === type)?.label}</h3>
          <button onClick={() => run(type)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-gold-500/15 px-3 py-1.5 text-[13px] font-semibold text-gold-400 hover:bg-gold-500/25 disabled:opacity-60">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate preview
          </button>
        </div>
        {busy ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div> : res ? <Preview res={res} /> : <p className="text-sm text-white/40">Click a card or “Generate preview” to run Grok + QA on the latest snapshot. It costs OpenRouter tokens and never posts to X.</p>}
      </Card>

      <Card className="mt-4 p-5">
        <h3 className="mb-3 font-display text-base font-semibold">Recent runs</h3>
        {!logData ? (
          <Skeleton className="h-20 w-full" />
        ) : logData.items.length === 0 ? (
          <p className="text-sm text-white/40">No runs yet. Auto-publish is off until <code>CONTENT_ENABLED=1</code> + the X keys are set.</p>
        ) : (
          <div className="divide-y divide-white/6 text-sm">
            {logData.items.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="text-white/40">{timeAgo(r.created_at)}</span>
                <span className="font-medium">{r.content_type}</span>
                <StatusPill status={r.status} risk={r.risk_level ?? undefined} />
                {r.published_url && <a href={r.published_url} target="_blank" rel="noreferrer" className="text-gold-400 hover:underline">view post →</a>}
                {r.skipped_reason && <span className="text-[12px] text-rose-300/70">{r.skipped_reason}</span>}
                {r.model && <span className="text-[11px] text-white/30">{r.model}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
