import { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { db } from './db.ts'
import { brandKey } from './casinometa.ts'
import { sendEmail } from './email.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Per-casino public alert subscription (no login). A visitor on a /casino page asks
// to be emailed when that brand's tracked on-chain reserves drop materially or a large
// net outflow is observed. Double opt-in (confirm link) + non-enumerable unsubscribe.
// The detector reads reserve_history directly (already populated daily) — no heavy
// aggregate. Wording is strictly neutral: observed wallet data, never a solvency verdict.
// ─────────────────────────────────────────────────────────────────────────────

const SITE = 'https://tekeldata.com'
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const DROP_THRESHOLD = -0.15 // reserves down ≥15% over the window → notify
const REALERT_MS = 3 * 86_400_000 // at most one alert per (sub) per 3 days

const fmtUsd = (n: number) => {
  const a = Math.abs(n || 0)
  return a >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n || 0)
}
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function page(reply: any, heading: string, msg: string) {
  return reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)} — Tekel Data</title>` +
        `<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0">` +
        `<div style="text-align:center;padding:24px;max-width:440px"><div style="font-weight:700;color:#F2C200;letter-spacing:.04em">Tekel Data</div>` +
        `<h1 style="font-size:22px;margin:16px 0 6px">${esc(heading)}</h1><p style="color:#9aa0b4;line-height:1.6">${msg}</p>` +
        `<a href="https://tekeldata.com/" style="display:inline-block;margin-top:18px;background:#F2C200;color:#0b0d12;font-weight:700;text-decoration:none;padding:11px 18px;border-radius:10px">← Tekel Data</a></div></body>`,
    )
}

function confirmEmail(brand: string, confirmUrl: string): { subject: string; html: string; text: string } {
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b0d12;padding:32px;color:#e8eaf0"><div style="max-width:440px;margin:0 auto;background:#11141c;border:1px solid #1e2230;border-radius:16px;padding:32px">
    <div style="font-weight:700;font-size:18px;letter-spacing:.04em;color:#F2C200">Tekel Data</div>
    <h1 style="font-size:20px;margin:18px 0 6px">Confirm alerts for ${esc(brand)}</h1>
    <p style="color:#9aa0b4;font-size:14px;margin:0 0 22px">One click to get notified when ${esc(brand)}'s tracked on-chain reserves drop materially or a large net outflow is observed. Observed wallet data — not a solvency or safety statement.</p>
    <a href="${esc(confirmUrl)}" style="display:block;background:#F2C200;color:#0b0d12;font-weight:700;text-decoration:none;padding:14px 18px;border-radius:12px;text-align:center;font-size:15px">Confirm alerts →</a>
    <p style="color:#6b7080;font-size:12px;margin:22px 0 0">If you didn't request this, you can ignore this email.</p></div></div>`
  return { subject: `Confirm Tekel Data alerts for ${brand}`, html, text: `Confirm alerts for ${brand}: ${confirmUrl}` }
}

