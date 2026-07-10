import nodemailer, { type Transporter } from 'nodemailer'
import { config } from './config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Transactional email for passwordless sign-in codes. Pluggable + degrades
// gracefully. Transport precedence:
//   1. SMTP (e.g. Gmail) when EMAIL_USER + EMAIL_PASSWORD are set
//   2. Resend HTTP API when RESEND_API_KEY is set
//   3. neither → log the code to the server console, report undelivered
// so the whole sign-up flow still works in dev / before email is configured.
// ─────────────────────────────────────────────────────────────────────────────

export function smtpEnabled(): boolean {
  return !!(config.smtpUser && config.smtpPass)
}
export function resendEnabled(): boolean {
  return !!config.resendApiKey
}
export function emailEnabled(): boolean {
  return smtpEnabled() || resendEnabled()
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function bodies(code: string): { subject: string; html: string; text: string } {
  const safeCode = escapeHtml(code)
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0d12;padding:32px;color:#e8eaf0">
      <div style="max-width:440px;margin:0 auto;background:#11141c;border:1px solid #1e2230;border-radius:16px;padding:32px">
        <div style="font-weight:700;font-size:18px;letter-spacing:.04em;color:#F2C200">Tekel Data</div>
        <h1 style="font-size:20px;margin:20px 0 6px">Your sign-in code</h1>
        <p style="color:#9aa0b4;font-size:14px;margin:0 0 20px">Enter this code to access your free Tekel Data account. It expires in 10 minutes.</p>
        <div style="font-size:34px;font-weight:700;letter-spacing:.32em;background:#0b0d12;border:1px solid #1e2230;border-radius:12px;padding:18px;text-align:center;color:#fff">${safeCode}</div>
        <p style="color:#6b7080;font-size:12px;margin:20px 0 0">If you didn't request this, you can safely ignore this email.</p>
      </div>
    </div>`
  const text = `Your Tekel Data sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`
  return { subject: `Your Tekel Data code: ${code}`, html, text }
}

// Lazily-built, reused SMTP transport. Short timeouts so a blocked/unreachable
// SMTP egress (e.g. Railway blocks outbound 25/465/587) fails in seconds and
// can fall through to the next transport — instead of hanging the request for
// nodemailer's 2-minute default.
let smtpTransport: Transporter | null = null
function getSmtpTransport(): Transporter {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: config.smtpUser, pass: config.smtpPass },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 12_000,
    })
  }
  return smtpTransport
}

async function sendViaSmtp(email: string, b: ReturnType<typeof bodies>): Promise<boolean> {
  try {
    await getSmtpTransport().sendMail({
      from: config.emailFrom || config.smtpUser,
      to: email,
      subject: b.subject,
      text: b.text,
      html: b.html,
    })
    return true
  } catch (e) {
    console.error('[email] SMTP send failed:', (e as Error).message)
    return false
  }
}

async function sendViaResend(email: string, b: ReturnType<typeof bodies>): Promise<boolean> {
  try {
    // DIRECT fetch, NOT the webFetch proxy pool. Railway egress reaches api.resend.com
    // fine; routing transactional email through the rotating residential proxy only
    // added an intermittent failure mode (a flaky proxy meant the request never reached
    // Resend — silent non-delivery with nothing in the Resend dashboard). Verified: a
    // direct POST returns 200 + an email id. The proxy is for GFW-blocked/IP-blocked
    // open-web scrapes, not our own outbound API calls.
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.resendFrom, to: [email], subject: b.subject, html: b.html, text: b.text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[email] Resend send failed (${res.status}): ${body.slice(0, 300)}`)
      return false
    }
    return true
  } catch (e) {
    console.error('[email] Resend request error:', (e as Error).message)
    return false
  }
}

export async function sendVerificationCode(email: string, code: string): Promise<{ delivered: boolean }> {
  return sendEmail(email, bodies(code))
}

// Generic transactional send (sign-in codes, subscription confirms, daily digest).
// Same transport precedence + graceful degradation as the code mailer.
export async function sendEmail(
  to: string,
  body: { subject: string; html: string; text: string },
): Promise<{ delivered: boolean }> {
  if (smtpEnabled() && (await sendViaSmtp(to, body))) return { delivered: true }
  if (resendEnabled() && (await sendViaResend(to, body))) return { delivered: true }
  console.log(`[email] not delivered — "${body.subject}" → ${to}`)
  return { delivered: false }
}

// Subscription confirmation code (distinct copy from the sign-in code).
export function subscribeConfirmBody(code: string, confirmUrl: string): { subject: string; html: string; text: string } {
  const safe = escapeHtml(code)
  const url = escapeHtml(confirmUrl)
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0d12;padding:32px;color:#e8eaf0">
      <div style="max-width:440px;margin:0 auto;background:#11141c;border:1px solid #1e2230;border-radius:16px;padding:32px">
        <div style="font-weight:700;font-size:18px;letter-spacing:.04em;color:#F2C200">Tekel Data</div>
        <h1 style="font-size:20px;margin:20px 0 6px">Confirm your Daily Report subscription</h1>
        <p style="color:#9aa0b4;font-size:14px;margin:0 0 22px">One click to start receiving the free Crypto Casino Market Daily — on-chain flows, reserves &amp; streamer signals. This link expires in 10 minutes.</p>
        <a href="${url}" style="display:block;background:#F2C200;color:#0b0d12;font-weight:700;text-decoration:none;padding:14px 18px;border-radius:12px;text-align:center;font-size:15px">Confirm subscription →</a>
        <p style="color:#6b7080;font-size:13px;margin:22px 0 8px">Or enter this code on the site:</p>
        <div style="font-size:26px;font-weight:700;letter-spacing:.28em;background:#0b0d12;border:1px solid #1e2230;border-radius:12px;padding:14px;text-align:center;color:#fff">${safe}</div>
        <p style="color:#6b7080;font-size:12px;margin:22px 0 0">If you didn't request this, you can ignore this email.</p>
      </div>
    </div>`
  const text = `Confirm your Tekel Data Daily Report subscription by opening this link (expires in 10 minutes):\n${confirmUrl}\n\nOr enter this code on the site: ${code}`
  return { subject: `Confirm your Tekel Data Daily subscription`, html, text }
}
