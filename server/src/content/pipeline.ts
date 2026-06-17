import { db } from '../db.ts'
import { webFetch } from '../net.ts'
import { buildPrompt } from './prompts.ts'
import { qaCheck } from './qa.ts'
import { generateContent, generateImage, openrouterEnabled } from './openrouter.ts'
import { postTweet, postThread, uploadMedia, xEnabled } from './xclient.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Content pipeline: snapshot → Grok (OpenRouter) → QA/risk filter → publish to X
// → log. Dormant until CONTENT_ENABLED=1; runs in dry-run (generate + QA, no
// publish) whenever the X keys are absent, so output can be verified first.
// ─────────────────────────────────────────────────────────────────────────────

const env = process.env
const utcDay = () => new Date().toISOString().slice(0, 10)
const IMAGE_STYLE =
  'dark crypto data dashboard, cyan and blue-green accents, premium intelligence report style, clean typography, no gambling promotion, no slot machines, no chips, no "play now", no bonus'

const logUpsert = db.prepare(`
  INSERT INTO content_log(date, content_type, platform, status, risk_level, model, generated_json, qa_json, published_url, skipped_reason, error, created_at)
  VALUES(@date,@type,'x',@status,@risk,@model,@generated,@qa,@url,@skip,@error,@now)
  ON CONFLICT(date, content_type, platform) DO UPDATE SET
    status=@status, risk_level=@risk, model=@model, generated_json=@generated, qa_json=@qa,
    published_url=COALESCE(@url, published_url), skipped_reason=@skip, error=@error, created_at=@now`)

function log(type: string, status: string, fields: Partial<{ risk: string; model: string; generated: any; qa: any; url: string; skip: string; error: string }>) {
  logUpsert.run({
    date: utcDay(), type, status,
    risk: fields.risk ?? null, model: fields.model ?? null,
    generated: fields.generated ? JSON.stringify(fields.generated) : null,
    qa: fields.qa ? JSON.stringify(fields.qa) : null,
    url: fields.url ?? null, skip: fields.skip ?? null, error: fields.error ?? null,
    now: Date.now(),
  })
}

function alreadyPublished(type: string): boolean {
  const r = db.prepare("SELECT status FROM content_log WHERE date=? AND content_type=? AND platform='x'").get(utcDay(), type) as any
  return r?.status === 'published'
}

async function imageBytes(ref: string): Promise<Buffer | null> {
  try {
    if (ref.startsWith('http')) {
      const res = await webFetch(ref, { signal: AbortSignal.timeout(60_000) })
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null
    }
    return Buffer.from(ref, 'base64') // b64_json
  } catch {
    return null
  }
}

// Generate + QA one content item. Publishes when publish=true AND X is configured.
export async function runContent(contentType: string, publish: boolean): Promise<{ status: string; risk?: string; data?: any; qa?: any; url?: string; error?: string }> {
  const built = buildPrompt(contentType)
  if (!built) {
    log(contentType, 'generation_fail', { error: 'no snapshot or unsupported type' })
    return { status: 'generation_fail', error: 'no snapshot available yet' }
  }
  if (!openrouterEnabled()) {
    return { status: 'disabled', error: 'OPENROUTER_API_KEY not set' }
  }
  const gen = await generateContent(built.system, built.user)
  if (!gen) {
    log(contentType, 'generation_fail', { error: 'model returned no valid JSON' })
    return { status: 'generation_fail', error: 'model returned no valid JSON' }
  }
  const qa = qaCheck(gen.data, built.qa)
  if (!qa.pass) {
    const status = qa.riskLevel === 'high' ? 'risk_high' : 'qa_fail'
    log(contentType, status, { risk: qa.riskLevel, model: gen.model, generated: gen.data, qa, skip: qa.failures.join('; ') })
    return { status, risk: qa.riskLevel, data: gen.data, qa }
  }
  // QA passed
  if (!publish || !xEnabled()) {
    log(contentType, 'qa_pass', { risk: qa.riskLevel, model: gen.model, generated: gen.data, qa })
    return { status: publish ? 'qa_pass_no_x_keys' : 'qa_pass', risk: qa.riskLevel, data: gen.data, qa }
  }
  // publish with up to 3 attempts (backoff 1/5/15 min)
  const backoff = [60_000, 300_000, 900_000]
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let url = ''
      if (contentType === 'daily_market_thread') {
        const tweets = (gen.data.tweets ?? []).map((t: any) => String(t.text)).filter(Boolean)
        if (!tweets.length) throw new Error('no tweets')
        url = (await postThread(tweets)).rootUrl
      } else if (contentType === 'top_ranking_image_post') {
        let mediaIds: string[] | undefined
        const img = await generateImage(`${gen.data.image?.title ?? 'Top verified crypto casino flows'} — ${IMAGE_STYLE}`, '1:1')
        if (img) {
          const bytes = await imageBytes(img)
          if (bytes) mediaIds = [await uploadMedia(bytes)]
        }
        url = (await postTweet(String(gen.data.post_text), { mediaIds })).url
      } else {
        url = (await postTweet(String(gen.data.post_text))).url
      }
      log(contentType, 'published', { risk: qa.riskLevel, model: gen.model, generated: gen.data, qa, url })
      console.log(`[content] published ${contentType} → ${url}`)
      return { status: 'published', risk: qa.riskLevel, data: gen.data, url }
    } catch (e) {
      const msg = (e as Error).message
      console.warn(`[content] publish ${contentType} attempt ${attempt + 1} failed:`, msg)
      if (attempt === 2) {
        log(contentType, 'publish_failed', { risk: qa.riskLevel, model: gen.model, generated: gen.data, qa, error: msg })
        return { status: 'publish_failed', error: msg, data: gen.data }
      }
      await new Promise((r) => setTimeout(r, backoff[attempt]))
    }
  }
  return { status: 'publish_failed' }
}

// dry-run preview (generate + QA, never publishes) for the admin endpoint
export const previewContent = (type: string) => runContent(type, false)

// ── scheduler ────────────────────────────────────────────────────────────────
const SCHEDULE: { type: string; hour: number; dow?: number }[] = [
  { type: 'daily_market_thread', hour: Number(env.CONTENT_THREAD_HOUR_UTC ?? 13) },
  { type: 'top_ranking_image_post', hour: Number(env.CONTENT_RANKING_HOUR_UTC ?? 16) },
  { type: 'rotating_signal_post', hour: Number(env.CONTENT_SIGNAL_HOUR_UTC ?? 20) },
]

export function startContent() {
  if (env.CONTENT_ENABLED !== '1') {
    console.log('[content] auto-publish pipeline is OFF (set CONTENT_ENABLED=1 + keys to enable)')
    return
  }
  console.log(`[content] pipeline active — OpenRouter:${openrouterEnabled() ? 'on' : 'OFF'} X:${xEnabled() ? 'on' : 'dry-run'}`)
  const check = () => {
    try {
      const h = new Date().getUTCHours()
      for (const s of SCHEDULE) {
        if (s.hour !== h) continue
        if (s.dow != null && new Date().getUTCDay() !== s.dow) continue
        if (alreadyPublished(s.type)) continue
        void runContent(s.type, true).catch((e) => console.warn('[content] run failed:', (e as Error).message))
      }
    } catch {
      /* non-fatal */
    }
  }
  setTimeout(check, 5 * 60_000)
  setInterval(check, 30 * 60_000).unref?.()
}
