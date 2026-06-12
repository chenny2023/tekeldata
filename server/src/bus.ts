// Tiny in-process event bus to push newly-indexed transfers to SSE clients.
import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
bus.setMaxListeners(0)

export interface TransferEvent {
  chain: string
  tx_hash: string
  token: string
  from_addr: string
  to_addr: string
  counterparty: string
  amount: number
  usd: number
  watch_id: number
  label: string
  category: string
  direction: string
  block: number
  ts: number
}

export function emitTransfer(t: TransferEvent) {
  bus.emit('transfer', t)
}
