import { webFetchUnlocked } from '../net.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Paid-unlocker fetch for fingerprint-blocked sites (Trustpilot, Reddit) that 403
// even via clean residential IPs. ScraperAPI charges by tier, so we use a FIXED
// tier PER CHANNEL (one request per fetch — predictable cost), overridable by env:
//   SCRAPER_TIER_TRUSTPILOT / SCRAPER_TIER_REDDIT = standard | premium | ultra
// Defaults: Trustpilot=ultra (it's Cloudflare-protected), Reddit=premium (just
// needs a residential exit). No `render` — targets are SSR HTML / raw JSON.
// Credits: standard≈1, premium≈10, ultra≈30 per request.
// ─────────────────────────────────────────────────────────────────────────────

const TIER_PARAM: Record<string, string> = {
  standard: '',
  premium: '&premium=true',
  ultra: '&ultra_premium=true',
  ultra_render: '&ultra_premium=true&render=true', // ultra + JS render — for sites whose Cloudflare needs the challenge executed
  premium_us: '&premium=true&country_code=us',
  ultra_us: '&ultra_premium=true&country_code=us',
}
const DEFAULT_TIER: Record<string, string> = { trustpilot: 'ultra', reddit: 'premium' }

export function tierName(channel: string): string {
  const env = process.env[`SCRAPER_TIER_${channel.toUpperCase()}`]?.toLowerCase()
  return env && TIER_PARAM[env] !== undefined ? env : DEFAULT_TIER[channel] || 'premium'
}

type FetchInit = Parameters<typeof webFetchUnlocked>[1]

// Returns the unlocked Response, or null ONLY when the unlocker isn't configured
// (caller then falls back to its normal residential path).
export async function unlockedFetch(channel: string, url: string, init: FetchInit): Promise<Response | null> {
  const p = webFetchUnlocked(url, init, TIER_PARAM[tierName(channel)] ?? '')
  if (!p) return null
  return await p
}

// One-off probe: fetch a target through a SPECIFIC tier and report the outcome.
// Powers the /unlockertest diagnostic so we can see which tier actually works.
export async function probeTier(url: string, tier: string, init: FetchInit): Promise<{ tier: string; status: number | string; len: number; body?: string }> {
  const p = webFetchUnlocked(url, init, TIER_PARAM[tier] ?? '')
  if (!p) return { tier, status: 'no-key', len: 0 }
  try {
    const r = await p
    const body = await r.text()
    // surface a snippet so we can read ScraperAPI's error / confirm real content
    return { tier, status: r.status, len: body.length, body: r.status === 200 ? undefined : body.slice(0, 200) }
  } catch (e) {
    return { tier, status: (e as Error).message.slice(0, 40), len: 0 }
  }
}
