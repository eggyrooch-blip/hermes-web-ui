import { fetchSkillCredentials } from '@/api/skillCredentials'
import type { SkillCredentialsResponse } from '@/api/skillCredentials'

// Shared localStorage cache for connector status, used by both the connectors panel
// (instant render — paint last-known immediately) and the background pre-warm (so the
// FIRST open of the panel this session is also instant). Status only, no secrets — the
// broker already redacts tokens. Every localStorage access is guarded: private mode /
// quota simply falls back to a normal load.
//
// 版本写在 key 里，不写在值里：改了 entry 的形状就 bump 一次，旧条目自然读不到，
// 不需要迁移逻辑。v1 → v2 的原因：action 由「必有，无操作时是 {kind:'manual',label:''}」
// 改为「无操作时整个缺省」。旧缓存若被新 UI 读到，会把那个空壳当成有 action，
// 让「GitLab（全局）」冒出一颗「连接」按钮，且在刷新失败时一直留着（codex 评审 2026-08-04）。
const STATUS_CACHE_VERSION = 'v2'
const STATUS_CACHE_PREFIX = `hermes:connector-status:${STATUS_CACHE_VERSION}:`
const STATUS_CACHE_LEGACY_PREFIXES = ['hermes:connector-status:']

export function connectorStatusCacheKey(profile: string): string {
  return STATUS_CACHE_PREFIX + (profile || '_active')
}

/** 顺手清掉上一版留下的条目 —— 否则每 bump 一次就多一批永远读不到的垃圾。 */
function dropLegacyCacheEntries(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key || key.startsWith(STATUS_CACHE_PREFIX)) continue
      if (STATUS_CACHE_LEGACY_PREFIXES.some(prefix => key.startsWith(prefix))) {
        localStorage.removeItem(key)
      }
    }
  } catch { /* unavailable — nothing to clean */ }
}

export function readCachedConnectorStatus(profile: string): SkillCredentialsResponse | null {
  try {
    dropLegacyCacheEntries()
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
