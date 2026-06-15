import { useState } from 'react'
import { Search, Download, ExternalLink, Check, X as XIcon, Loader2 } from 'lucide-react'
import { Card, PageHead, Skeleton } from '../components/ui'
import { api, usePoll, downloadDirectoryCsv } from '../data/api'

const FILTERS: { k: string; label: string }[] = [
  { k: '', label: 'All' },
  { k: 'live', label: 'Site live' },
  { k: 'withX', label: 'Has X' },
  { k: 'withEmail', label: 'Has email' },
  { k: 'included', label: 'Site + X + Email' },
]

function Flag({ ok }: { ok: number }) {
  return ok ? <Check size={14} className="text-mint-400" /> : <XIcon size={14} className="text-white/20" />
}

export default function Directory() {
  const [filter, setFilter] = useState('')
  const [q, setQ] = useState('')
  const { data, loading } = usePoll(() => api.directory(filter || undefined, q || undefined), 30_000, [filter, q])
  const [busy, setBusy] = useState(false)
  const s = data?.stats
  const rows = data?.rows ?? []

  async function exportCsv() {
    setBusy(true)
    try {
      await downloadDirectoryCsv(filter || 'live')
    } catch {
      /* ignore */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fade-up">
      <PageHead
        title="Casino Directory"
        subtitle="A vetted catalogue of casinos — site reachability, X account and a real contact email — built for partnership outreach"
        right={
          <button
            onClick={exportCsv}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-4 py-2 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            Export CSV
          </button>
        }
      />

      {/* stat tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Total', s?.total],
          ['Checked', s?.checked],
          ['Site live', s?.site],
          ['Has X', s?.x],
          ['Has email', s?.email],
          ['All 3 ✓', s?.included],
        ].map(([label, v]) => (
          <Card key={label as string} className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wider text-white/40">{label as string}</div>
            <div className="mt-0.5 text-xl font-bold tabular-nums">{v == null ? '—' : (v as number).toLocaleString()}</div>
          </Card>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`rounded-lg px-2.5 py-1 text-[13px] font-medium transition ${filter === f.k ? 'bg-gold-500/15 text-gold-400 ring-1 ring-gold-500/30' : 'text-white/50 hover:bg-white/5'}`}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2">
          <Search size={15} className="text-white/40" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / domain…" className="w-40 bg-transparent placeholder:text-white/30 focus:outline-none" />
        </div>
      </div>

      <Card className="overflow-hidden">
        {loading && !data ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-white/8 text-left text-[12px] uppercase tracking-wider text-white/40">
                  <th className="px-4 py-3 font-medium">Casino</th>
                  <th className="px-4 py-3 font-medium">Website</th>
                  <th className="px-4 py-3 text-center font-medium">Site</th>
                  <th className="px-4 py-3 font-medium">X</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-sm text-white/40">
                      {loading ? 'Loading…' : 'No casinos yet — the crawler is still vetting sites (this fills in over time).'}
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.domain} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5">
                      <a href={r.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-white/60 hover:text-gold-400">
                        {r.domain} <ExternalLink size={11} />
                      </a>
                    </td>
                    <td className="px-4 py-2.5 text-center" title={r.status ?? ''}>
                      <span className="inline-flex"><Flag ok={r.site_ok} /></span>
                    </td>
                    <td className="px-4 py-2.5">
                      {r.twitter ? (
                        <a href={`https://x.com/${r.twitter}`} target="_blank" rel="noreferrer" className="text-mint-400 hover:underline">@{r.twitter}</a>
                      ) : (
                        <Flag ok={0} />
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.email ? (
                        <span className={r.email_ok ? 'text-mint-400' : 'text-white/45'} title={r.email_ok ? 'MX-valid' : 'no MX record'}>{r.email}</span>
                      ) : (
                        <Flag ok={0} />
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-white/40">{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-white/35">
        Tiered inclusion — every casino is listed; the flags show which have a reachable site, an X account and a real
        (MX-validated) email. Export filters to the rows you want for outreach.
      </p>
    </div>
  )
}
