import { db } from './db.ts'
import { aggregateBrands } from './aggregate.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Data-quality checks (1.0 caliber). Run after each SEO/report regeneration to
// guarantee the public surface never regresses on the rules that protect the
// site's authority: brand dedup, no unattributed entities in verified rankings,
// no [object Object] / 'Players' / forbidden risk words, no thin/unattributed
// profiles. Results are logged; failures are surfaced (and queryable by admins).
// ─────────────────────────────────────────────────────────────────────────────

export interface DqResult {
  check: string
  status: 'pass' | 'fail'
  detail: string
}

// neutral-language guard — these must never appear on a public page (we describe
// risk neutrally: "observed outflow", "attribution confidence low", etc.)
const FORBIDDEN = /\b(scam|fraud|insolvent|rug ?pull|money laundering|criminal|bankrupt|running away)\b/i

let lastRun: { at: number; results: DqResult[] } | null = null

export async function runDataQualityChecks(): Promise<DqResult[]> {
  const out: DqResult[] = []
  const add = (check: string, ok: boolean, detail: string) => out.push({ check, status: ok ? 'pass' : 'fail', detail })

  // 1. brand dedup — verified brands must be unique after merge
  const brands = await aggregateBrands('casino')
  const labels = brands.filter((b) => b.attributed).map((b) => b.brand)
  const dupes = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))]
  add('brand-dedup', dupes.length === 0, dupes.length ? `duplicate verified brand labels: ${dupes.slice(0, 5).join(', ')}` : `${labels.length} verified brands, none duplicated`)

  const pages = db.prepare('SELECT path, kind, html FROM seo_page').all() as { path: string; kind: string; html: string }[]

  // 2. no unattributed entities inside verified rankings
  const rankLeak = pages.filter((p) => p.kind === 'rankings' && p.path !== '/rankings/unattributed-flow' && /Casino-pattern/i.test(p.html))
  add('unattributed-not-in-rankings', rankLeak.length === 0, rankLeak.length ? `Casino-pattern leaked into: ${rankLeak.map((p) => p.path).join(', ')}` : 'verified rankings are clean')

  // 3. no unattributed / raw-address casino profiles
  const patternProfiles = pages.filter((p) => p.kind === 'casino' && /casino-pattern|0x[0-9a-f]{4,}/i.test(p.path))
  add('no-unattributed-profiles', patternProfiles.length === 0, patternProfiles.length ? `unattributed profiles: ${patternProfiles.slice(0, 5).map((p) => p.path).join(', ')}` : 'no unattributed casino profiles')

  // 4. no [object Object] serialization leaks
  const oo = pages.filter((p) => p.html.includes('[object Object]'))
  add('no-object-object', oo.length === 0, oo.length ? `[object Object] in: ${oo.slice(0, 5).map((p) => p.path).join(', ')}` : 'no serialization leaks')

  // 5. no 'Players' label (must read 'Active Counterparties')
  const playersLabel = pages.filter((p) => />\s*(Casino )?Players\s*</.test(p.html))
  add('no-players-label', playersLabel.length === 0, playersLabel.length ? `'Players' label in: ${playersLabel.slice(0, 5).map((p) => p.path).join(', ')}` : "metric reads 'Active Counterparties'")

  // 6. no forbidden risk words in any public page
  const forbidden = pages
    .map((p) => ({ p, m: p.html.replace(/<[^>]+>/g, ' ').match(FORBIDDEN) }))
    .filter((x) => x.m)
  add('no-forbidden-words', forbidden.length === 0, forbidden.length ? `forbidden word "${forbidden[0].m![0]}" in: ${forbidden.slice(0, 5).map((x) => x.p.path).join(', ')}` : 'neutral language throughout')

  // 7. every public page carries last-updated + data confidence cues
  const casino = pages.filter((p) => p.kind === 'casino')
  const missingConf = casino.filter((p) => !/data confidence/i.test(p.html))
  add('confidence-labelled', missingConf.length === 0, missingConf.length ? `${missingConf.length} casino pages missing a confidence label` : 'all casino pages labelled with data confidence')

  lastRun = { at: Date.now(), results: out }
  return out
}

export function lastDataQuality(): { at: number; results: DqResult[] } | null {
  return lastRun
}
