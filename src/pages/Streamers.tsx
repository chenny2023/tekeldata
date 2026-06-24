import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Users, Radio, ExternalLink, Plus, Loader2, X, Send, MessageCircle, Youtube, Instagram, Twitter } from 'lucide-react'
import { Card, PageHead, Bubble, EmptyState, Skeleton } from '../components/ui'
import { Reveal, CountUp, LiveValue } from '../components/motion'
import { api, usePoll, getToken, StreamerRow } from '../data/api'
import { fmtNum } from '../data/format'

// streamer detail drawer — curated profile (bio + socials) joined with live status
function StreamerDetailModal({ platform, slug, onClose }: { platform: string; slug: string; onClose: () => void }) {
  const { data } = usePoll(() => api.streamer(platform, slug), 30_000, [platform, slug])
  const p = data?.profile
  const live = data?.live
  const name = p?.name ?? live?.handle ?? slug
  const followers = p?.followers ?? live?.followers ?? 0
  const url = CHANNEL_URL[platform]?.(slug) ?? '#'
  const strip = (v: string) => v.replace(/^@/, '').replace(/^https?:\/\//, '')
  const socials: { label: string; icon: JSX.Element; val: string | null | undefined; href: (v: string) => string }[] = [
    { label: 'Twitter / X', icon: <Twitter size={14} />, val: p?.twitter, href: (v) => `https://x.com/${strip(v)}` },
    { label: 'YouTube', icon: <Youtube size={14} />, val: p?.youtube, href: (v) => (v.startsWith('http') ? v : `https://${strip(v)}`) },
    { label: 'Discord', icon: <MessageCircle size={14} />, val: p?.discord, href: (v) => (v.startsWith('http') ? v : `https://${strip(v)}`) },
    { label: 'Telegram', icon: <Send size={14} />, val: p?.telegram, href: (v) => `https://t.me/${strip(v)}` },
    { label: 'Instagram', icon: <Instagram size={14} />, val: p?.instagram, href: (v) => `https://instagram.com/${strip(v)}` },
  ]
  const present = socials.filter((s) => s.val)
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-lg p-0" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <div className="relative">
          {live?.live === 1 && live.thumbnail ? (
            <img src={live.thumbnail} alt={name} className="h-40 w-full rounded-t-2xl object-cover" />
          ) : (
            <div className="grid h-28 w-full place-items-center rounded-t-2xl bg-ink-800"><Bubble seed={name} size={56} /></div>
          )}
          <button onClick={onClose} className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg bg-black/50 text-white/70 hover:text-white"><X size={16} /></button>
          {live?.live === 1 && <span className="absolute left-3 top-3 rounded-md bg-rose-500/90 px-1.5 py-0.5 text-[11px] font-bold text-white">● LIVE · {fmtNum(live.viewers)}</span>}
        </div>
        <div className="p-5">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-xl font-bold">{name}</h3>
            <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold" style={{ background: `${PLATFORM_COLOR[platform]}22`, color: PLATFORM_COLOR[platform] }}>{platform}</span>
            <a href={url} target="_blank" rel="noreferrer" className="ml-auto text-white/40 hover:text-gold-400"><ExternalLink size={16} /></a>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-white/50">
            <span>{fmtNum(followers)} followers</span>
            {p?.content && <span>· {p.content}</span>}
            {p?.language && <span>· {p.language}</span>}
            {live?.affiliation && <span className="rounded-md bg-gold-500/12 px-1.5 py-0.5 font-semibold text-gold-400">reps {live.affiliation}</span>}
          </div>
          {p?.bio && <p className="mt-3 text-[13px] leading-relaxed text-white/65">{p.bio}</p>}
          {present.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] uppercase tracking-wider text-white/35">Socials</div>
              <div className="flex flex-wrap gap-2">
                {present.map((s) => (
                  <a key={s.label} href={s.href(s.val as string)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/4 px-2.5 py-1.5 text-[12px] text-white/75 hover:border-white/20 hover:text-white">
                    {s.icon} {s.val}
                  </a>
                ))}
              </div>
            </div>
          )}
          {!p && <p className="mt-3 text-[12px] text-white/35">No curated profile yet — showing live stats only.</p>}
        </div>
      </Card>
    </div>
  )
}

const PLATFORM_COLOR: Record<string, string> = {
  Twitch: '#9146FF',
  Kick: '#53FC18',
  YouTube: '#FF0000',
}
const CHANNEL_URL: Record<string, (h: string) => string> = {
  Twitch: (h) => `https://twitch.tv/${h}`,
  Kick: (h) => `https://kick.com/${h}`,
  YouTube: (h) => `https://youtube.com/@${h}`,
}

