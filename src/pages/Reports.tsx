import { useState } from 'react'
import { FileBarChart, Download, Clock, CheckCircle2, Loader2 } from 'lucide-react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { Card, PageHead } from '../components/ui'
import { Reveal } from '../components/motion'
import { api } from '../data/api'

type Format = 'csv' | 'json' | 'pdf'

// Branded PDF export: a Tekel Data header, a diagonal "tekeldata.com" watermark on
// every page, a data table (scalar columns only, so nested objects don't clutter it),
// and a methodology footer. Built client-side so the server stays light.
function brandedPdf(title: string, rows: any[]): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  // keep scalar columns only — drop byChain/meta/token/risk objects for a clean table
  const keys = rows.length ? Object.keys(rows[0]) : []
  const cols = keys.filter((k) => rows.every((r) => r[k] == null || typeof r[k] !== 'object'))
  const body = rows.map((r) =>
    cols.map((c) => {
      const v = r[c]
      const s = v == null ? '' : String(v)
      return s.length > 42 ? s.slice(0, 40) + '…' : s
    }),
  )
  const stampUtc = new Date().toUTCString()
  autoTable(doc, {
    head: [cols],
    body,
    startY: 72,
    margin: { top: 66, bottom: 46, left: 28, right: 28 },
    styles: { fontSize: 7, cellPadding: 3, overflow: 'ellipsize', textColor: [38, 38, 46], lineColor: [225, 225, 230], lineWidth: 0.4 },
    headStyles: { fillColor: [17, 17, 24], textColor: [242, 194, 0], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 248, 250] },
    didDrawPage: (data) => {
      // faint diagonal watermark across the whole page (over content, low opacity)
      const g: any = doc as any
      g.saveGraphicsState?.()
      if (g.GState) g.setGState(new g.GState({ opacity: 0.06 }))
      doc.setTextColor(120, 120, 130)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(38)
      for (let y = 130; y < H; y += 170) for (let x = -10; x < W; x += 290) doc.text('tekeldata.com', x, y, { angle: 28 })
      g.restoreGraphicsState?.()
      // header
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(15)
      doc.setTextColor(242, 194, 0)
      doc.text('Tekel Data', 28, 34)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(11)
      doc.setTextColor(55, 55, 64)
      doc.text(title, 28, 52)
      doc.setFontSize(8)
      doc.setTextColor(130, 130, 140)
      doc.text(`Generated ${stampUtc} · ${rows.length} rows · tekeldata.com`, W - 28, 34, { align: 'right' })
      // footer
      doc.setFontSize(7)
      doc.setTextColor(130, 130, 140)
      doc.text('Observed on-chain & third-party data — not financial advice, not a verdict on any operator. © Tekel Data', 28, H - 18)
      doc.text(`Page ${data.pageNumber}`, W - 28, H - 18, { align: 'right' })
    },
  })
  return doc
}

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
  const [fmt, setFmt] = useState<Format>('pdf')

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
      else if (fmt === 'json') download(fname, JSON.stringify(rows, null, 2), 'application/json')
      else {
        const title = TEMPLATES.find((t) => t.key === key)?.name ?? 'Report'
        brandedPdf(title, rows).save(fname)
      }
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
            {(['pdf', 'csv', 'json'] as Format[]).map((f) => (
              <button key={f} onClick={() => setFmt(f)} className={`rounded-lg px-3 py-1.5 font-semibold uppercase transition ${fmt === f ? 'bg-gold-500/15 text-gold-400' : 'text-white/50 hover:text-white'}`}>
                {f}
              </button>
            ))}
          </div>
        }
      />

      <Reveal as="div" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TEMPLATES.map((t) => {
          const isBusy = busy === t.key
          const count = done[t.key]
          return (
            <Card key={t.key} spotlight hover className="flex flex-col p-5">
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
      </Reveal>

    </div>
  )
}
