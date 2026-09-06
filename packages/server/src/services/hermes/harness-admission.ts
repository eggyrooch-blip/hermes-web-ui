import { readFileSync } from 'node:fs'

export function isHarnessEnabledForProfile(profile: string): boolean {
  if (process.env.HERMES_WEBUI_HARNESS_ENABLED !== '1') return false
  const name = String(profile || '').trim()
  const revision = String(process.env.HERMES_WEBUI_HARNESS_SOURCE_REV || '').trim().toLowerCase()
  const readyFile = String(process.env.HERMES_WEBUI_HARNESS_READY_FILE || '').trim()
  if (!name || !/^[0-9a-f]{40}$/.test(revision) || !readyFile) return false
  try {
    if (readFileSync(readyFile, 'utf8').trim().toLowerCase() !== revision) return false
  } catch {
    return false
  }
  return true
}
