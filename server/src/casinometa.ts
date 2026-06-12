import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// Casino reference metadata (license, founding year, house edge, currencies,
// supported chains, logo, website) sourced from the public circus.fyi roster
// (server/src/data/casino-roster.json). Matched to our watchlist entries by a
// normalised brand key so the Casinos page can show the same profile fields as
// the target site alongside our own real on-chain metrics.
// ─────────────────────────────────────────────────────────────────────────────

export interface CasinoMeta {
  name: string
  license: string | null
  foundedYear: number | null
  houseEdge: number | null
  sportsHouseEdge: number | null
  currencies: string[]
  chains: string[]
  website: string | null
  logo: string | null
}

// normalise a brand label/slug to a comparison key:
//  "Stake.com (11)" → "stake" ; "BC.Game (Hot Wallet 1)" → "bcgame"
function norm(s: string): string {
  let x = s.toLowerCase().replace(/\([^)]*\)/g, '') // drop parentheticals
  x = x.replace(/[^a-z0-9]/g, '') // strip dots/spaces/punct
  x = x.replace(/(com|io|gg|net)$/, '') // drop trailing TLD-ish
  x = x.replace(/\d+$/, '') // drop trailing index digits
  return x
}

const META = new Map<string, CasinoMeta>()
try {
  const path = fileURLToPath(new URL('./data/casino-roster.json', import.meta.url))
  const roster = JSON.parse(readFileSync(path, 'utf8')) as any[]
  for (const c of roster) {
    const meta: CasinoMeta = {
      name: c.name,
      license: c.license ?? null,
      foundedYear: c.founded_year ?? null,
      houseEdge: c.house_edge ?? null,
      sportsHouseEdge: c.sports_house_edge ?? null,
      currencies: Array.isArray(c.currencies) ? c.currencies : [],
      chains: Array.isArray(c.chains) ? c.chains : [],
      website: c.website_url ?? null,
      logo: c.logo_url ?? null,
    }
    for (const key of [norm(c.slug ?? ''), norm(c.name ?? '')]) {
      if (key && !META.has(key)) META.set(key, meta)
    }
  }
  console.log(`[casinometa] loaded ${roster.length} casino reference profiles`)
} catch (e) {
  console.warn('[casinometa] roster unreadable:', (e as Error).message)
}

export function matchCasinoMeta(label: string): CasinoMeta | null {
  return META.get(norm(label)) ?? null
}
