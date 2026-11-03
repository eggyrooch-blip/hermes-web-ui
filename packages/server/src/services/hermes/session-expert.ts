import type { HermesSessionRow } from '../../db/hermes/session-store'
import { createSession, updateSession } from '../../db/hermes/session-store'
import { fetchExpertCatalog } from './expert-registry-client'
import { logger } from '../logger'

export class SessionExpertError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export async function persistSessionExpert(options: {
  id: string
  existing: HermesSessionRow | null
  owner: string
  profile: string
  expertId: string | null
  executionEngine: 'hermes' | 'harness'
}): Promise<string | null> {
  const { id, existing, owner, profile, expertId, executionEngine } = options
  if (existing && String(existing.user_id || '').trim() !== owner) {
    throw new SessionExpertError('Only the session owner can change its expert', 403)
  }
  const existingEngine = existing?.execution_engine === 'harness' ? 'harness' : 'hermes'
  if (existing && existing.message_count > 0 && (
    (existing.expert_id || null) !== expertId || existingEngine !== executionEngine
  )) {
    throw new SessionExpertError('Expert is fixed once the session has messages', 409)
  }
  if (expertId && (existing?.source === 'coding_agent' || existing?.source === 'global_agent')) {
    throw new SessionExpertError('Expert is not available for this session type', 400)
  }
  if (!expertId) {
    if (existing) {
      updateSession(id, {
        expert_id: null,
        expert_label: null,
        expert_avatar: null,
        execution_engine: 'hermes',
      })
    }
    return null
  }

  let catalog: Awaited<ReturnType<typeof fetchExpertCatalog>>
  try {
    catalog = await fetchExpertCatalog({ profileName: profile, userKey: owner })
  } catch (err) {
    logger.warn({ err, profile }, '[session-expert] failed to verify session expert')
    throw new SessionExpertError('Expert catalog is unavailable', 503)
  }
  if (catalog.profile_name !== profile) {
    throw new SessionExpertError('Expert catalog profile mismatch', 503)
  }
  const matches = catalog.experts.filter(entry => entry.id === expertId)
  if (matches.length !== 1) {
    throw new SessionExpertError('Expert is unavailable for this profile', 404)
  }
  const expert = matches[0]
  const values = {
    expert_id: expert.id,
    expert_label: expert.title || expert.name || expert.id,
    expert_avatar: expert.avatar || null,
    execution_engine: executionEngine,
  } as const
  if (existing) {
    updateSession(id, values)
  } else {
    createSession({
      id,
      profile,
      source: 'cli',
      user_id: owner,
      title: '',
      ...values,
    })
  }
  return expert.id
}
