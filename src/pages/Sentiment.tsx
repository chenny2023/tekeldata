import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ThumbsUp, ThumbsDown, ShieldCheck, MessageSquare, Landmark, ExternalLink } from 'lucide-react'
import { Card, PageHead, Bubble, TrustBadge, Delta, ChainPill, CategoryBadge, Skeleton } from '../components/ui'
import { Reveal, CountUp } from '../components/motion'
import { api, usePoll, getToken } from '../data/api'
import { fmtUsd, fmtNum } from '../data/format'

export default function Sentiment() {
  const { data, loading } = usePoll(api.sentiment, 15_000)
  const { data: ark } = usePoll(api.arkhamReserves, 60_000)
  const [pending, setPending] = useState<number | null>(null)
  const [localVotes, setLocalVotes] = useState<Record<number, number>>({})
  const loggedIn = !!getToken()

  const rows = (data?.entities ?? []).slice().sort((a, b) => (b.trust ?? -1) - (a.trust ?? -1))
  const rated = rows.filter((s) => s.trust != null)
  const avg = rated.length ? Math.round(rated.reduce((a, s) => a + (s.trust ?? 0), 0) / rated.length) : 0
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

      <Reveal as="div" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card spotlight className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Avg Trust Score</div>
          <div className="mt-1 font-display text-3xl font-bold text-gradient-gold"><CountUp value={avg} /></div>
        </Card>
        <Card spotlight className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Top Rated</div>
          <div className="mt-1 truncate font-display text-xl font-bold">{top?.label ?? '—'}</div>
          {top && <div className="mt-1"><TrustBadge score={top.trust} /></div>}
        </Card>
        <Card spotlight className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">On-chain Reserves</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <ShieldCheck size={20} className="text-mint-400" /><CountUp value={totalReserves} format={fmtUsd} />
          </div>
        </Card>
        <Card spotlight className="p-5">
          <div className="text-[12px] uppercase tracking-wider text-white/45">Mentions · 7d</div>
          <div className="mt-1 flex items-center gap-2 font-display text-2xl font-bold">
            <MessageSquare size={20} className="text-violet-400" />
            <CountUp value={totalMentions} format={fmtNum} />
          </div>
          {data?.mentionsBySource && (
            <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-white/40">
              {Object.entries(data.mentionsBySource).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
                <span key={src}>{src} <span className="text-white/65">{fmtNum(n)}</span></span>
              ))}
            </div>
          )}
        </Card>
      </Reveal>


      <Card spotlight className="mt-4 overflow-hidden">
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
                  <th className="px-4 py-3 font-medium" title="casino.guru third-party Safety Index">Safety ·guru</th>
                  <th className="px-4 py-3 font-medium" title="Trustpilot rating (archived)">Trustpilot</th>
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
                            <div className="mt-0.5 flex items-center gap-1.5">
                              <ChainPill chain={s.chain} />
                              {s.chains && s.chains.length > 1 && (
                                <span className="text-[10px] text-white/35" title={s.chains.join(', ')}>+{s.chains.length - 1} chain{s.chains.length - 1 > 1 ? 's' : ''}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><TrustBadge score={s.trust} /></td>
                      <td className="px-4 py-3 tabular-nums text-white/55">{s.onchainTrust}</td>
                      <td className="px-4 py-3">
                        {s.safetyIndex != null ? (
                          <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[12px] font-bold tabular-nums ${s.safetyIndex >= 8 ? 'bg-mint-400/12 text-mint-400' : s.safetyIndex >= 5 ? 'bg-gold-500/12 text-gold-400' : 'bg-rose-400/12 text-rose-400'}`}>{s.safetyIndex.toFixed(1)}</span>
                        ) : (
                          <span className="text-white/25">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {s.trustpilot != null ? (
                          <span className={`tabular-nums text-[13px] font-semibold ${s.trustpilot >= 3.5 ? 'text-mint-400' : s.trustpilot >= 2.5 ? 'text-gold-400' : 'text-rose-400'}`}>★{s.trustpilot.toFixed(1)}</span>
                        ) : (
                          <span className="text-white/25">—</span>
                        )}
                      </td>
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
                        {data?.redditEnabled || data?.newsEnabled ? (
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

      {/* All-chain proof-of-reserves via Arkham — broad roster coverage across every chain */}
      {ark && ark.casinos.length > 0 && (
        <Card spotlight className="mt-4 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Landmark size={18} className="text-mint-400" />
              <h3 className="font-display text-lg font-bold">All-Chain Reserves</h3>
              <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] font-medium text-white/50">via Arkham</span>
            </div>
            <div className="text-[13px] text-white/55">
              <span className="font-display text-xl font-bold text-gradient-gold"><CountUp value={ark.totalUsd} format={fmtUsd} /></span>
              <span className="ml-1.5">across {ark.count} casinos · every chain</span>
              {ark.totalVolume7d > 0 && (
                <span className="ml-1.5 text-white/40">· <span className="font-semibold text-violet-300">{fmtUsd(ark.totalVolume7d)}</span> 7d volume</span>
              )}
            </div>
          </div>
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {ark.casinos.slice(0, 24).map((c, i) => {
              const pct = ark.casinos[0].reservesUsd > 0 ? (c.reservesUsd / ark.casinos[0].reservesUsd) * 100 : 0
              return (
                <div key={c.entityId} className="flex items-center gap-3 py-1">
                  <span className="w-5 text-right text-[12px] tabular-nums text-white/30">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <a
                        href={c.domain ? `https://${c.domain}` : undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 truncate text-[13px] font-medium hover:text-gold-400"
                      >
                        {c.name}
                        {c.domain && <ExternalLink size={10} className="shrink-0 text-white/30" />}
                      </a>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {c.solvencyAlert && <span title="≥30% weekly reserve drawdown" className="rounded bg-rose-400/15 px-1 text-[10px] font-bold text-rose-400">⚠ DRAIN</span>}
                        {c.change7d != null && Math.abs(c.change7d) >= 0.01 && (
                          <span className={`text-[11px] tabular-nums ${c.change7d >= 0 ? 'text-mint-400/70' : 'text-rose-400'}`}>
                            {c.change7d >= 0 ? '▲' : '▼'}{Math.abs(c.change7d * 100).toFixed(0)}%
                          </span>
                        )}
                        <span className="text-[13px] font-semibold tabular-nums text-mint-400">{fmtUsd(c.reservesUsd)}</span>
                        {c.volume7dUsd != null && c.volume7dUsd > 0 && (
                          <span title="Arkham-attributed cross-chain volume, trailing 7d (a floor for the largest)" className="w-16 text-right text-[11px] tabular-nums text-violet-300/80">{fmtUsd(c.volume7dUsd)}</span>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/6">
                      <div className="h-full rounded-full bg-gradient-to-r from-mint-400/70 to-mint-400" style={{ width: `${Math.max(pct, 1.5)}%` }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-[12px] text-white/35">
            Live on-chain balances aggregated across every chain (Bitcoin, Tron, all EVM networks…) from Arkham entity
            attribution — mainstream assets only. A transparent, cross-chain proof-of-reserves the casinos can't cherry-pick.
          </p>
        </Card>
      )}

      <p className="mt-3 text-[12px] text-white/35">
        Blended trust = on-chain heuristic (reserve coverage, flow balance, track record, depth)
        weighted with real community votes (up to 30%, scaled by sample size).
        {data?.newsEnabled && ' Mentions come from live Google News coverage.'}
        {!data?.redditEnabled && ' Add free Reddit API credentials in .env (REDDIT_CLIENT_ID / SECRET) to include community posts.'}
      </p>
    </div>
  )
}
