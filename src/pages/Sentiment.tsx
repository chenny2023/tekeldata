import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ThumbsUp, ThumbsDown, ShieldCheck, MessageSquare } from 'lucide-react'
import { Card, PageHead, Bubble, TrustBadge, Delta, ChainPill, CategoryBadge, Skeleton } from '../components/ui'
import { api, usePoll, getToken } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

export default function Sentiment() {
  const { data, loading } = usePoll(api.sentiment, 15_000)
  const [pending, setPending] = useState<number | null>(null)
  const [localVotes, setLocalVotes] = useState<Record<number, number>>({})
  const loggedIn = !!getToken()

  const rows = (data?.entities ?? []).slice().sort((a, b) => b.trust - a.trust)
  const avg = rows.length ? Math.round(rows.reduce((a, s) => a + s.trust, 0) / rows.length) : 0
  const totalReserves = rows.reduce((a, s) => a + s.reserves, 0)
  const totalMentions = rows.reduce((a, s) => a + s.mentions7d, 0)
  const top = rows[0]

  async function cast(watchId: number, vote: 1 | -1) {
    if (!loggedIn) return
    setPending(watchId)
    try {
      await api.vote(watchId, vote)
      setLocalVotes((v) => ({ ...v, [watchId]: vote }))
    } catch {
      /* surface-level: ignore, next poll refreshes */
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="fade-up">
      <PageHead
        title="Sentiment & Trust"
        subtitle="On-chain trust signals blended with real community votes and social mentions"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Avg Trust Score</div>
          <div className="mt-1 font-display text-3xl font-bold text-gradient-gold">{avg}</div>
        </Card>
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Top Rated</div>
          <div className="mt-1 truncate font-display text-xl font-bold">{top?.label ?? '—'}</div>
          {top && <div className="mt-1"><TrustBadge score={top.trust} /></div>}
        </Card>
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">On-chain Reserves</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <ShieldCheck size={20} className="text-mint-400" />{fmtUsd(totalReserves)}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Mentions · 7d</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <MessageSquare size={20} className="text-violet-400" />
            {data?.redditEnabled ? fmtNum(totalMentions) : <span className="text-white/35 text-base">source off</span>}
          </div>
        </Card>
      </div>

      {!loggedIn && (
        <div className="mt-3 rounded-xl border border-gold-500/25 bg-gold-500/8 px-4 py-2.5 text-[13px] text-gold-400">
          <Link to="/login" className="font-semibold underline">Sign in</Link> to cast community trust votes — votes feed directly into the blended trust score.
        </div>
      )}

      <Card className="mt-4 overflow-hidden">
        {loading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-sm">
              <thead>
                <tr className="border-b border-white/8 text-left text-[12px] uppercase tracking-wider text-white/40">
                  <th className="px-4 py-3 font-medium">Entity</th>
                  <th className="px-4 py-3 font-medium">Trust (blended)</th>
                  <th className="px-4 py-3 font-medium">On-chain</th>
                  <th className="px-4 py-3 font-medium">Community</th>
                  <th className="px-4 py-3 font-medium">Mentions 7d</th>
                  <th className="px-4 py-3 font-medium">24h</th>
                  <th className="px-4 py-3 font-medium w-[22%]">Flow balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const total = s.inflow7d + s.outflow7d || 1
                  const inPct = (s.inflow7d / total) * 100
                  const myVote = localVotes[s.id] ?? s.myVote
                  return (
                    <tr key={s.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Bubble seed={s.label} size={30} />
                          <div>
                            <div className="flex items-center gap-1.5"><span className="font-medium">{s.label}</span><CategoryBadge category={s.category} /></div>
                            <div className="mt-0.5"><ChainPill chain={s.chain} /></div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><TrustBadge score={s.trust} /></td>
                      <td className="px-4 py-3 tabular-nums text-white/55">{s.onchainTrust}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => cast(s.id, 1)}
                            disabled={!loggedIn || pending === s.id}
                            title={loggedIn ? 'Vote trust' : 'Sign in to vote'}
                            className={`grid h-7 w-7 place-items-center rounded-md transition ${myVote === 1 ? 'bg-mint-400/20 text-mint-400' : 'bg-white/5 text-white/40 hover:text-mint-400'} disabled:cursor-not-allowed`}
                          >
                            <ThumbsUp size={13} />
                          </button>
                          <span className="min-w-7 text-center text-[12px] tabular-nums text-white/60">
                            {s.votesUp + (myVote === 1 && s.myVote !== 1 ? 1 : 0)}/{s.votesDown + (myVote === -1 && s.myVote !== -1 ? 1 : 0)}
                          </span>
                          <button
                            onClick={() => cast(s.id, -1)}
                            disabled={!loggedIn || pending === s.id}
                            title={loggedIn ? 'Vote distrust' : 'Sign in to vote'}
                            className={`grid h-7 w-7 place-items-center rounded-md transition ${myVote === -1 ? 'bg-rose-400/20 text-rose-400' : 'bg-white/5 text-white/40 hover:text-rose-400'} disabled:cursor-not-allowed`}
                          >
                            <ThumbsDown size={13} />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {data?.redditEnabled ? (
                          <span className="tabular-nums text-white/70">
                            {fmtNum(s.mentions7d)}
                            {s.mentions7d > 0 && (
                              <span className="ml-1.5 text-[11px]">
                                <span className="text-mint-400">+{s.mentionsPos}</span>{' / '}
                                <span className="text-rose-400">−{s.mentionsNeg}</span>
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[12px] text-white/30">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3"><Delta value={s.change24h} /></td>
                      <td className="px-4 py-3">
                        <div className="flex h-2.5 overflow-hidden rounded-full">
                          <div style={{ width: `${inPct}%`, background: '#2ee6a6' }} />
                          <div style={{ width: `${100 - inPct}%`, background: '#f5b100' }} />
                        </div>
                        <div className="mt-1 flex justify-between text-[11px] text-white/40">
                          <span className="text-mint-400">in {fmtUsd(s.inflow7d)}</span>
                          <span className="text-gold-400">out {fmtUsd(s.outflow7d)}</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-white/35">
        Blended trust = on-chain heuristic (reserve coverage, flow balance, track record, depth)
        weighted with real community votes (up to 30%, scaled by sample size).
        {!data?.redditEnabled && ' Social mentions need free Reddit API credentials in .env (REDDIT_CLIENT_ID / SECRET).'}
      </p>
    </div>
  )
}
