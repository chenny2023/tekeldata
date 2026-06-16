import { brandKey } from './casinometa.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Configurable brand alias map (1.0). The aggregate already merges most wallet
// labels heuristically (norm() in casinometa: drops .com/.io, parentheses, trailing
// digits) — verified in production: Stake.com / Stake(11) / Stake all collapse to
// one "Stake". This config layers on top to (a) pin a clean canonical NAME + SLUG,
// and (b) capture non-obvious aliases the heuristic can't (different wallet label
// → same brand). Add entries here; matching is by brandKey of any alias.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandAlias {
  canonical: string // public display name
  slug: string // URL slug
  aliases: string[] // any label/spelling that maps to this brand
}

export const BRAND_ALIASES: BrandAlias[] = [
  { canonical: 'Stake', slug: 'stake', aliases: ['Stake', 'Stake.com'] },
  { canonical: 'Stake.us', slug: 'stake-us', aliases: ['Stake.us', 'Stake US'] }, // kept SEPARATE from Stake
  { canonical: 'Roobet', slug: 'roobet', aliases: ['Roobet', 'Roobet.com'] },
  { canonical: 'BC.Game', slug: 'bc-game', aliases: ['BC.Game', 'BC Game', 'BCGame'] },
  { canonical: 'Rollbit', slug: 'rollbit', aliases: ['Rollbit', 'Rollbit.com'] },
  { canonical: 'Gamdom', slug: 'gamdom', aliases: ['Gamdom', 'Gamdom.com'] },
  { canonical: 'Duelbits', slug: 'duelbits', aliases: ['Duelbits', 'Duel', 'Duelbits.com'] },
  { canonical: 'BetFury', slug: 'betfury', aliases: ['BetFury', 'Betfury'] },
  { canonical: 'Shuffle', slug: 'shuffle', aliases: ['Shuffle', 'Shuffle.com'] },
  { canonical: 'Rainbet', slug: 'rainbet', aliases: ['Rainbet', 'Rainbet.com'] },
]

// ── volume-suspect handling ──────────────────────────────────────────────────
// Anomalous on-chain volume (wash trading / internal transfers / mislabelled
// aggregator) must never be featured at #1 — it destroys data credibility. Real
// casinos do ~$2–12K of volume per distinct counterparty; a brand doing $100K+
// per counterparty on large volume is concentrated in a few addresses (not real
// player flow). Config keys force-flag known cases; the heuristic catches the rest.
export const VOLUME_SUSPECT_KEYS = new Set<string>([brandKey('Rain.gg')])
const SUSPECT_VOL_FLOOR = Number(process.env.SUSPECT_VOL_FLOOR ?? 50_000_000) // only scrutinise large volume
const SUSPECT_VOL_PER_CP = Number(process.env.SUSPECT_VOL_PER_CP ?? 50_000) // real casinos are well under this

export function isVolumeSuspect(label: string, volume7d: number, players: number): boolean {
  if (VOLUME_SUSPECT_KEYS.has(brandKey(label))) return true
  if (volume7d < SUSPECT_VOL_FLOOR) return false
  return volume7d / Math.max(players, 1) > SUSPECT_VOL_PER_CP
}

// brandKey(alias) → {canonical, slug}
const byKey = new Map<string, BrandAlias>()
for (const b of BRAND_ALIASES) for (const a of b.aliases) byKey.set(brandKey(a), b)

// Resolve a raw label to its configured canonical brand, if any. Falls back to null
// so callers keep the heuristic brandName/brandKey when there's no explicit alias.
export function resolveAlias(label: string): BrandAlias | null {
  return byKey.get(brandKey(label)) ?? null
}
