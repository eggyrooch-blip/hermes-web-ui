import { mkdir } from 'fs/promises'
import { isAbsolute, join, resolve, sep } from 'path'
import { getProfileDir } from '../hermes-profile'
import { isNearestExistingRealPathWithin } from '../hermes-path'

export function defaultHermesWorkspace(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'workspace')
}

/**
 * Resolve the directory a run is allowed to work in.
 *
 * This is the single read point every run path funnels through (chat runs and
 * broker runs alike), so containment lives HERE rather than in each caller —
 * a stored session.workspace is attacker-controlled (the setWorkspace endpoint
 * persists any string), and callers have historically trusted it verbatim.
 * Anything resolving outside the profile's own workspace falls back to it.
 */
export async function ensureHermesRunWorkspace(profile: string, workspace?: string | null): Promise<string> {
  const base = defaultHermesWorkspace(profile)
  const raw = String(workspace || '').trim()
  const candidate = !raw
    ? base
    : isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  // Two independent checks, on purpose: the lexical one rejects traversal without
  // touching the disk, the realpath one additionally catches symlinks pointing out
  // of the workspace. Neither is redundant — keep both. Both run BEFORE mkdir so an
  // out-of-bounds path is never created as a side effect.
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  const contained = (candidate === base || candidate.startsWith(prefix))
    && await isNearestExistingRealPathWithin(candidate, base)
  const target = contained ? candidate : base
  await mkdir(target, { recursive: true })
  return target
}
