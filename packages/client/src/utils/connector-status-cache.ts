import { fetchSkillCredentials } from '@/api/skillCredentials'
import type { SkillCredentialsResponse } from '@/api/skillCredentials'

// Shared localStorage cache for connector status, used by both the connectors panel
// (instant render — paint last-known immediately) and the background pre-warm (so the
// FIRST open of the panel this session is also instant). Status only, no secrets — the
// broker already redacts tokens. Every localStorage access is guarded: private mode /
// quota simply falls back to a normal load.
const STATUS_CACHE_PREFIX = 'hermes:connector-status:'

export function connectorStatusCacheKey(profile: string): string {
  return STATUS_CACHE_PREFIX + (profile || '_active')
}

export function readCachedConnectorStatus(profile: string): SkillCredentialsResponse | null {
  try {
    const raw = localStorage.getItem(connectorStatusCacheKey(profile))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.credentials)) return parsed as SkillCredentialsResponse
  } catch { /* unavailable — fall back to a normal load */ }
  return null
}

export function writeCachedConnectorStatus(profile: string, data: SkillCredentialsResponse | null): void {
  try {
    if (data) localStorage.setItem(connectorStatusCacheKey(profile), JSON.stringify(data))
  } catch { /* unavailable — skip persistence */ }
}

let lastPrewarmed = ''

// Fire-and-forget: warm the connector-status cache for `profile` in the background so the
// FIRST open of the connectors panel paints instantly (no cold ~2s wait on the 5 live CLI
// checks). Safe to call on app init and profile switch; dedupes consecutive same-profile
// calls and never throws.
export function prewarmConnectorStatus(profile: string | null | undefined): void {
  const name = (profile || '').trim()
  if (!name || name === lastPrewarmed) return
  lastPrewarmed = name
  void fetchSkillCredentials(name)
    .then(data => writeCachedConnectorStatus(name, data))
    .catch(() => { lastPrewarmed = '' /* allow a retry on the next trigger */ })
}
