import { FastifyInstance } from 'fastify'
import { randomInt, randomBytes } from 'node:crypto'
import { db } from './db.ts'
import { sendEmail, subscribeConfirmBody } from './email.ts'
import { config } from './config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Daily-digest email subscription (double opt-in). Reuses the existing
// verification_codes table + the email transports. No login/session — a subscriber
// just confirms their email via a code, then manages via a non-enumerable
// unsubscribe token. Frequency (daily|weekly) is inline on the subscriber row.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const CODE_TTL_MS = 10 * 60_000
const MAX_CODES_PER_WINDOW = 5
const MAX_VERIFY_ATTEMPTS = 5
const SITE = 'https://tekeldata.com'

export function registerSubscribe(app: FastifyInstance) {
  // step 1 — request a confirmation code
  app.post('/api/subscribe', async (req, reply) => {
    const email = (req.body as { email?: string })?.email?.trim().toLowerCase()
    if (!email || !EMAIL_RE.test(email)) return reply.code(400).send({ error: 'A valid email is required' })
    const now = Date.now()
    const existing = db.prepare('SELECT status FROM email_subscriber WHERE email=?').get(email) as { status: string } | undefined
    if (existing?.status === 'active') return { sent: false, alreadyActive: true }
    // anti-bombing: cap codes per email per window (shared with sign-in)
    const recent = (db.prepare('SELECT COUNT(*) n FROM verification_codes WHERE email=? AND created_at > ?').get(email, now - CODE_TTL_MS) as any).n
    if (recent >= MAX_CODES_PER_WINDOW) return reply.code(429).send({ error: 'Too many requests — try again later' })

    // fresh one-click confirm token each request (so an old link can't linger)
    const confirmToken = randomBytes(24).toString('hex')
    db.prepare(
      `INSERT INTO email_subscriber(email, status, frequency, unsubscribe_token, confirm_token, created_at, updated_at)
       VALUES(?, 'pending', 'daily', ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET status='pending', confirm_token=excluded.confirm_token, updated_at=excluded.updated_at`,
    ).run(email, randomBytes(24).toString('hex'), confirmToken, now, now)

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    db.prepare('INSERT INTO verification_codes(email, code, expires_at, attempts, created_at) VALUES(?, ?, ?, 0, ?)').run(email, code, now + CODE_TTL_MS, now)
    const confirmUrl = `${SITE}/api/subscribe/confirm?token=${confirmToken}`
    const { delivered } = await sendEmail(email, subscribeConfirmBody(code, confirmUrl))
    const devCode = !delivered && config.nodeEnv !== 'production' ? code : undefined
    return { sent: true, delivered, ...(devCode ? { devCode } : {}) }
  })

  // form-friendly subscribe for the server-rendered SEO pages (no JS): a plain
  // <form> POST → branded HTML reply (the SPA still uses the JSON /api/subscribe).
  const htmlPage = (heading: string, msg: string) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${heading} — Tekel Data</title><body style="background:#0C0C0C;color:#e8e8ee;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:72px 20px"><h1 style="color:#F2C200;font-size:22px">${heading}</h1><p style="color:#aab;max-width:440px;margin:12px auto">${msg}</p><p style="margin-top:24px"><a style="color:#F2C200" href="/">← Back to Tekel Data</a></p></body>`
  app.post('/subscribe', async (req, reply) => {
    const email = String((req.body as { email?: string })?.email ?? '').trim().toLowerCase()
    const send = (h: string, m: string) => reply.type('text/html; charset=utf-8').send(htmlPage(h, m))
    if (!EMAIL_RE.test(email)) return send('Invalid email', 'Please enter a valid email and try again.')
    const now = Date.now()
    const existing = db.prepare('SELECT status FROM email_subscriber WHERE email=?').get(email) as { status: string } | undefined
    if (existing?.status === 'active') return send('Already subscribed', "You're already getting the daily on-chain report.")
    const recent = (db.prepare('SELECT COUNT(*) n FROM verification_codes WHERE email=? AND created_at > ?').get(email, now - CODE_TTL_MS) as any).n
    if (recent >= MAX_CODES_PER_WINDOW) return send('Too many requests', 'Please wait a few minutes and try again.')
    const confirmToken = randomBytes(24).toString('hex')
    db.prepare(
      `INSERT INTO email_subscriber(email, status, frequency, unsubscribe_token, confirm_token, created_at, updated_at)
       VALUES(?, 'pending', 'daily', ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET status='pending', confirm_token=excluded.confirm_token, updated_at=excluded.updated_at`,
    ).run(email, randomBytes(24).toString('hex'), confirmToken, now, now)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    db.prepare('INSERT INTO verification_codes(email, code, expires_at, attempts, created_at) VALUES(?, ?, ?, 0, ?)').run(email, code, now + CODE_TTL_MS, now)
    await sendEmail(email, subscribeConfirmBody(code, `${SITE}/api/subscribe/confirm?token=${confirmToken}`))
    return send('Almost there', 'Check your inbox and click the confirmation link to start the daily report.')
  })

  // step 2 — confirm the code → activate the subscriber
  app.post('/api/subscribe/verify', async (req, reply) => {
    const b = req.body as { email?: string; code?: string }
    const email = b?.email?.trim().toLowerCase()
    const code = b?.code?.trim()
    if (!email || !EMAIL_RE.test(email) || !code) return reply.code(400).send({ error: 'Email and code are required' })
    const row = db
      .prepare('SELECT rowid, code, expires_at, attempts FROM verification_codes WHERE email=? ORDER BY created_at DESC LIMIT 1')
      .get(email) as { rowid: number; code: string; expires_at: number; attempts: number } | undefined
    if (!row) return reply.code(400).send({ error: 'Request a code first' })
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM verification_codes WHERE email=?').run(email)
      return reply.code(400).send({ error: 'Code expired — request a new one' })
    }
    if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
      db.prepare('DELETE FROM verification_codes WHERE email=?').run(email)
      return reply.code(429).send({ error: 'Too many attempts. Request a new code.' })
    }
    if (row.code !== code) {
      db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE rowid = ?').run(row.rowid)
      return reply.code(400).send({ error: 'Invalid code' })
    }
    db.prepare('DELETE FROM verification_codes WHERE email=?').run(email)
    const now = Date.now()
    db.prepare("UPDATE email_subscriber SET status='active', verified_at=?, updated_at=? WHERE email=?").run(now, now, email)
    const tok = (db.prepare('SELECT unsubscribe_token, frequency FROM email_subscriber WHERE email=?').get(email) as any) ?? {}
    return { active: true, unsubscribeToken: tok.unsubscribe_token, frequency: tok.frequency }
  })

  // one-click CONFIRM (magic link in the confirmation email; activates the subscriber)
  app.get('/api/subscribe/confirm', async (req, reply) => {
    const token = (req.query as { token?: string })?.token
    const page = (heading: string, msg: string) =>
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} — Tekel Data</title>` +
            `<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0">` +
            `<div style="text-align:center;padding:24px;max-width:420px"><div style="font-weight:700;color:#F2C200;letter-spacing:.04em">Tekel Data</div>` +
            `<h1 style="font-size:22px;margin:16px 0 6px">${heading}</h1>` +
            `<p style="color:#9aa0b4;line-height:1.6">${msg}</p>` +
            `<a href="https://tekeldata.com/daily" style="display:inline-block;margin-top:18px;background:#F2C200;color:#0b0d12;font-weight:700;text-decoration:none;padding:11px 18px;border-radius:10px">View today's report →</a></div></body>`,
        )
    if (!token) return page('Invalid link', 'This confirmation link is missing its token.')
    const sub = db.prepare('SELECT email FROM email_subscriber WHERE confirm_token=?').get(token) as { email: string } | undefined
    if (!sub) return page('Link expired or already used', 'This confirmation link is no longer valid. If you still want the Tekel Data Daily, just subscribe again at tekeldata.com.')
    const now = Date.now()
    db.prepare("UPDATE email_subscriber SET status='active', verified_at=COALESCE(verified_at,?), confirm_token=NULL, updated_at=? WHERE email=?").run(now, now, sub.email)
    db.prepare('DELETE FROM verification_codes WHERE email=?').run(sub.email) // burn the paired code
    return page('Subscription confirmed ✓', "You're in — the next Tekel Data Daily lands in your inbox tomorrow morning. On-chain flows, reserves and signals, summarised.")
  })

  // one-click unsubscribe (token in every email; no login; non-enumerable)
  app.get('/api/unsubscribe', async (req, reply) => {
    const token = (req.query as { token?: string })?.token
    if (token) db.prepare("UPDATE email_subscriber SET status='unsubscribed', updated_at=? WHERE unsubscribe_token=?").run(Date.now(), token)
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Tekel Data</title>` +
          `<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0">` +
          `<div style="text-align:center;padding:24px"><div style="font-weight:700;color:#F2C200;letter-spacing:.04em">Tekel Data</div>` +
          `<h1 style="font-size:22px;margin:16px 0 6px">You're unsubscribed</h1>` +
          `<p style="color:#9aa0b4">You won't receive the Tekel Data Daily anymore.<br><a href="https://tekeldata.com" style="color:#F2C200">← Back to Tekel Data</a></p></div></body>`,
      )
  })

  // change frequency / re-subscribe via the token (no login)
  app.post('/api/subscribe/preferences', async (req, reply) => {
    const b = req.body as { token?: string; frequency?: string }
    if (!b?.token) return reply.code(400).send({ error: 'token required' })
    const freq = b.frequency === 'weekly' ? 'weekly' : 'daily'
    const r = db
      .prepare("UPDATE email_subscriber SET frequency=?, status=CASE WHEN status='unsubscribed' THEN 'active' ELSE status END, updated_at=? WHERE unsubscribe_token=?")
      .run(freq, Date.now(), b.token)
    if (!r.changes) return reply.code(404).send({ error: 'unknown token' })
    return { ok: true, frequency: freq }
  })
}
