// ─────────────────────────────────────────────────────────────────────────────
// QA / risk filter for AI-generated content. The site's credibility depends on
// this: no fabricated numbers, no off-whitelist brands, no forbidden risk words,
// required links/notes present. A high-risk result is auto-skipped (never posted).
// ─────────────────────────────────────────────────────────────────────────────

// neutral-language guard — these must never appear (consistent with dataquality.ts)
const FORBIDDEN = /\b(scam|fraud|insolvent|rug ?pull|money laundering|illegal|criminal|fake|bankrupt|running away|collapse|exit scam)\b/i

export interface QaInput {
  allowedBrands: string[] // brand names present in the snapshot input
  allowedValues: string[] // every formatted figure we handed the model (e.g. "$1.4B", "12.3%")
  requiredUrl?: string // a tweet/post must link here
}

export interface QaResult {
  pass: boolean
  riskLevel: 'low' | 'medium' | 'high'
  failures: string[]
}

// pull out data-like number tokens ($X, X%, 1.2M/B/K, big plain numbers). URLs and
// ISO dates are stripped first so a date/year (e.g. 2026-06-17) isn't mistaken for a
// data figure, and standalone years are ignored.
function dataNumbers(text: string): string[] {
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
  const out: string[] = []
  const re = /\$?\d[\d,]*\.?\d*\s?(?:[KMB]\b|%|billion|million)?/gi
  for (const m of clean.matchAll(re)) {
    const tok = m[0].trim()
    if (/^(19|20)\d{2}$/.test(tok)) continue // a bare year is not a data value
    const hasUnit = /[$%KMB]|billion|million/i.test(tok)
    const big = Number(tok.replace(/[^0-9.]/g, '')) >= 1000
    if (hasUnit || big) out.push(tok.replace(/\s+/g, ''))
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[\s,]/g, '')

export function qaCheck(output: any, input: QaInput): QaResult {
  const failures: string[] = []
  let risk: 'low' | 'medium' | 'high' = (['low', 'medium', 'high'].includes(output?.risk_level) ? output.risk_level : 'low')

  // 1. collect every piece of generated text
  const texts: string[] = []
  const push = (v: any) => typeof v === 'string' && v.trim() && texts.push(v)
  push(output?.post_text)
  for (const t of output?.tweets ?? []) push(t?.text)
  push(output?.image?.title)
  push(output?.image?.subtitle)
  push(output?.image?.footer)
  for (const r of output?.image?.rows ?? []) push(r?.value)
  for (const n of output?.data_notes ?? []) push(n)
  // daily-report insight schema (Today's Market Read + Notable Signals)
  if (output?.market_read) {
    push(output.market_read.what_changed)
    push(output.market_read.why_it_matters)
    push(output.market_read.what_to_watch)
  }
  for (const sig of output?.notable_signals ?? []) push(sig)
  if (!texts.length) {
    failures.push('empty: no usable text produced')
    return { pass: false, riskLevel: 'high', failures }
  }
  const allText = texts.join('  ')

  // 2. forbidden risk words → hard fail
  const fw = allText.replace(/<[^>]+>/g, ' ').match(FORBIDDEN)
  if (fw) {
    failures.push(`forbidden word: "${fw[0]}"`)
    risk = 'high'
  }

  // 3. number consistency — every data figure must be one we provided (no inventing)
  const allowed = new Set(input.allowedValues.map(norm))
  for (const tok of dataNumbers(allText)) {
    const n = norm(tok)
    // accept exact, or matches an allowed value ignoring a leading $ / trailing unit variance
    const ok = allowed.has(n) || [...allowed].some((a) => a.includes(n) || n.includes(a))
    if (!ok) {
      failures.push(`unverified number: "${tok}"`)
      risk = 'high'
    }
  }

  // 4. brand whitelist for structured rows (image cards)
  const allowedB = new Set(input.allowedBrands.map((b) => b.toLowerCase()))
  for (const r of output?.image?.rows ?? []) {
    if (r?.brand && !allowedB.has(String(r.brand).toLowerCase())) {
      failures.push(`off-whitelist brand: "${r.brand}"`)
      risk = 'high'
    }
  }

  // 5. required report/ranking link present
  if (input.requiredUrl) {
    const linked = allText.includes(input.requiredUrl) || (output?.links ?? []).some((l: string) => String(l).includes(input.requiredUrl!)) || String(output?.target_url ?? '').includes(input.requiredUrl)
    if (!linked) {
      failures.push('missing required link')
      if (risk === 'low') risk = 'medium'
    }
  }

  // pass only when no failures and self-reported risk isn't high
  const pass = failures.length === 0 && risk !== 'high'
  return { pass, riskLevel: risk, failures }
}
