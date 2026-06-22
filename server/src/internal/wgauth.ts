import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes, randomInt } from 'node:crypto'
import { db } from '../db.ts'
import { config } from '../config.ts'
import { sendEmail } from '../email.ts'
import { userFromRequest, isAdminEmail } from '../auth.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Whale Growth 团队登录：面向公司内部同事的简单验证码门禁。
// 点"发送验证码" → 验证码发到「管理员邮箱」(WG_CODE_EMAIL / ADMIN_EMAILS[0]) →
// 同事输入验证码 → 发一个 30 天团队会话 token。管理员通过一个邮箱集中控制谁能进。
// 鉴权 requireTeam：团队会话 token 或 管理员账号(老 wcoin_token) 均可。
// ─────────────────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS wg_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, expires_at INTEGER, attempts INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS wg_sessions (
  token TEXT PRIMARY KEY, created_at INTEGER, expires_at INTEGER
);
`)

const CODE_TTL = 10 * 60_000
const SESSION_DAYS = 30
const adminEmail = () =>
  process.env.WG_CODE_EMAIL || (process.env.ADMIN_EMAILS || 'chennywang@live.com').split(',')[0].trim()

export function wgSessionValid(token: string): boolean {
  if (!token) return false
  return !!db.prepare('SELECT token FROM wg_sessions WHERE token=? AND expires_at>?').get(token, Date.now())
}

// 鉴权门：团队会话 token（Whale Growth 同事）或 管理员账号（老 wcoin_token）均放行。
export function requireTeam(req: FastifyRequest, reply: FastifyReply): boolean {
  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (token && wgSessionValid(token)) return true
  const user = userFromRequest(req)
  if (user && isAdminEmail(user.email)) return true
  reply.code(403).send({ error: 'login required' })
  return false
}

export function registerWgAuth(app: FastifyInstance): void {
  // 发送验证码到管理员邮箱
  app.post('/api/internal/auth/send-code', async (_req, reply) => {
    const recent = (db.prepare('SELECT COUNT(*) n FROM wg_codes WHERE created_at>?').get(Date.now() - CODE_TTL) as any).n
    if (recent >= 5) return reply.code(429).send({ error: '验证码请求过于频繁，请稍后再试' })
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    db.prepare('INSERT INTO wg_codes(code, expires_at, attempts, created_at) VALUES(?,?,0,?)').run(code, Date.now() + CODE_TTL, Date.now())
    const to = adminEmail()
    const { delivered } = await sendEmail(to, {
      subject: 'Whale Growth 登录验证码',
      html: `<p>Whale Growth 登录验证码：<b style="font-size:22px;letter-spacing:2px">${code}</b></p><p>10 分钟内有效。若非本人操作请忽略。</p>`,
      text: `Whale Growth 登录验证码：${code}（10 分钟内有效）`,
    })
    const masked = to.replace(/^(.).*(@.*)$/, '$1***$2')
    const devCode = !delivered && config.nodeEnv !== 'production' ? code : undefined
    return { sent: true, delivered, to: masked, ...(devCode ? { devCode } : {}) }
  })

  // 校验验证码 → 发团队会话 token
  app.post('/api/internal/auth/verify', async (req, reply) => {
    const code = ((req.body as { code?: string })?.code || '').trim()
    if (!code) return reply.code(400).send({ error: '请输入验证码' })
    const row = db.prepare('SELECT id, code, expires_at, attempts FROM wg_codes ORDER BY created_at DESC LIMIT 1').get() as
      | { id: number; code: string; expires_at: number; attempts: number }
      | undefined
    if (!row || row.expires_at < Date.now()) return reply.code(401).send({ error: '验证码已过期，请重新获取' })
    if (row.attempts >= 5) { db.prepare('DELETE FROM wg_codes').run(); return reply.code(429).send({ error: '尝试次数过多，请重新获取' }) }
    if (row.code !== code) { db.prepare('UPDATE wg_codes SET attempts=attempts+1 WHERE id=?').run(row.id); return reply.code(401).send({ error: '验证码错误' }) }
    db.prepare('DELETE FROM wg_codes').run()
    const token = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO wg_sessions(token, created_at, expires_at) VALUES(?,?,?)').run(token, Date.now(), Date.now() + SESSION_DAYS * 86_400_000)
    return { token }
  })

  setInterval(() => {
    const n = Date.now()
    db.prepare('DELETE FROM wg_codes WHERE expires_at<?').run(n)
    db.prepare('DELETE FROM wg_sessions WHERE expires_at<?').run(n)
  }, 3600_000)
}
