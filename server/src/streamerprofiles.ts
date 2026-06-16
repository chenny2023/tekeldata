import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Curated streamer profiles (bio + social links) from a research export. Static —
// loaded once into memory and joined with live status from the streamers table on
// the detail endpoint. Streamers without a curated profile still get a detail view
// from their live stats alone (graceful).
export interface StreamerProfile {
  platform: string
  slug: string
  name: string
  followers: number
  content: string | null
  language: string | null
  bio: string | null
  telegram: string | null
  discord: string | null
  twitter: string | null
  instagram: string | null
  youtube: string | null
}

const profiles = new Map<string, StreamerProfile>()
try {
  const path = fileURLToPath(new URL('./data/streamer-profiles.json', import.meta.url))
  const arr = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as StreamerProfile[] // strip BOM
  for (const p of arr) profiles.set(`${p.platform.toLowerCase()}:${p.slug.toLowerCase()}`, p)
  console.log(`[profiles] loaded ${profiles.size} curated streamer profiles`)
} catch (e) {
  console.warn('[profiles] none loaded:', (e as Error).message)
}

export function getProfile(platform: string, slug: string): StreamerProfile | null {
  return profiles.get(`${(platform || '').toLowerCase()}:${(slug || '').toLowerCase()}`) ?? null
}
