import { createHash } from 'node:crypto'

// Tron base58check address ↔ 20-byte EVM hex conversion (zero-dependency).
// Tron addresses are base58check( 0x41 ++ 20-byte-evm-address ).

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE = 58n

function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest()
}

/** TWd4… → lowercase 20-byte hex without 0x (throws on malformed input) */
export function b58ToHex20(addr: string): string {
  let n = 0n
  for (const c of addr) {
    const i = ALPHABET.indexOf(c)
    if (i < 0) throw new Error(`invalid base58 char in ${addr}`)
    n = n * BASE + BigInt(i)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const raw = Buffer.from(hex.padStart(50, '0'), 'hex') // 25 bytes: 41 + 20 + 4
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error(`not a Tron address: ${addr}`)
  return raw.subarray(1, 21).toString('hex')
}

/** 20-byte hex (with or without 0x) → T… base58check address */
export function hex20ToB58(hex: string): string {
  const clean = hex.replace(/^0x/, '').padStart(40, '0').slice(-40)
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(clean, 'hex')])
  const checksum = sha256(sha256(payload)).subarray(0, 4)
  const full = Buffer.concat([payload, checksum])
  let n = BigInt('0x' + full.toString('hex'))
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out
    n /= BASE
  }
  // leading zero bytes → leading '1's (cannot occur for 0x41-prefixed payloads, kept for correctness)
  for (const b of full) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}
