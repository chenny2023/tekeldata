import nodemailer, { type Transporter } from 'nodemailer'
import { webFetch } from './net.ts'
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
        <div style="font-weight:700;font-size:18px;letter-spacing:.04em;color:#f5b100">WCOIN.CASINO</div>
        <h1 style="font-size:20px;margin:20px 0 6px">Your sign-in code</h1>
        <p style="color:#9aa0b4;font-size:14px;margin:0 0 20px">Enter this code to access your free WCOIN.CASINO account. It expires in 10 minutes.</p>
        <div style="font-size:34px;font-weight:700;letter-spacing:.32em;background:#0b0d12;border:1px solid #1e2230;border-radius:12px;padding:18px;text-align:center;color:#fff">${safeCode}</div>
        <p style="color:#6b7080;font-size:12px;margin:20px 0 0">If you didn't request this, you can safely ignore this email.</p>
      </div>
    </div>`
  const text = `Your WCOIN.CASINO sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`
  return { subject: `Your WCOIN.CASINO code: ${code}`, html, text }
}

// Lazily-built, reused SMTP transport.
let smtpTransport: Transporter | null = null
function getSmtpTransport(): Transporter {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: config.smtpUser, pass: config.smtpPass },
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
    const res = await webFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.resendFrom, to: [email], subject: b.subject, html: b.html, text: b.text }),
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
  const b = bodies(code)
  if (smtpEnabled()) return { delivered: await sendViaSmtp(email, b) }
  if (resendEnabled()) return { delivered: await sendViaResend(email, b) }
  console.log(`[email] no transport configured — verification code for ${email}: ${code}`)
  return { delivered: false }
}
