export function fmtUsd(n: number, compact = true): string {
  if (n == null || isNaN(n)) return '$0'
  if (compact) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
    return '$' + n.toFixed(n < 100 ? 2 : 0)
  }
  return '$' + Math.round(n).toLocaleString('en-US')
}

export function fmtNum(n: number): string {
  if (n == null || isNaN(n)) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return s + 's ago'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

export function shortHash(h: string, n = 6): string {
  if (!h) return ''
  if (h.length <= n * 2 + 2) return h
  return h.slice(0, h.startsWith('0x') ? n + 2 : n) + '…' + h.slice(-4)
}

export const CHAIN_COLOR: Record<string, string> = {
  ETH: '#8b3df0',
  TRON: '#F2C200',
  TRX: '#F2C200',
  BSC: '#f0b90b',
  BASE: '#0052ff',
  ARB: '#28a0f0',
  OP: '#ff0420',
  POLYGON: '#8247e5',
  MATIC: '#8247e5',
  AVAX: '#e84142',
  SEI: '#2ee6a6',
  BTC: '#f7931a',
  SOL: '#14f195',
  XRP: '#4aa3df',
  LTC: '#b8b8b8',
}
