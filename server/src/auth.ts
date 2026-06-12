import { FastifyInstance, FastifyRequest } from 'fastify'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from './db.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Real authentication: scrypt-hashed passwords, opaque session tokens (30d),
// roles (casino | streamer | admin — first registered user becomes admin).
// Community trust votes are tied to authenticated users (one vote per entity).
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_DAYS = 30

function hash(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

export interface AuthUser {
  id: number
  email: string
  role: string
}

export function userFromRequest(req: FastifyRequest): AuthUser | null {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7).trim()
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as AuthUser | undefined
  return row ?? null
}

function issueSession(userId: number): string {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run(
    token,
    userId,
    now,
    now + SESSION_DAYS * 86_400_000,
  )
  return token
}

export async function registerAuth(app: FastifyInstance) {
  app.post('/api/auth/register', async (req, reply) => {
    const b = req.body as { email?: string; password?: string; role?: string }
    const email = b?.email?.trim().toLowerCase()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: 'valid email required' })
    }
    if (!b?.password || b.password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (exists) return reply.code(409).send({ error: 'email already registered' })

    const isFirst = (db.prepare('SELECT COUNT(*) n FROM users').get() as any).n === 0
    const role = isFirst ? 'admin' : ['casino', 'streamer'].includes(b.role ?? '') ? b.role! : 'casino'
    const salt = randomBytes(16).toString('hex')
    const info = db
      .prepare('INSERT INTO users(email, pass_hash, salt, role, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(email, hash(b.password, salt), salt, role, Date.now())
    const token = issueSession(Number(info.lastInsertRowid))
    return { token, user: { id: Number(info.lastInsertRowid), email, role } }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const b = req.body as { email?: string; password?: string }
    const email = b?.email?.trim().toLowerCase()
    const row = db
      .prepare('SELECT id, email, role, pass_hash, salt FROM users WHERE email = ?')
      .get(email ?? '') as any
    if (!row || !b?.password) return reply.code(401).send({ error: 'invalid credentials' })
    const candidate = Buffer.from(hash(b.password, row.salt), 'hex')
    const stored = Buffer.from(row.pass_hash, 'hex')
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
      return reply.code(401).send({ error: 'invalid credentials' })
    }
    const token = issueSession(row.id)
    return { token, user: { id: row.id, email: row.email, role: row.role } }
  })

  app.get('/api/auth/me', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'not authenticated' })
    return { user }
  })

  app.post('/api/auth/logout', async (req) => {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.slice(7).trim())
    }
    return { ok: true }
  })

  // ── community trust votes (authenticated, one per user per entity) ──────────
  app.post('/api/vote', async (req, reply) => {
    const user = userFromRequest(req)
    if (!user) return reply.code(401).send({ error: 'login required to vote' })
    const b = req.body as { watch_id?: number; vote?: number }
    const watchId = Number(b?.watch_id)
    const vote = Number(b?.vote)
    if (!watchId || (vote !== 1 && vote !== -1)) {
      return reply.code(400).send({ error: 'watch_id and vote (+1 | -1) required' })
    }
    const entity = db.prepare('SELECT id FROM watchlist WHERE id = ? AND active = 1').get(watchId)
    if (!entity) return reply.code(404).send({ error: 'unknown entity' })
    db.prepare(
      `INSERT INTO votes(user_id, watch_id, vote, updated_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(user_id, watch_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`,
    ).run(user.id, watchId, vote, Date.now())
    return { ok: true }
  })

  // periodic session cleanup
  setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  }, 3600_000)
}
