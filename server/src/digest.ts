import { FastifyInstance } from 'fastify'
import { db } from './db.ts'
import { sendEmail } from './email.ts'
import { latestMarketSnapshot } from './snapshot.ts'
import { userFromRequest } from './auth.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Daily digest: render today's market snapshot into an email, send to active
// subscribers (respecting frequency), with per-recipient dedupe (one row per
// digest×subscriber → never double-sent) and a one-click unsubscribe link. All
// numbers come from the snapshot — no AI, no fabrication.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = 'https://tekeldata.com'
const SEND_HOUR = Number(process.env.DIGEST_SEND_HOUR_UTC ?? 13)
const WEEKLY_DOW = Number(process.env.DIGEST_WEEKLY_DOW ?? 1) // Monday
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fmtUsd(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
  return '$' + Math.round(n)
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// Build the email bodies from a snapshot. {{UNSUB}} is substituted per-recipient.
function buildDigestBodies(snap: any): { subject: string; html: string; text: string } {
  const p = snap.payload || {}
  const date = snap.snapshot_date
  const net = snap.net_flow_24h ?? 0
  const row = (label: string, value: string) =>
    `<tr><td style="padding:7px 0;color:#9aa0b4;font-size:13px">${esc(label)}</td><td style="padding:7px 0;text-align:right;font-weight:700;color:#fff;font-size:14px">${esc(value)}</td></tr>`
  const stats = [
    row('24H Verified Tracked Volume', fmtUsd(snap.tracked_volume_24h ?? 0)),
    row('Net flow (24h)', (net >= 0 ? '+' : '−') + fmtUsd(Math.abs(net))),
    row('Active Verified Brands', String(snap.active_casinos ?? 0)),
    row('Active chains', String(snap.active_chains ?? 0)),
    row('Live streamers', String(snap.live_streamers ?? 0)),
    row('Tracked reserves (all-chain)', fmtUsd(snap.reserves_total ?? 0)),
  ].join('')
  const movers = (p.topMovers ?? []).slice(0, 6).map((m: any) => row(m.label, fmtUsd(m.vol24h))).join('')
  // aggregated whale groups (fall back to raw events for pre-aggregation snapshots)
  const wGroups = (p.whaleGroups ?? []).length
    ? p.whaleGroups.slice(0, 6)
    : (p.whales ?? []).slice(0, 6).map((w: any) => ({ label: w.label, direction: w.direction, count: 1, total: w.usd }))
  const whales = wGroups
    .map((g: any) => row(`${g.label} · ${g.count} ${g.direction === 'in' ? 'inflow' : 'outflow'}${g.count > 1 ? 's' : ''}`, fmtUsd(g.total)))
    .join('')
  const COV: Record<string, string> = { high: 'High', medium: 'Medium', partial: 'Partial', under_review: 'Under review', unknown: 'Unknown' }
  const reserves = (p.topReserves ?? []).slice(0, 6).map((r: any) => row(`${r.label} · ${COV[r.level] ?? 'Coverage n/a'}`, fmtUsd(r.reserves))).join('')

  const section = (title: string, body: string) =>
    body
      ? `<h2 style="font-size:15px;margin:24px 0 4px;color:#F2C200;letter-spacing:.02em">${title}</h2><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${body}</table>`
      : ''

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0d12;padding:24px;color:#e8eaf0">
    <div style="max-width:560px;margin:0 auto;background:#11141c;border:1px solid #1e2230;border-radius:16px;padding:28px">
      <div style="font-weight:700;font-size:18px;letter-spacing:.04em;color:#F2C200">Tekel Data</div>
      <div style="color:#6b7080;font-size:12px;margin-top:2px">Crypto Casino Market Daily · ${esc(date)} (UTC)</div>
      ${
        snap.aiMarketRead && (snap.aiMarketRead.what_changed || snap.aiMarketRead.why_it_matters)
          ? `<div style="margin:22px 0 4px;background:#0e1320;border:1px solid #1e2230;border-radius:12px;padding:16px"><div style="font-size:13px;font-weight:700;color:#F2C200;margin-bottom:8px">Today's Market Read</div>` +
            [['What changed', snap.aiMarketRead.what_changed], ['Why it matters', snap.aiMarketRead.why_it_matters], ['What to watch', snap.aiMarketRead.what_to_watch]]
              .filter(([, v]) => v)
              .map(([k, v]) => `<div style="margin-bottom:8px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#9aa0b4">${k}</div><div style="font-size:13.5px;color:#cdd2e0;line-height:1.5">${esc(String(v))}</div></div>`)
              .join('') +
            `</div>`
          : ''
      }
      ${section('Verified market snapshot', stats)}
      ${section('Biggest movers — verified 24h volume', movers)}
      ${section('Whale activity — aggregated (24h)', whales)}
      ${section('Tracked all-chain reserves', reserves)}
      <div style="margin-top:26px"><a href="${SITE}/daily" style="display:inline-block;background:#F2C200;color:#0b0d12;font-weight:700;text-decoration:none;padding:11px 18px;border-radius:10px;font-size:14px">Read the full daily report →</a></div>
      <p style="color:#6b7080;font-size:11px;margin:24px 0 0;line-height:1.6">Figures are on-chain observations &amp; third-party data with inherent attribution uncertainty — not a statement on any operator's solvency or legality. See methodology on the site.<br><br>You're receiving this because you subscribed at Tekel Data. <a href="{{UNSUB}}" style="color:#9aa0b4">Unsubscribe</a>.</p>
    </div>
  </div>`
  const text =
    `Tekel Data — Crypto Casino Market Daily (${date} UTC)\n\n` +
    `24h volume: ${fmtUsd(snap.tracked_volume_24h ?? 0)} | net flow: ${(net >= 0 ? '+' : '-') + fmtUsd(Math.abs(net))} | casinos: ${snap.active_casinos} | chains: ${snap.active_chains} | reserves: ${fmtUsd(snap.reserves_total ?? 0)}\n\n` +
    `Biggest movers: ${(p.topMovers ?? []).slice(0, 5).map((m: any) => `${m.label} ${fmtUsd(m.vol24h)}`).join(', ')}\n\n` +
    `Full report: ${SITE}/daily\nUnsubscribe: {{UNSUB}}`
  return { subject: `Crypto Casino Market Daily — ${fmtUsd(snap.tracked_volume_24h ?? 0)} verified on-chain, ${snap.active_casinos} brands (${date})`, html, text }
}

// Upsert today's digest row from the latest snapshot.
function generateDigest(): { id: number; subject: string; html: string; text: string } | null {
  const snap = latestMarketSnapshot()
  if (!snap || snap.error) return null
  const date = utcDay()
  const b = buildDigestBodies(snap)
  db.prepare(
    `INSERT INTO email_digest(digest_date, subject, html, text, status, created_at)
     VALUES(?,?,?,?, 'draft', ?)
     ON CONFLICT(digest_date) DO UPDATE SET subject=excluded.subject, html=excluded.html, text=excluded.text`,
  ).run(date, b.subject, b.html, b.text, Date.now())
  const id = (db.prepare('SELECT id FROM email_digest WHERE digest_date=?').get(date) as any).id
  return { id, ...b }
}

const unsubUrl = (token: string) => `${SITE}/api/unsubscribe?token=${token}`

// Send today's digest to all eligible active subscribers not yet successfully sent.
async function sendDigestToSubscribers(): Promise<{ sent: number; failed: number }> {
  const d = generateDigest()
  if (!d) return { sent: 0, failed: 0 }
  const isWeeklyDay = new Date().getUTCDay() === WEEKLY_DOW
  // active subscribers eligible today, not already successfully sent this digest
  const subs = db
    .prepare(
      `SELECT s.id, s.email, s.unsubscribe_token, s.frequency FROM email_subscriber s
       WHERE s.status='active' AND (s.frequency='daily' OR (s.frequency='weekly' AND ?))
         AND NOT EXISTS (SELECT 1 FROM email_digest_log l WHERE l.digest_id=? AND l.subscriber_id=s.id AND l.send_status='sent')`,
    )
    .all(isWeeklyDay ? 1 : 0, d.id) as { id: number; email: string; unsubscribe_token: string; frequency: string }[]
  const logUpsert = db.prepare(
    `INSERT INTO email_digest_log(digest_id, subscriber_id, send_status, last_error, sent_at) VALUES(?,?,?,?,?)
     ON CONFLICT(digest_id, subscriber_id) DO UPDATE SET send_status=excluded.send_status, last_error=excluded.last_error, sent_at=excluded.sent_at`,
  )
  let sent = 0
  let failed = 0
  for (const s of subs) {
    const u = unsubUrl(s.unsubscribe_token)
    const { delivered } = await sendEmail(s.email, { subject: d.subject, html: d.html.replace(/{{UNSUB}}/g, u), text: d.text.replace(/{{UNSUB}}/g, u) })
    logUpsert.run(d.id, s.id, delivered ? 'sent' : 'failed', delivered ? null : 'send failed', Date.now())
    delivered ? sent++ : failed++
    await sleep(250) // pace for the ESP rate limit
  }
  db.prepare("UPDATE email_digest SET status='sent' WHERE id=?").run(d.id)
  if (sent || failed) console.log(`[digest] ${utcDay()} sent=${sent} failed=${failed} (${subs.length} eligible)`)
  return { sent, failed }
}

export function startDigest() {
  console.log(`[digest] daily digest scheduler active (send hour ${SEND_HOUR}:00 UTC)`)
  // check every 30 min; send once when the send hour arrives and today isn't sent yet
  const check = () => {
    try {
      const now = new Date()
      if (now.getUTCHours() !== SEND_HOUR) return
      const today = db.prepare("SELECT status FROM email_digest WHERE digest_date=?").get(utcDay()) as any
      if (today?.status === 'sent') return
      void sendDigestToSubscribers().catch((e) => console.warn('[digest] send failed:', (e as Error).message))
    } catch {
      /* non-fatal */
    }
  }
  setTimeout(check, 5 * 60_000)
  setInterval(check, 30 * 60_000).unref?.()
}

// Admin-only preview + test send (gated). For QA before the real daily send.
export function registerDigest(app: FastifyInstance) {
  app.get('/api/digest/preview', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const d = generateDigest()
    if (!d) return reply.code(404).send({ error: 'no snapshot to build a digest from yet' })
    return reply.header('content-type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(d.html.replace(/{{UNSUB}}/g, `${SITE}/api/unsubscribe?token=preview`))
  })
  app.post('/api/digest/test', async (req, reply) => {
    if (!userFromRequest(req)) return reply.code(401).send({ error: 'login required' })
    const email = (req.body as { email?: string })?.email?.trim().toLowerCase()
    if (!email) return reply.code(400).send({ error: 'email required' })
    const d = generateDigest()
    if (!d) return reply.code(404).send({ error: 'no snapshot yet' })
    const u = `${SITE}/api/unsubscribe?token=test`
    const { delivered } = await sendEmail(email, { subject: '[TEST] ' + d.subject, html: d.html.replace(/{{UNSUB}}/g, u), text: d.text.replace(/{{UNSUB}}/g, u) })
    return { sent: true, delivered }
  })
}