function alertEmail(brand: string, pct: number, reserves: number, unsubUrl: string): { subject: string; html: string; text: string } {
  const sign = pct >= 0 ? '+' : ''
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b0d12;padding:32px;color:#e8eaf0"><div style="max-width:440px;margin:0 auto;background:#11141c;border:1px solid #1e2230;border-radius:16px;padding:32px">
    <div style="font-weight:700;font-size:18px;letter-spacing:.04em;color:#F2C200">Tekel Data</div>
    <h1 style="font-size:19px;margin:18px 0 6px">Reserve movement — ${esc(brand)}</h1>
    <p style="color:#cdd2e0;font-size:14px;line-height:1.6;margin:0 0 14px">${esc(brand)}'s tracked all-chain reserves changed <strong style="color:#ff6b8a">${sign}${(pct * 100).toFixed(1)}%</strong> over the last ~7 days, now ~<strong>${fmtUsd(reserves)}</strong>.</p>
    <p style="color:#9aa0b4;font-size:13px;line-height:1.6;margin:0 0 18px">This is observed on-chain wallet data with partial coverage — <em>not</em> a statement on solvency, safety or legality. Always do your own research.</p>
    <a href="${SITE}/casino/${esc(brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))}" style="display:block;background:#F2C200;color:#0b0d12;font-weight:700;text-decoration:none;padding:13px 18px;border-radius:12px;text-align:center;font-size:15px">View ${esc(brand)}'s on-chain data →</a>
    <p style="color:#6b7080;font-size:11px;margin:22px 0 0">You subscribed to ${esc(brand)} alerts at Tekel Data. <a href="${esc(unsubUrl)}" style="color:#9aa0b4">Unsubscribe</a>.</p></div></div>`
  void dir
  return { subject: `Reserve movement: ${brand} ${sign}${(pct * 100).toFixed(1)}% (7d)`, html, text: `${brand} tracked reserves changed ${sign}${(pct * 100).toFixed(1)}% over ~7d, now ~${fmtUsd(reserves)}. Observed data, not a solvency statement. ${SITE}/daily  Unsubscribe: ${unsubUrl}` }
}

export function registerCasinoAlert(app: FastifyInstance) {
  // step 1 — subscribe (plain form POST from the SEO casino page → branded HTML reply)
  app.post('/api/casino-alert', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; brand?: string }
    const email = String(b.email ?? '').trim().toLowerCase()
    const brand = String(b.brand ?? '').trim().slice(0, 120)
    if (!EMAIL_RE.test(email) || !brand) return page(reply, 'Something went wrong', 'A valid email and casino are required. Please try again from the casino page.')
    const key = brandKey(brand)
    const now = Date.now()
    const recent = (db.prepare('SELECT COUNT(*) n FROM brand_alert_sub WHERE email=? AND created_at>?').get(email, now - 3600_000) as any).n
    if (recent >= 15) return page(reply, 'Too many requests', 'Please wait a few minutes and try again.')
    const confirmToken = randomBytes(24).toString('hex')
    db.prepare(
      `INSERT INTO brand_alert_sub(email, brand_key, brand_label, status, confirm_token, unsubscribe_token, created_at, updated_at)
       VALUES(?,?,?,'pending',?,?,?,?)
       ON CONFLICT(email, brand_key) DO UPDATE SET status=CASE WHEN status='active' THEN 'active' ELSE 'pending' END, brand_label=excluded.brand_label, confirm_token=excluded.confirm_token, updated_at=excluded.updated_at`,
    ).run(email, key, brand, confirmToken, randomBytes(24).toString('hex'), now, now)
    const already = db.prepare('SELECT status FROM brand_alert_sub WHERE email=? AND brand_key=?').get(email, key) as { status: string } | undefined
    if (already?.status === 'active') return page(reply, 'Already subscribed', `You're already getting ${esc(brand)} reserve alerts.`)
    await sendEmail(email, confirmEmail(brand, `${SITE}/api/casino-alert/confirm?token=${confirmToken}`))
    return page(reply, 'Almost there', `Check your inbox and click the link to confirm <strong>${esc(brand)}</strong> reserve alerts.`)
  })

  // step 2 — confirm
  app.get('/api/casino-alert/confirm', async (req, reply) => {
    const token = (req.query as { token?: string })?.token
    if (!token) return page(reply, 'Invalid link', 'This confirmation link is missing its token.')
    const sub = db.prepare('SELECT id, brand_label FROM brand_alert_sub WHERE confirm_token=?').get(token) as { id: number; brand_label: string } | undefined
    if (!sub) return page(reply, 'Link expired or already used', 'This confirmation link is no longer valid. Re-subscribe from the casino page.')
    db.prepare("UPDATE brand_alert_sub SET status='active', confirm_token=NULL, updated_at=? WHERE id=?").run(Date.now(), sub.id)
    return page(reply, 'Alerts confirmed ✓', `You'll be emailed when ${esc(sub.brand_label || 'this casino')}'s tracked reserves move materially.`)
  })

  // unsubscribe
  app.get('/api/casino-alert/unsubscribe', async (req, reply) => {
    const token = (req.query as { token?: string })?.token
    if (token) db.prepare("UPDATE brand_alert_sub SET status='unsubscribed', updated_at=? WHERE unsubscribe_token=?").run(Date.now(), token)
    return page(reply, "You're unsubscribed", 'You will no longer receive these reserve alerts.')
  })
}

// detector — for each brand with active subs, compare current vs ~7d-ago reserves from
// reserve_history; on a material drop, email subscribers (deduped). Best-effort.
async function runCasinoAlerts(): Promise<void> {
  const brands = db.prepare("SELECT DISTINCT brand_key FROM brand_alert_sub WHERE status='active'").all() as { brand_key: string }[]
  if (!brands.length) return
  const now = Date.now()
  for (const { brand_key } of brands) {
    const rows = db.prepare('SELECT reserves, day FROM reserve_history WHERE brand_key=? ORDER BY day DESC LIMIT 9').all(brand_key) as { reserves: number; day: number }[]
    if (rows.length < 2) continue
    const current = rows[0].reserves
    const prior = rows[rows.length - 1].reserves // oldest in the ~8-day window
    if (!(prior > 0)) continue
    const pct = (current - prior) / prior
    if (pct > DROP_THRESHOLD) continue // not a material drop → skip
    const subs = db.prepare("SELECT id, email, brand_label, unsubscribe_token, last_alert_at FROM brand_alert_sub WHERE brand_key=? AND status='active'").all(brand_key) as any[]
    for (const s of subs) {
      if (s.last_alert_at && now - s.last_alert_at < REALERT_MS) continue
      try {
        await sendEmail(s.email, alertEmail(s.brand_label || brand_key, pct, current, `${SITE}/api/casino-alert/unsubscribe?token=${s.unsubscribe_token}`))
        db.prepare('UPDATE brand_alert_sub SET last_alert_at=?, updated_at=? WHERE id=?').run(now, now, s.id)
      } catch (e) {
        console.warn('[casino-alert] send failed:', (e as Error).message)
      }
    }
    if (subs.length) console.log(`[casino-alert] ${brand_key} reserves ${(pct * 100).toFixed(1)}% → notified ${subs.length} sub(s)`)
  }
}

export function startCasinoAlerts() {
  const run = () => runCasinoAlerts().catch((e) => console.warn('[casino-alert] run failed:', (e as Error).message))
  setTimeout(run, 300_000) // first pass after reserve history warms
  setInterval(run, 6 * 3600_000).unref?.() // every 6h
  console.log('[casino-alert] per-casino reserve-alert subscriptions active')
}
