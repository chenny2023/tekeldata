// ─────────────────────────────────────────────────────────────────────────────
// Branded ranking card renderer (SVG → PNG). The data (brands + values) comes
// straight from the snapshot, so figures are EXACT — never AI-rendered (an image
// model would garble numbers, which would wreck the site's data credibility).
// sharp is imported lazily + guarded, so a missing native binary degrades to a
// text-only post instead of crashing the pipeline.
// ─────────────────────────────────────────────────────────────────────────────

export interface CardRow {
  rank: number
  brand: string
  value: string
}
export interface CardData {
  title: string
  subtitle?: string
  rows: CardRow[]
  footer?: string
  date?: string
}

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// the brand coin mark, scaled into the SVG
const coin = (x: number, y: number, s: number) => `<g transform="translate(${x},${y}) scale(${s / 64})">
  <circle cx="32" cy="32" r="30" fill="url(#g)" stroke="#8A5A00" stroke-width="2"/>
  <circle cx="32" cy="32" r="23" fill="none" stroke="#FFF2C2" stroke-width="2" opacity="0.7"/>
  <path d="M16 22 L23 44 L29 30 L32 38 L35 30 L41 44 L48 22" fill="none" stroke="#5A3B00" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></g>`

function buildSvg(d: CardData): string {
  const W = 1080,
    H = 1080
  const rows = d.rows.slice(0, 6)
  const rowH = 96
  const top = 360
  const rowSvg = rows
    .map((r, i) => {
      const y = top + i * rowH
      return `
    <g transform="translate(80,${y})">
      <rect width="920" height="78" rx="16" fill="#ffffff06" stroke="#ffffff12"/>
      <circle cx="46" cy="39" r="22" fill="#F5B10018" stroke="#F5B10040"/>
      <text x="46" y="48" font-size="26" font-weight="700" fill="#F5B100" text-anchor="middle">${r.rank}</text>
      <text x="92" y="49" font-size="32" font-weight="600" fill="#F2F3F7">${esc(r.brand)}</text>
      <text x="900" y="49" font-size="32" font-weight="700" fill="#FFD66B" text-anchor="end">${esc(r.value)}</text>
    </g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="0.5" stop-color="#F5B100"/><stop offset="1" stop-color="#C8860A"/></linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0C0C0C"/><stop offset="1" stop-color="#0d0d16"/></linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.7"><stop offset="0" stop-color="#F5B100" stop-opacity="0.14"/><stop offset="1" stop-color="#F5B100" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${coin(80, 72, 84)}
  <text x="184" y="128" font-size="44" font-weight="800" fill="#FFFFFF" letter-spacing="1">Tekel Data<tspan fill="#F5B100">.CASINO</tspan></text>
  <text x="186" y="166" font-size="22" font-weight="500" fill="#8a8f9f">On-chain intelligence for crypto casinos</text>
  <text x="80" y="262" font-size="52" font-weight="800" fill="#FFFFFF">${esc(d.title)}</text>
  ${d.subtitle ? `<text x="80" y="312" font-size="28" font-weight="500" fill="#aab0c0">${esc(d.subtitle)}</text>` : ''}
  ${rowSvg}
  <line x1="80" y1="980" x2="1000" y2="980" stroke="#ffffff12"/>
  <text x="80" y="1026" font-size="24" font-weight="600" fill="#9aa0b4">${esc(d.footer || 'No paid rankings — public, verifiable data')}</text>
  <text x="1000" y="1026" font-size="24" font-weight="700" fill="#F5B100" text-anchor="end">tekeldata.com${d.date ? `  ·  ${esc(d.date)}` : ''}</text>
  <rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="2" fill="none" stroke="#F5B10022" stroke-width="2"/>
</svg>`
}

export async function renderRankingCard(d: CardData): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import('sharp')
    return await sharp(Buffer.from(buildSvg(d))).png().toBuffer()
  } catch (e) {
    console.warn('[content] card render failed (will post text-only):', (e as Error).message)
    return null
  }
}

// ── Daily share / OG card (1200×630) — the day's headline verified figures ───────
export interface DailyCardData {
  date: string
  stats: { label: string; value: string }[] // up to 4 headline figures
  topChain?: string
}
function buildDailySvg(d: DailyCardData): string {
  const W = 1200,
    H = 630
  const tiles = d.stats.slice(0, 4)
  const startX = 60,
    gap = 22,
    tileW = Math.floor((W - startX * 2 - gap * (tiles.length - 1)) / Math.max(1, tiles.length)),
    tileY = 326,
    tileH = 188
  const tileSvg = tiles
    .map((t, i) => {
      const x = startX + i * (tileW + gap)
      return `
    <g transform="translate(${x},${tileY})">
      <rect width="${tileW}" height="${tileH}" rx="18" fill="#ffffff06" stroke="#ffffff12"/>
      <text x="26" y="48" font-size="20" font-weight="600" fill="#8a8f9f" letter-spacing="1">${esc(t.label.toUpperCase())}</text>
      <text x="26" y="120" font-size="42" font-weight="800" fill="#FFD66B">${esc(t.value)}</text>
    </g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="0.5" stop-color="#F5B100"/><stop offset="1" stop-color="#C8860A"/></linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0C0C0C"/><stop offset="1" stop-color="#0d0d16"/></linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.08" r="0.7"><stop offset="0" stop-color="#F5B100" stop-opacity="0.16"/><stop offset="1" stop-color="#F5B100" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow2" cx="0.1" cy="1" r="0.7"><stop offset="0" stop-color="#8b3df0" stop-opacity="0.14"/><stop offset="1" stop-color="#8b3df0" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>
  ${coin(60, 54, 72)}
  <text x="150" y="92" font-size="38" font-weight="800" fill="#FFFFFF" letter-spacing="1">Tekel Data<tspan fill="#F5B100">.CASINO</tspan></text>
  <text x="152" y="124" font-size="19" font-weight="500" fill="#8a8f9f">On-chain intelligence for crypto casinos</text>
  <text x="60" y="218" font-size="56" font-weight="800" fill="#FFFFFF">Crypto Casino Market — Daily</text>
  <text x="60" y="266" font-size="26" font-weight="500" fill="#aab0c0">Verified on-chain snapshot · ${esc(d.date)} (UTC)${d.topChain ? `  ·  ${esc(d.topChain)} leads chain volume` : ''}</text>
  ${tileSvg}
  <line x1="60" y1="566" x2="1140" y2="566" stroke="#ffffff12"/>
  <text x="60" y="606" font-size="22" font-weight="600" fill="#9aa0b4">Verified flow only · unattributed flow excluded</text>
  <text x="1140" y="606" font-size="22" font-weight="700" fill="#F5B100" text-anchor="end">tekeldata.com/daily</text>
  <rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="2" fill="none" stroke="#F5B10022" stroke-width="2"/>
</svg>`
}
export async function renderDailyShareCard(d: DailyCardData): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import('sharp')
    return await sharp(Buffer.from(buildDailySvg(d))).png().toBuffer()
  } catch (e) {
    console.warn('[share] daily card render failed:', (e as Error).message)
    return null
  }
}
