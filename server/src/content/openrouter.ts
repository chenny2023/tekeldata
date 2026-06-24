import { webFetch } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter client (Grok). Text generation returns validated JSON; image
// generation returns a URL or base64. Disabled (returns null) when no API key —
// the whole content pipeline stays dormant until OPENROUTER_API_KEY is set.
// ─────────────────────────────────────────────────────────────────────────────

const env = process.env
export const OPENROUTER_KEY = () => env.OPENROUTER_API_KEY ?? ''
const BASE = () => env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
const TEXT_MODEL = () => env.OPENROUTER_TEXT_MODEL ?? 'x-ai/grok-4.3'
const TEXT_FALLBACK = () => env.OPENROUTER_TEXT_MODEL_FALLBACK ?? 'x-ai/grok-4.20'
const IMAGE_MODEL = () => env.OPENROUTER_IMAGE_MODEL ?? 'x-ai/grok-imagine-image-quality'
const APP_NAME = () => env.OPENROUTER_APP_NAME ?? 'WCOIN.CASINO'
const SITE_URL = () => env.OPENROUTER_SITE_URL ?? 'https://wcoin.casino'

export const openrouterEnabled = () => !!OPENROUTER_KEY()

const headers = () => ({
  Authorization: `Bearer ${OPENROUTER_KEY()}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': SITE_URL(),
  'X-Title': APP_NAME(),
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// strip ```json fences / extract the first {...} object, then parse
function parseJson(s: string): any | null {
  if (!s) return null
  let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) t = t.slice(a, b + 1)
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

async function callModel(model: string, system: string, user: string, maxTokens?: number): Promise<any | null> {
  const mt = maxTokens ?? Number(env.OPENROUTER_MAX_TOKENS ?? 2000)
  const res = await webFetch(`${BASE()}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model,
      temperature: Number(env.OPENROUTER_TEMPERATURE ?? 0.4),
      top_p: Number(env.OPENROUTER_TOP_P ?? 0.8),
      max_tokens: mt,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  // 余额不足时 OpenRouter 返回 402 并告知「最多能负担 N tokens」——降额重试一次，避免整条功能直接不可用。
  if (res.status === 402 && maxTokens == null) {
    const txt = await res.text()
    const afford = Number((txt.match(/can only afford (\d+)/i) || [])[1] || 0)
    if (afford >= 256) { console.warn(`[content] OpenRouter 余额偏低，降额到 ${afford - 64} tokens 重试（请尽快充值）`); return callModel(model, system, user, afford - 64) }
    throw new Error(`OpenRouter 余额不足，请充值：${txt.slice(0, 140)}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const j = (await res.json()) as any
  const text = j?.choices?.[0]?.message?.content ?? ''
  return parseJson(text)
}

// Generate structured JSON content. Tries the primary model, then the fallback,
// each with up to 2 attempts. Returns { data, model } or null.
export async function generateContent(system: string, user: string): Promise<{ data: any; model: string } | null> {
  if (!openrouterEnabled()) return null
  for (const model of [TEXT_MODEL(), TEXT_FALLBACK()]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await callModel(model, system, user)
        if (data) return { data, model }
      } catch (e) {
        console.warn(`[content] gen ${model} attempt ${attempt + 1} failed:`, (e as Error).message)
        await sleep(1500 * (attempt + 1))
      }
    }
  }
  return null
}

// Generate an image. Returns a data/URL string or null. (OpenRouter image models
// vary in response shape; we read the common `images`/`data` fields defensively.)
export async function generateImage(prompt: string, aspect = '1:1'): Promise<string | null> {
  if (!openrouterEnabled()) return null
  try {
    const res = await webFetch(`${BASE()}/images/generations`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: IMAGE_MODEL(), prompt, n: 1, size: aspect === '16:9' ? '1792x1024' : '1024x1024' }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as any
    return j?.data?.[0]?.url ?? j?.data?.[0]?.b64_json ?? j?.images?.[0]?.url ?? null
  } catch (e) {
    console.warn('[content] image gen failed:', (e as Error).message)
    return null
  }
}
