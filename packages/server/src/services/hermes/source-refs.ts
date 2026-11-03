import { resolve } from 'path'
import { statSync } from 'fs'
import { config } from '../../config'
import { getProfileDir } from './hermes-profile'
import { isNearestExistingRealPathWithin } from './hermes-path'
import type { SourceRef } from '../../db/hermes/session-store'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LOCATOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/
const SENSITIVE = /(?:authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|open[_-]?id)\s*[:=]|(?<![A-Za-z0-9])(?:ou|oc|om|on)_[A-Za-z0-9_-]+|(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{6,}|eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){1,2})/i

function safeText(value: unknown, limit: number): string {
  let text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > limit || text.includes('\0')) return ''
  for (;;) {
    try {
      const decoded = decodeURIComponent(text)
      if (decoded === text) break
      text = decoded
    } catch { break }
  }
  const lower = text.toLowerCase()
  return SENSITIVE.test(text) || lower.startsWith('bearer ') || lower.startsWith('/home/') || lower.startsWith('/users/') || lower.includes('/profiles/') ? '' : text
}

export function normalizeSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return []
  const result: SourceRef[] = []
  const seen = new Set<string>()
  for (const raw of value.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue
    const ref = raw as Record<string, unknown>
    const id = safeText(ref.id, 128)
    const type = typeof ref.type === 'string' ? ref.type : ''
    const label = safeText(ref.label, 256)
    if (!ID.test(id) || seen.has(id) || !label || label.length > 256) continue
    if (type === 'web') {
      try {
        const uri = new URL(String(ref.uri || ''))
        if (uri.protocol !== 'https:' || uri.username || uri.password) continue
        uri.search = ''
        uri.hash = ''
        result.push({ id, type, label, uri: uri.toString() })
      } catch { continue }
    } else if (type === 'workspace') {
      const locator = safeText(ref.locator, 1024)
      if (!locator || locator.startsWith('/') || locator.split('/').some(part => !part || part === '.' || part === '..')) continue
      result.push({ id, type, label, locator })
    } else if ((type === 'lark_doc' || type === 'other') && LOCATOR.test(safeText(ref.locator, 1024))) {
      result.push({ id, type, label, locator: safeText(ref.locator, 1024) })
    } else continue
    seen.add(id)
  }
  return result
}

async function readableWorkspace(profile: string, locator: string): Promise<boolean> {
  const root = resolve(getProfileDir(profile), 'workspace')
  const candidate = resolve(root, locator)
  try {
    return await isNearestExistingRealPathWithin(candidate, root) && statSync(candidate).isFile()
  } catch {
    return false
  }
}

export async function authorizeSourceRefs(args: {
  profile: string
  ownerOpenId: string
  messages: Array<{ id: number | string; run_id?: string | null; role: string; source_refs?: SourceRef[] | null }>
}): Promise<Map<string, Array<SourceRef & { open_path?: string }>>> {
  const authorized = new Map<string, Array<SourceRef & { open_path?: string }>>()
  const privateRefs: Array<SourceRef & { requestId: string; messageId: string }> = []
  for (const message of args.messages) {
    if (message.role !== 'assistant' || !message.run_id) continue
    const messageId = String(message.id)
    for (const ref of normalizeSourceRefs(message.source_refs)) {
      if (ref.type === 'web') {
        authorized.set(messageId, [...(authorized.get(messageId) || []), ref])
      } else if (ref.type === 'workspace' && ref.locator && await readableWorkspace(args.profile, ref.locator)) {
        authorized.set(messageId, [...(authorized.get(messageId) || []), {
          id: ref.id, type: ref.type, label: ref.label, open_path: `/workspace/${ref.locator}`,
        }])
      } else if (ref.type === 'lark_doc' && ref.locator) {
        privateRefs.push({ ...ref, id: `${messageId}:${ref.id}`, requestId: ref.id, messageId })
      }
    }
  }
  const privateTargets = await authorizePrivateTargets(args.profile, args.ownerOpenId, privateRefs)
  for (const ref of privateRefs) {
    if (!privateTargets.has(ref.id)) continue
    authorized.set(ref.messageId, [...(authorized.get(ref.messageId) || []), {
      id: ref.requestId,
      type: 'lark_doc',
      label: ref.label,
        open_path: `/api/hermes/sessions/source-refs/${encodeURIComponent(String(args.messages.find(message => String(message.id) === ref.messageId)?.run_id || ''))}/${encodeURIComponent(ref.requestId)}/open`,
    }])
  }
  return authorized
}

export async function authorizePrivateTargets(
  profile: string,
  ownerOpenId: string,
  refs: SourceRef[],
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  if (!refs.length || !config.runBrokerUrl || !config.runBrokerKey || !ownerOpenId) return targets
  try {
    const response = await fetch(`${config.runBrokerUrl}/api/run-broker/source-refs/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.runBrokerKey}`,
        'Content-Type': 'application/json',
        'X-Hermes-Owner-Open-Id': ownerOpenId,
      },
      body: JSON.stringify({ profile_name: profile, refs }),
    })
    if (!response.ok) return targets
    const payload = await response.json() as { refs?: Array<{ id?: string; target?: string }> }
    for (const ref of payload.refs || []) {
      const id = String(ref.id || '')
      const target = String(ref.target || '')
      try {
        const url = new URL(target)
        if (id && url.protocol === 'https:' && !url.username && !url.password) targets.set(id, target)
      } catch { /* omit malformed target */ }
    }
  } catch { /* dependency unavailable: omit private refs */ }
  return targets
}
