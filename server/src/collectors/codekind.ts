import { db } from '../db.ts'
import { rpc as ethRpc } from './evm.ts'
import { evmChainByKey } from './evmchains.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Classifies watched EVM addresses as EOA or contract via eth_getCode.
//
// Why this exists: on 2026-08-01, once native and wrapped assets started being
// counted, 73.7% of the casino-category ETH reserve total turned out to sit at
// CONTRACT addresses — Gemini custody contracts and a Uniswap V3 pool booked as a
// casino's reserves. Those two were corrected directly, but the general lesson is
// that "is this a contract?" is a cheap, objective signal we were not recording.
//
// It is a LABEL, not a filter. Some on-chain casinos (PowH3D, Fomo3D) genuinely
// custody player funds in a contract, so excluding contracts wholesale would delete
// real reserves. Recording the kind lets the split be shown and audited instead.
//
// Runs independently of refreshBalances() on purpose: reserve figures must never
// depend on this job succeeding.
// ─────────────────────────────────────────────────────────────────────────────

const RECHECK_MS = Number(process.env.CODEKIND_RECHECK_MS ?? 30 * 86_400_000) // bytecode is ~immutable
const BATCH = Number(process.env.CODEKIND_BATCH ?? 60)
const PACE_MS = Number(process.env.CODEKIND_PACE_MS ?? 250)

// EVM chains only — Tron/Solana/UTXO have different account models, so their value is
// "not applicable" to this classifier rather than "not yet classified". Callers use
// this to avoid reporting a permanently-unclassifiable chain as an audit gap.
export function isEvmChain(chain: string): boolean {
  return chain === 'ETH' || evmChainByKey.has(chain)
}

const upsert = db.prepare(
  `INSERT INTO wallet_code_kind(chain, address, is_contract, checked_at) VALUES(?,?,?,?)
   ON CONFLICT(chain, address) DO UPDATE SET is_contract=excluded.is_contract, checked_at=excluded.checked_at`,
)

function evmChains(): string[] {
  return ['ETH', ...evmChainByKey.keys()]
}

async function getCode(chain: string, address: string): Promise<string | null> {
  try {
    if (chain === 'ETH') return await ethRpc('eth_getCode', [address, 'latest'])
    const c = evmChainByKey.get(chain)
    return c ? await c.rpc('eth_getCode', [address, 'latest']) : null
  } catch {
    return null // transient RPC failure — leave unclassified, retry next pass
  }
}

let running = false
export async function refreshCodeKinds(): Promise<void> {
  if (running) return
  running = true
  try {
    const chains = evmChains()
    const rows = db
      .prepare(
        // Driven off wallet_chain_balances, not watchlist, so it covers exactly the
        // rows the reserve split reports — including the fan-out chains (Base et al.)
        // where a mainnet-listed address holds value but has no watchlist row.
        // Biggest balances first: the point is to show where the money is, so the
        // audit is only useful once the top holders are classified. Insertion order
        // spent the first passes on dust while $224M of ETH sat unclassified.
        `SELECT b.chain, b.address
           FROM wallet_chain_balances b
           LEFT JOIN wallet_code_kind k ON k.chain=b.chain AND k.address=b.address
          WHERE b.chain IN (${chains.map(() => '?').join(',')})
            AND (k.checked_at IS NULL OR k.checked_at < ?)
            AND EXISTS (
                  SELECT 1 FROM watchlist w
                   WHERE w.address=b.address AND w.active=1 AND w.category='casino'
                )
          ORDER BY k.checked_at IS NOT NULL, b.usd DESC
          LIMIT ?`,
      )
      .all(...chains, Date.now() - RECHECK_MS, BATCH) as { chain: string; address: string }[]
    if (rows.length === 0) return
    let done = 0
    for (const r of rows) {
      const code = await getCode(r.chain, r.address)
      if (code != null) {
        upsert.run(r.chain, r.address, code !== '0x' && code !== '' ? 1 : 0, Date.now())
        done++
      }
      await new Promise((res) => setTimeout(res, PACE_MS))
    }
    if (done) console.log(`[codekind] classified ${done} address(es)`)
  } finally {
    running = false
  }
}

export function startCodeKinds() {
  setTimeout(() => refreshCodeKinds().catch(() => {}), 45_000) // let boot settle first
  setInterval(() => refreshCodeKinds().catch(() => {}), 5 * 60_000)
}