function StreamerCard({ s, onOpen }: { s: StreamerRow; onOpen: () => void }) {
  return (
    <Card hover onClick={onOpen} className="cursor-pointer overflow-hidden p-0">
      {s.live === 1 && s.thumbnail ? (
        <div className="relative h-36 w-full overflow-hidden bg-ink-800">
          <img src={s.thumbnail} alt={s.handle} className="h-full w-full object-cover" loading="lazy" />
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-rose-500/90 px-1.5 py-0.5 text-[11px] font-bold text-white">● LIVE</span>
          <span className="absolute right-2 top-2 inline-flex items-center gap-0.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white"><LiveValue value={s.viewers} format={fmtNum} /> 👁</span>
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
          <a href={CHANNEL_URL[s.platform]?.(s.handle)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-auto text-white/40 hover:text-gold-400"><ExternalLink size={14} /></a>
        </div>
        {s.title && <p className="mt-2 line-clamp-2 text-[12px] text-white/45">{s.title}</p>}
        <div className="mt-2 flex items-center justify-between text-[12px]">
          <span className="text-white/40">{fmtNum(s.followers)} followers</span>
          {s.live === 1 && <span className="font-semibold text-mint-400"><LiveValue value={s.viewers} format={fmtNum} /> viewers</span>}
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
  const { data: spon } = usePoll(api.sponsorships, 60_000)
  const [q, setQ] = useState('')
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ platform: string; slug: string } | null>(null)
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
        subtitle="Real live status, viewers & casino affiliations — Kick + Twitch + YouTube, all keyless"
        right={
          <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-sm">
            <Search size={15} className="text-white/40" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search handle…" className="w-36 bg-transparent placeholder:text-white/30 focus:outline-none" />
          </div>
        }
      />

      <Reveal as="div" className="grid grid-cols-3 gap-3">
        <Card spotlight className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Live Now</div>
          <div className="mt-1 font-display text-2xl font-bold text-rose-400"><CountUp value={live.length} /></div>
        </Card>
        <Card spotlight className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Combined Viewers</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold"><Users size={18} className="text-mint-400" /><LiveValue value={totalViewers} format={fmtNum} /></div>
        </Card>
        <Card spotlight className="p-4">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Roster Tracked</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold"><Radio size={18} className="text-violet-400" /><CountUp value={data?.roster ?? 0} /></div>
        </Card>
      </Reveal>

      {/* sponsorship graph — which casino each streamer reps, by combined reach */}
      {spon && spon.sponsorships.length > 0 && (
        <Card spotlight className="mt-4 p-5">
          <div className="mb-3 flex items-center gap-2">
            <Users size={18} className="text-gold-400" />
            <h3 className="font-display text-lg font-bold">Sponsorship Graph</h3>
            <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-white/50">casino → streamer reach</span>
          </div>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {spon.sponsorships.slice(0, 12).map((s) => (
              <div key={s.casino} className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold text-gold-400">{s.casino}</span>
                    {s.liveNow > 0 && <span className="rounded bg-rose-500/20 px-1 text-[9px] font-bold text-rose-400">● {s.liveNow} LIVE</span>}
                  </div>
                  <div className="truncate text-[11px] text-white/40">{s.streamersList.map((m) => m.handle).slice(0, 4).join(', ')}{s.streamers > 4 ? ` +${s.streamers - 4}` : ''}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[13px] font-bold tabular-nums">{fmtNum(s.reach)}</div>
                  <div className="text-[10px] text-white/35">{s.streamers} streamers</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* roster add */}
      <Card className="mt-4 p-4">
        <form onSubmit={addStreamer} className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-white/70">Track a Kick channel:</span>
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-sm">
            <span className="text-white/35">kick.com/</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="channel" className="w-32 bg-transparent placeholder:text-white/30 focus:outline-none" />
          </div>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-4 py-2 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Track
          </button>
          {msg && <span className="text-[12px] text-mint-400">{msg}</span>}
        </form>
      </Card>

      <div className="mt-4">
        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}</div>
        ) : all.length === 0 ? (
          <Card className="p-8"><EmptyState icon={<Radio size={34} />} title="Roster is warming up" hint="The Kick collector polls one channel every 8 seconds — first data lands within a minute of boot." /></Card>
        ) : (
          <Reveal as="div" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {all.map((s) => <StreamerCard key={s.id} s={s} onOpen={() => setSelected({ platform: s.platform, slug: s.id.includes(':') ? s.id.split(':')[1] : s.handle })} />)}
          </Reveal>
        )}
      </div>
      <p className="mt-3 text-[12px] text-white/35">
        Kick, Twitch & YouTube data is collected keyless from public sources. Click any streamer for their profile,
        socials and casino affiliation. Affiliations are detected from stream titles/bios against watchlist casino labels.
      </p>
      {selected && <StreamerDetailModal platform={selected.platform} slug={selected.slug} onClose={() => setSelected(null)} />}
    </div>
  )
}
