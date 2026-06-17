import { db } from './db.ts'
import { aggregateBrands } from './aggregate.ts'
import { brandKey } from './casinometa.ts'
import { resolveAlias } from './brandaliases.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Persistent brand layer (1.0). Materialises the brand aggregation into durable
// tables — canonical brand record, entity→brand traceability map, and per-day
// brand metrics — for history, audit and a queryable source of truth. The hot
// read path still uses the cached in-memory aggregate (equivalent + fresher);
// these tables add what memory can't: history and an inspectable record.
// ─────────────────────────────────────────────────────────────────────────────

const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)
const slugify = (s: string) =>
  String(s || '').toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

const upsertBrand = db.prepare(`
  INSERT INTO casino_brand(brand_id,canonical_name,slug,website,status,category,primary_chain,is_public,confidence_level,source_entity_count,created_at,updated_at)
  VALUES(@brand_id,@canonical_name,@slug,@website,'active',@category,@primary_chain,@is_public,@confidence_level,@source_entity_count,@now,@now)
  ON CONFLICT(brand_id) DO UPDATE SET canonical_name=@canonical_name, slug=@slug, primary_chain=@primary_chain,
    is_public=@is_public, confidence_level=@confidence_level, source_entity_count=@source_entity_count, updated_at=@now`)

const upsertMetrics = db.prepare(`
  INSERT INTO brand_daily_metrics(brand_id,date,volume24h,volume7d,inflow7d,outflow7d,net7d,tx_count_7d,active_counterparties_7d,reserves,reserve_coverage,trust_score,safety_index,trustpilot,reputation,chain_breakdown_json,source_entity_count,confidence_level,last_updated_at)
  VALUES(@brand_id,@date,@volume24h,@volume7d,@inflow7d,@outflow7d,@net7d,@tx,@acp,@reserves,@cov,@trust,@safety,@tp,@rep,@cb,@sec,@conf,@now)
  ON CONFLICT(brand_id,date) DO UPDATE SET volume24h=@volume24h,volume7d=@volume7d,inflow7d=@inflow7d,outflow7d=@outflow7d,
    net7d=@net7d,tx_count_7d=@tx,active_counterparties_7d=@acp,reserves=@reserves,reserve_coverage=@cov,trust_score=@trust,
    safety_index=@safety,trustpilot=@tp,reputation=@rep,chain_breakdown_json=@cb,source_entity_count=@sec,confidence_level=@conf,last_updated_at=@now`)

const upsertMap = db.prepare(`
  INSERT INTO casino_entity_map(entity_id,brand_id,source_label,normalized_label,chain,address,mapping_type,is_primary,updated_at)
  VALUES(@entity_id,@brand_id,@source_label,@normalized_label,@chain,@address,@mapping_type,@is_primary,@now)
  ON CONFLICT(entity_id,brand_id) DO UPDATE SET source_label=@source_label,chain=@chain,address=@address,is_primary=@is_primary,updated_at=@now`)

const upsertUnattr = db.prepare(`
  INSERT INTO unattributed_entity_daily_metrics(brand_id,label,chain,date,volume24h,volume7d,net7d,reserves,confidence_level,reason,last_updated_at)
  VALUES(@brand_id,@label,@chain,@date,@volume24h,@volume7d,@net7d,@reserves,'low',@reason,@now)
  ON CONFLICT(brand_id,date) DO UPDATE SET label=@label,chain=@chain,volume24h=@volume24h,volume7d=@volume7d,net7d=@net7d,reserves=@reserves,last_updated_at=@now`)

export async function persistBrandLayer(): Promise<void> {
  const brands = (await aggregateBrands('casino')).filter((b) => b.volume7d > 0 || b.reserves > 0)
  const now = Date.now()
  const date = utcDay(now)
  // Chunked + yielded: persisting all brands (each with member-map upserts) in ONE
  // synchronous transaction held the single write-lock long enough to freeze Node's
  // event loop and starve the read-worker pool. Write in small chunks, handing the
  // loop back between each, so health + heavy reads keep getting time.
  const persistOne = (b: (typeof brands)[number]) => {
    const id = brandKey(b.brand)
    if (b.attributed) {
      const al = resolveAlias(b.brand)
      upsertBrand.run({
        brand_id: id,
        canonical_name: al?.canonical ?? b.brand,
        slug: al?.slug ?? slugify(b.brand),
        website: null,
        category: b.category,
        primary_chain: b.chains?.[0] ?? null,
        is_public: b.confidence === 'low' ? 0 : 1,
        confidence_level: b.confidence,
        source_entity_count: b.wallets,
        now,
      })
      upsertMetrics.run({
        brand_id: id, date,
        volume24h: b.volume24h, volume7d: b.volume7d, inflow7d: b.inflow7d, outflow7d: b.outflow7d, net7d: b.net7d,
        tx: b.txCount7d, acp: b.players, reserves: b.reserves, cov: b.reserveCoverage, trust: b.trust,
        safety: b.safetyIndex, tp: b.trustpilot, rep: b.reputation, cb: JSON.stringify(b.byChain ?? []),
        sec: b.wallets, conf: b.confidence, now,
      })
      const head = (b.members ?? []).slice().sort((x, y) => y.volume7d - x.volume7d)[0]
      for (const m of b.members ?? [])
        upsertMap.run({
          entity_id: m.id, brand_id: id, source_label: m.label, normalized_label: brandKey(m.label),
          chain: m.chain, address: m.address, mapping_type: resolveAlias(m.label) ? 'alias' : 'auto',
          is_primary: m.id === head?.id ? 1 : 0, now,
        })
    } else {
      upsertUnattr.run({
        brand_id: id, label: b.brand, chain: b.chains?.[0] ?? null, date,
        volume24h: b.volume24h, volume7d: b.volume7d, net7d: b.net7d, reserves: b.reserves,
        reason: 'pattern-detected, not attributed to a verified brand', now,
      })
    }
  }
  const CHUNK = 25
  for (let i = 0; i < brands.length; i += CHUNK) {
    const slice = brands.slice(i, i + CHUNK)
    db.transaction(() => slice.forEach(persistOne))()
    await new Promise<void>((r) => setImmediate(r))
  }
  const vc = brands.filter((b) => b.attributed).length
  console.log(`[brandstore] persisted ${vc} verified brands + ${brands.length - vc} unattributed for ${date}`)
}

// Public brand history (non-sensitive aggregate) — for profile trend charts.
export function brandHistory(slug: string, days = 30): { canonical: string; series: any[] } | null {
  const b = db.prepare('SELECT brand_id, canonical_name FROM casino_brand WHERE slug=?').get(slug) as any
  if (!b) return null
  const series = db
    .prepare('SELECT date, volume7d, net7d, reserves, trust_score, confidence_level FROM brand_daily_metrics WHERE brand_id=? ORDER BY date DESC LIMIT ?')
    .all(b.brand_id, days)
  return { canonical: b.canonical_name, series }
}

export function startBrandStore() {
  const run = () => persistBrandLayer().catch((e) => console.warn('[brandstore] failed:', (e as Error).message))
  setTimeout(run, 240_000) // after the aggregate warms
  setInterval(run, 30 * 60_000).unref?.()
  console.log('[brandstore] persistent brand layer active (30-min)')
}
