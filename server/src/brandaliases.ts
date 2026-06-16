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

// brandKey(alias) → {canonical, slug}
const byKey = new Map<string, BrandAlias>()
for (const b of BRAND_ALIASES) for (const a of b.aliases) byKey.set(brandKey(a), b)

// Resolve a raw label to its configured canonical brand, if any. Falls back to null
// so callers keep the heuristic brandName/brandKey when there's no explicit alias.
export function resolveAlias(label: string): BrandAlias | null {
  return byKey.get(brandKey(label)) ?? null
}
