// Daily INTERNAL system-health report — a private operational digest emailed to the
// operator (NOT the public market digest in digest.ts). Answers "did today's content
// update run, and is anything degrading?" in one glance. Six sections (A–F), each with
// a red/amber/green status, plus an overall header. Sent once/day at SEND_HOUR_UTC
// (default 01:00 UTC = 09:00 Beijing), idempotent via a sync_state key. Reuses the
// Resend transport (email.ts) and reads everything IN-PROCESS (no HTTP self-calls).
import type { FastifyInstance } from 'fastify'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, stateGet, stateSet } from './db.ts'
import { sendEmail } from './email.ts'
import { aggregateBrands } from './aggregate.ts'
import { recentRiskEvents } from './riskevents.ts'
import { opCounts24h } from './opmetrics.ts'
import { userFromRequest } from './auth.ts'
import { config } from './config.ts'

const TO = process.env.SYSTEM_REPORT_TO || 'chennywang@live.com'
const SEND_HOUR_UTC = Number(process.env.SYSTEM_REPORT_HOUR_UTC ?? 1) // 01:00 UTC = 09:00 Beijing
const SITE = 'https://tekeldata.com'
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)
const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`)
const fmtNum = (n: number) => (n || 0).toLocaleString('en-US')
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Status = 'ok' | 'warn' | 'bad'
const worst = (a: Status, b: Status): Status => (a === 'bad' || b === 'bad' ? 'bad' : a === 'warn' || b === 'warn' ? 'warn' : 'ok')
const DOT: Record<Status, string> = { ok: '🟢', warn: '🟡', bad: '🔴' }

interface Section { key: string; title: string; status: Status; rows: [string, string][]; note?: string }

// ── data gathering (all in-process, cheap queries + one aggregate pass) ──────────
async function collect() {
  const q1 = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T
  const qa = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[]
  const sv = (k: string) => Number((q1<any>('SELECT value FROM sync_state WHERE key=?', k))?.value ?? 0)

  const today = utcDay()
  const snap = q1<any>('SELECT * FROM daily_market_snapshot WHERE snapshot_date=?', today) || null
  const prevSnap = q1<any>('SELECT * FROM daily_market_snapshot WHERE snapshot_date<? ORDER BY snapshot_date DESC LIMIT 1', today) || null
  const sitemap = (q1<any>("SELECT COUNT(*) n FROM seo_page WHERE lifecycle IN ('public_indexable','featured_core')")).n as number
  const seoFresh = (q1<any>('SELECT MAX(updated_at) t FROM seo_page')).t as number
  const seoByKind = qa<{ kind: string; n: number }>("SELECT kind, COUNT(*) n FROM seo_page WHERE lifecycle IN ('public_indexable','featured_core') GROUP BY kind")
  const transfers = (q1<any>('SELECT MAX(id) n FROM transfers')).n as number
  const oldestTs = (q1<any>('SELECT MIN(ts) t FROM transfers')).t as number | null
  const watchlist = (q1<any>('SELECT COUNT(*) n FROM watchlist WHERE active=1')).n as number
  const anchor = sv('backfill:anchor')
  const casCursor = sv('backfill:cas:cursor') || sv('backfill:cursor') || anchor
  const targetBlocks = Math.ceil((config.deepBackfillDays * 86_400_000) / 12_000)
  const backfillPct = anchor && casCursor < anchor ? Math.min(100, Math.round(((anchor - casCursor) / targetBlocks) * 100)) : anchor ? 100 : 0
  const cov = qa<{ src: string; wallets: number; brands: number }>("SELECT COALESCE(source,'curated') src, COUNT(*) wallets, COUNT(DISTINCT label) brands FROM watchlist WHERE active=1 AND category='casino' GROUP BY src ORDER BY wallets DESC")
  const namedBrands = (q1<any>("SELECT COUNT(DISTINCT label) n FROM watchlist WHERE active=1 AND category='casino' AND label NOT LIKE 'Casino-pattern%' AND label NOT LIKE '0x%' AND label NOT LIKE 'Service %'")).n as number
  const reviewsFresh7d = (q1<any>("SELECT COUNT(DISTINCT brand_key) n FROM reviews WHERE source='casino.guru' AND updated_at > ?", Date.now() - 7 * 86_400_000)).n as number

  const brands = await aggregateBrands('casino')
  const suspect = brands.filter((b) => b.volumeSuspect)
  const withReserves = brands.filter((b) => b.reserves > 0)
  const reservesTotal = withReserves.reduce((s, b) => s + b.reserves, 0)
  const topTrust = brands.filter((b) => b.trust != null).sort((a, b) => (b.trust ?? 0) - (a.trust ?? 0)).slice(0, 5)

  const risk24 = recentRiskEvents(80).filter((e) => (e.observed_at ?? 0) > Date.now() - 86_400_000)
  const ops = opCounts24h()

  let edanicPages = 0
  try {
    const dir = fileURLToPath(new URL('../../content', import.meta.url))
    const walk = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.md') ? 1 : 0), 0)
    edanicPages = walk(dir)
  } catch { /* content dir absent in some builds */ }

  return { today, snap, prevSnap, sitemap, seoFresh, seoByKind, transfers, oldestTs, watchlist, backfillPct, cov, namedBrands, reviewsFresh7d, suspect, reservesTotal, withReserves, topTrust, risk24, ops, edanicPages }
}

// ── section builders ─────────────────────────────────────────────────────────
function buildSections(d: Awaited<ReturnType<typeof collect>>): Section[] {
  const lastSitemap = Number(stateGet('sysreport:last:sitemap') ?? 0)
  const lastTransfers = Number(stateGet('sysreport:last:transfers') ?? 0)
  const historyDays = d.oldestTs ? (Date.now() - d.oldestTs) / 86_400_000 : 0
  const seoAgeMin = d.seoFresh ? Math.round((Date.now() - d.seoFresh) / 60_000) : Infinity
  const sitemapDelta = lastSitemap ? d.sitemap - lastSitemap : 0
  const txDelta = lastTransfers ? d.transfers - lastTransfers : 0

  // A — daily update ran?
  const aStatus: Status = !d.snap ? 'bad' : d.sitemap < 500 ? 'bad' : lastTransfers && txDelta <= 0 ? 'bad' : d.backfillPct < 100 || seoAgeMin > 90 ? 'warn' : 'ok'
  const A: Section = {
    key: 'A', title: '日更状态', status: aStatus,
    rows: [
      ['今日快照', d.snap ? `✓ ${d.today} · vol24h ${fmtUsd(d.snap.tracked_volume_24h || 0)} · ${d.snap.active_casinos} 家 · ${d.snap.active_chains} 链` : `✗ 今日(${d.today})尚无快照`],
      ['Sitemap', `${fmtNum(d.sitemap)} URL${sitemapDelta ? ` (${sitemapDelta > 0 ? '+' : ''}${sitemapDelta} vs 昨日)` : ''}`],
      ['SEO 重建', seoAgeMin === Infinity ? '无数据' : `${seoAgeMin} 分钟前`],
      ['链上索引', `transfers ${fmtNum(d.transfers)}${txDelta ? ` (+${fmtNum(txDelta)}/24h)` : ''} · backfill ${d.backfillPct}% · history ${historyDays.toFixed(1)}d`],
    ],
    note: !d.snap ? '今日快照缺失 —— 日更管线可能没跑,优先排查。' : undefined,
  }

  // B — data pipeline
  const bStatus: Status = d.watchlist === 0 || d.namedBrands === 0 ? 'bad' : d.reservesTotal <= 0 ? 'warn' : 'ok'
  const B: Section = {
    key: 'B', title: '数据管道', status: bStatus,
    rows: [
      ['监控地址', `${fmtNum(d.watchlist)} active`],
      ['归属覆盖', `${d.namedBrands} 具名品牌 · ${fmtNum(d.cov.reduce((s, c) => s + c.wallets, 0))} casino 钱包`],
      ...d.cov.map((c) => [`  └ ${c.src}`, `${fmtNum(c.wallets)} 钱包 / ${c.brands} 品牌`] as [string, string]),
      ['可验证储备', `${fmtUsd(d.reservesTotal)} · ${d.withReserves.length} 家运营商`],
    ],
  }

  // C — credibility & anomalies
  const highRisk = d.risk24.filter((e) => e.severity === 'elevated')
  const cStatus: Status = highRisk.length ? 'warn' : 'ok'
  const C: Section = {
    key: 'C', title: '信誉 / 异常', status: cStatus,
    rows: [
      ['疑似洗量品牌', d.suspect.length ? `${d.suspect.length} 家(已从榜单/聚合排除): ${d.suspect.slice(0, 6).map((b) => esc(b.brand)).join(', ')}${d.suspect.length > 6 ? ' …' : ''}` : '无'],
      ['24h 新增风险事件', d.risk24.length ? `${d.risk24.length} 条${highRisk.length ? ` · 其中 ${highRisk.length} 高危` : ''}` : '无'],
      ...d.risk24.slice(0, 5).map((e) => [`  └ ${esc(e.severity)}`, esc(e.title)] as [string, string]),
    ],
    note: highRisk.length ? '有高危风险事件,建议查看 /risk 与对应运营商储备。' : undefined,
  }

  // D — collector errors (rolling 24h, in-memory since restart)
  const ops = d.ops
  const cg = (ops.counts['casino.guru.403'] ?? 0) + (ops.counts['casino.guru.error'] ?? 0)
  const fwdErr = Object.entries(ops.counts).filter(([k]) => k.startsWith('rpc.forward_error.'))
  const fwdTotal = fwdErr.reduce((s, [, n]) => s + n, 0)
  const sinceH = (ops.sinceMs / 3_600_000).toFixed(1)
  const dStatus: Status = cg > 200 || fwdTotal > 500 ? 'warn' : 'ok'
  const D: Section = {
    key: 'D', title: `采集器错误(近 24h,统计自重启 ${sinceH}h 前)`, status: dStatus,
    rows: [
      ['casino.guru 抓取失败', cg ? `${cg} 次(${ops.counts['casino.guru.403'] ?? 0} 个 403)· 有重试+7日刷新,自愈` : '0'],
      ['RPC forward 错误', fwdTotal ? fwdErr.map(([k, n]) => `${k.replace('rpc.forward_error.', '')}:${n}`).join(' · ') : '0'],
      ['评分新鲜度', `${d.reviewsFresh7d} 家近 7 日有 casino.guru 评分`],
    ],
    note: dStatus === 'warn' ? '采集错误偏高,留意代理池/RPC 限流。' : undefined,
  }

  // E — SEO / GEO
  const kind = Object.fromEntries(d.seoByKind.map((r) => [r.kind, r.n]))
  const eStatus: Status = d.sitemap < 500 ? 'bad' : sitemapDelta < -20 ? 'warn' : 'ok'
  const E: Section = {
    key: 'E', title: 'SEO / GEO', status: eStatus,
    rows: [
      ['可收录页', `${fmtNum(d.sitemap)}${sitemapDelta ? ` (${sitemapDelta > 0 ? '+' : ''}${sitemapDelta})` : ''}`],
      ['构成', `casino ${kind.casino ?? 0} · compare ${kind.compare ?? 0} · rankings ${kind.rankings ?? 0} · guide ${kind.guide ?? 0} · streamer ${kind.streamers ?? 0} · data ${kind.data ?? 0}`],
      ['Edanic 补充页', `${d.edanicPages} 篇(content/*.md)`],
    ],
    note: sitemapDelta < -20 ? `sitemap 较昨日掉了 ${-sitemapDelta} 页,排查是否有 churn/回退。` : undefined,
  }

  // F — headline numbers
  const F: Section = {
    key: 'F', title: '关键数字', status: 'ok',
    rows: [
      ['24h 追踪成交(gross)', d.snap ? fmtUsd(d.snap.tracked_volume_24h || 0) : '—'],
      ['24h 净流', d.snap && d.snap.net_flow_24h != null ? fmtUsd(d.snap.net_flow_24h) : '—'],
      ['信任榜前 5', d.topTrust.length ? d.topTrust.map((b) => `${esc(b.brand)} ${b.trust}`).join(' · ') : '—'],
    ],
  }

  return [A, B, C, D, E, F]
}

export function generateSystemReport(sections: Section[], today: string, sitemap: number, transfers: number): { subject: string; html: string; text: string } {
  const overall = sections.reduce((s, sec) => worst(s, sec.status), 'ok' as Status)
  const overallLabel = overall === 'ok' ? '全绿 · 系统正常' : overall === 'warn' ? '有需关注项' : '有故障需处理'
  const subject = `${DOT[overall]} Tekel Data 系统日报 ${today} — ${overallLabel}`

  const secHtml = sections
    .map(
      (sec) =>
        `<tr><td style="padding:16px 18px;border-top:1px solid #1e2230">` +
        `<div style="font-size:15px;font-weight:600;color:#e8eaf0">${DOT[sec.status]} ${esc(sec.title)}</div>` +
        `<table style="width:100%;margin-top:8px;border-collapse:collapse;font-size:13px;color:#c7cbd6">` +
        sec.rows.map(([k, v]) => `<tr><td style="padding:3px 0;color:#8a90a2;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0 3px 14px;text-align:right">${esc(v)}</td></tr>`).join('') +
        `</table>` +
        (sec.note ? `<div style="margin-top:8px;font-size:12px;color:${sec.status === 'bad' ? '#ff8a8a' : '#f5c451'}">⚠ ${esc(sec.note)}</div>` : '') +
        `</td></tr>`,
    )
    .join('')

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0d12;padding:28px;color:#e8eaf0">
  <div style="max-width:600px;margin:0 auto;background:#11141c;border:1px solid #1e2230;border-radius:16px;overflow:hidden">
    <div style="padding:20px 18px;background:#0e1017;border-bottom:1px solid #1e2230">
      <div style="font-size:18px;font-weight:700">${DOT[overall]} Tekel Data 系统日报</div>
      <div style="font-size:13px;color:#8a90a2;margin-top:4px">${esc(today)} · ${esc(overallLabel)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">${secHtml}</table>
    <div style="padding:14px 18px;border-top:1px solid #1e2230;font-size:12px;color:#6b7080">
      内部运营日报,仅发送给运营者。数据进程内直读,每日 ${SEND_HOUR_UTC.toString().padStart(2, '0')}:00 UTC 发送。
      · <a href="${SITE}/proof-of-reserves" style="color:#8a90a2">储备</a> · <a href="${SITE}/risk" style="color:#8a90a2">风险</a>
    </div>
  </div>
</div>`

  const text = `Tekel Data 系统日报 ${today} — ${overallLabel}\n\n` + sections.map((s) => `${DOT[s.status]} ${s.title}\n` + s.rows.map(([k, v]) => `  ${k}: ${v}`).join('\n') + (s.note ? `\n  ⚠ ${s.note}` : '')).join('\n\n')

  // remember today's counters so tomorrow can show deltas
  stateSet('sysreport:last:sitemap', sitemap)
  stateSet('sysreport:last:transfers', transfers)
  return { subject, html, text }
}

async function buildAndRender() {
  const d = await collect()
  const sections = buildSections(d)
  return generateSystemReport(sections, d.today, d.sitemap, d.transfers)
}

async function sendSystemReport(): Promise<boolean> {
  const r = await buildAndRender()
  const { delivered } = await sendEmail(TO, r)
  console.log(`[sysreport] ${utcDay()} → ${TO} ${delivered ? 'sent' : 'FAILED'} · ${r.subject}`)
  return delivered
}

export function startSystemReport() {
  console.log(`[sysreport] daily system report scheduler active (send ${SEND_HOUR_UTC}:00 UTC → ${TO})`)
  let inflight = false
  const check = () => {
    try {
      if (new Date().getUTCHours() !== SEND_HOUR_UTC) return
      if (stateGet(`sysreport:sent:${utcDay()}`) || inflight) return
      // Mark sent only AFTER a delivered send (not before) — otherwise a failed send (e.g.
      // a stale RESEND_FROM) marks the day "sent" and the report silently never arrives.
      // `inflight` guards against a double-send while one is in flight within the hour.
      inflight = true
      void sendSystemReport()
        .then((ok) => { if (ok) stateSet(`sysreport:sent:${utcDay()}`, '1') })
        .catch((e) => console.warn('[sysreport] send failed:', (e as Error).message))
        .finally(() => { inflight = false })
    } catch {
      /* non-fatal */
    }
  }
  setTimeout(check, 4 * 60_000)
  setInterval(check, 30 * 60_000).unref?.()
  // One-shot sample send for QA: set SYSTEM_REPORT_SEND_NOW=1, deploy → one email fires
  // ~70s after boot (lets the aggregate cache warm), then clear the env. Does NOT touch
  // the daily idempotency key, so the normal 01:00 UTC send still happens.
  if (process.env.SYSTEM_REPORT_SEND_NOW === '1') {
    setTimeout(() => void sendSystemReport().catch((e) => console.warn('[sysreport] sample send failed:', (e as Error).message)), 70_000)
  }
}

// Admin-gated preview (render in browser) + test-send (email it now) for QA.
export function registerSystemReport(app: FastifyInstance) {
  app.get('/api/sysreport/preview', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const r = await buildAndRender()
    return reply.header('content-type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(r.html)
  })
  app.post('/api/sysreport/test-send', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const ok = await sendSystemReport()
    return reply.send({ ok, to: TO })
  })
}
