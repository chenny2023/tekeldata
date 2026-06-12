import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Users, Radio, ExternalLink, Plus, Loader2 } from 'lucide-react'
import { Card, PageHead, Bubble, EmptyState, Skeleton } from '../components/ui'
import { api, usePoll, getToken, StreamerRow } from '../data/api'
import { fmtNum } from '../data/format'

const PLATFORM_COLOR: Record<string, string> = {
  Twitch: '#9146FF',
  Kick: '#53FC18',
}
const CHANNEL_URL: Record<string, (h: string) => string> = {
  Twitch: (h) => `https://twitch.tv/${h}`,
  Kick: (h) => `https://kick.com/${h}`,
}

function StreamerCard({ s }: { s: StreamerRow }) {
  return (
    <Card hover className="overflow-hidden p-0">
      {s.live === 1 && s.thumbnail ? (
        <div className="relative h-36 w-full overflow-hidden bg-ink-800">
          <img src={s.thumbnail} alt={s.handle} className="h-full w-full object-cover" loading="lazy" />
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-rose-500/90 px-1.5 py-0.5 text-[11px] font-bold text-white">● LIVE</span>
          <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">{fmtNum(s.viewers)} 👁</span>
        </div>
      ) : (
        <div className="relative grid h-24 w-full place-items-center bg-ink-800">
          <Bubble seed={s.handle} size={44} />
          {s.live === 0 && <span className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white/50">offline</span>}
        </div>
      )}
      <div className="p-4">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{s.handle}</span>
          <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold" style={{ background: `${PLATFORM_COLOR[s.platform]}22`, color: PLATFORM_COLOR[s.platform] }}>
            {s.platform}
          </span>
          <a href={CHANNEL_URL[s.platform]?.(s.handle)} target="_blank" rel="noreferrer" className="ml-auto text-white/40 hover:text-gold-400"><ExternalLink size={14} /></a>
        </div>
        {s.title && <p className="mt-2 line-clamp-2 text-[12px] text-white/45">{s.title}</p>}
        <div className="mt-2 flex items-center justify-between text-[12px]">
          <span className="text-white/40">{fmtNum(s.followers)} followers</span>
          {s.live === 1 && <span className="font-semibold text-mint-400">{fmtNum(s.viewers)} viewers</span>}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-white/6 pt-2 text-[12px]">
          <span className="text-white/40">Affiliation</span>
          {s.affiliation ? (
            <span className="rounded-md bg-gold-500/12 px-1.5 py-0.5 font-semibold text-gold-400">{s.affiliation}</span>
          ) : (
            <span className="text-white/30">not detected</span>
          )}
        </div>
      </div>
    </Card>
  )
}

export default function Streamers() {
  const { data, loading } = usePoll(api.streamers, 20_000)
  const [q, setQ] = useState('')
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const loggedIn = !!getToken()

  const live = data?.streamers ?? []
  const offline = data?.offline ?? []
  const all = useMemo(
    () => [...live, ...offline].filter((s) => s.handle.toLowerCase().includes(q.toLowerCase())),
    [live, offline, q],
  )
  const totalViewers = live.reduce((a, s) => a + s.viewers, 0)

  async function addStreamer(e: React.FormEvent) {
    e.preventDefault()
    if (!slug.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      await api.addRoster({ platform: 'Kick', slug: slug.trim() })
      setMsg(`Tracking kick.com/${slug.trim()} — data appears within ~1 min`)
      setSlug('')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fade-up">
      <PageHead
        title="Streamer Monitoring"
        subtitle="Real live status, viewers & casino affiliations — Kick (keyless) + Twitch (optional)"
        right={
          <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm">
            <Search size={15} className="text-white/40" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search handle…" className="w-36 bg-transparent placeholder:text-white/30 focus:outline-none" />
          </div>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Live Now</div>
          <div className="mt-1 font-display text-2xl font-bold text-rose-400">{live.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Combined Viewers</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold"><Users size={18} className="text-mint-400" />{fmtNum(totalViewers)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Roster Tracked</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold"><Radio size={18} className="text-violet-400" />{data?.roster ?? 0}</div>
        </Card>
      </div>

      {/* roster add */}
      <Card className="mt-4 p-4">
        <form onSubmit={addStreamer} className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-white/70">Track a Kick channel:</span>
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-sm">
            <span className="text-white/35">kick.com/</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="channel" className="w-32 bg-transparent placeholder:text-white/30 focus:outline-none" />
          </div>
          <button type="submit" disabled={busy || !loggedIn} className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-4 py-2 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Track
          </button>
          {!loggedIn && (
            <span className="text-[12px] text-white/40"><Link to="/login" className="text-gold-400 underline">Sign in</Link> to add channels</span>
          )}
          {msg && <span className="text-[12px] text-mint-400">{msg}</span>}
        </form>
      </Card>

      <div className="mt-4">
        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}</div>
        ) : all.length === 0 ? (
          <Card className="p-8"><EmptyState icon={<Radio size={34} />} title="Roster is warming up" hint="The Kick collector polls one channel every 8 seconds — first data lands within a minute of boot." /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {all.map((s) => <StreamerCard key={s.id} s={s} />)}
          </div>
        )}
      </div>
      <p className="mt-3 text-[12px] text-white/35">
        Kick data is collected keyless from the public channel API. Add Twitch credentials in .env to also index
        the Twitch slots category. Affiliations are detected from stream titles/bios against watchlist casino labels.
      </p>
    </div>
  )
}
