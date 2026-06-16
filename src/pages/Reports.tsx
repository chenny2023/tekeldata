import { useState } from 'react'
import { FileBarChart, Download, Clock, CheckCircle2, Loader2 } from 'lucide-react'
import { Card, PageHead } from '../components/ui'
import { api } from '../data/api'

type Format = 'csv' | 'json'

const TEMPLATES = [
  { key: 'transfers', name: 'On-chain Transfer Log', desc: 'Every indexed USDT/USDC deposit & withdrawal', est: 'live' },
  { key: 'whales', name: 'Whale Movement Digest', desc: 'All transfers ≥ $100K with counterparties', est: 'live' },
  { key: 'entities', name: 'Casino Leaderboard', desc: 'Volume, trust, reserves & net-flow per casino', est: 'live' },
  { key: 'flow', name: 'Segment Distribution', desc: 'Counterparties bucketed by transfer size', est: 'live' },
] as const

function toCsv(rows: any[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  const esc = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function Reports() {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, number>>({})
  const [fmt, setFmt] = useState<Format>('csv')

  async function generate(key: string) {
    setBusy(key)
    try {
      let rows: any[] = []
      if (key === 'transfers') rows = await api.transfers({ limit: 300 })
      else if (key === 'whales') rows = await api.transfers({ min: 100_000, limit: 300 })
      else if (key === 'entities') rows = await api.casinos('casino')
      else if (key === 'flow') rows = await api.flow('casino')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const fname = `wcoin_${key}_${stamp}.${fmt}`
      if (fmt === 'csv') download(fname, toCsv(rows), 'text/csv')
      else download(fname, JSON.stringify(rows, null, 2), 'application/json')
      setDone((d) => ({ ...d, [key]: rows.length }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fade-up">
      <PageHead
        title="Reports & Export"
        subtitle="Generate and download reports built from live on-chain data"
        right={
          <div className="flex items-center gap-1 rounded-xl border border-white/8 bg-white/4 p-1 text-sm">
            {(['csv', 'json'] as Format[]).map((f) => (
              <button key={f} onClick={() => setFmt(f)} className={`rounded-lg px-3 py-1.5 font-semibold uppercase transition ${fmt === f ? 'bg-gold-500/15 text-gold-400' : 'text-white/50 hover:text-white'}`}>
                {f}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TEMPLATES.map((t) => {
          const isBusy = busy === t.key
          const count = done[t.key]
          return (
            <Card key={t.key} hover className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-violet-500/15 text-violet-300"><FileBarChart size={20} /></div>
                <div className="flex-1">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-[13px] text-white/45">{t.desc}</div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <span className="inline-flex items-center gap-1 text-[12px] text-white/40">
                  <Clock size={12} /> {count != null ? `${count} rows exported` : 'pulls live data'}
                </span>
                <button onClick={() => generate(t.key)} disabled={isBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-white/6 px-3.5 py-2 text-[13px] font-semibold text-white/85 hover:bg-gold-500/15 hover:text-gold-400 disabled:opacity-60">
                  {isBusy ? <><Loader2 size={14} className="animate-spin" /> Building…</> : count != null ? <><CheckCircle2 size={14} className="text-mint-400" /> Download again</> : <><Download size={14} /> Generate {fmt.toUpperCase()}</>}
                </button>
              </div>
            </Card>
          )
        })}
      </div>

    </div>
  )
}
