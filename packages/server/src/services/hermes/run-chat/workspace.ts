import { lstat, mkdir, realpath } from 'fs/promises'
import { existsSync } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import { getProfileDir } from '../hermes-profile'
import { isNearestExistingRealPathWithin } from '../hermes-path'

export function defaultHermesWorkspace(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'workspace')
}

function within(target: string, base: string): boolean {
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return target === base || target.startsWith(prefix)
}

async function resolvedOr(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The workspace root is the boundary every other check is measured against, so it
 * cannot be allowed to vouch for itself: if `<profile>/workspace` is a symlink out
 * of the profile, both sides of a realpath comparison resolve to the target and any
 * path "inside" it passes. Anchor on the profile dir (deployment-owned) instead and
 * fail closed if the root has been swapped for an escaping link or a non-directory.
 */
async function assertWorkspaceRootSafe(profile: string, base: string): Promise<void> {
  const stats = await lstat(base).catch(() => null)
  if (!stats) return // absent → mkdir creates a real directory under the profile
  if (stats.isSymbolicLink()) {
    const trustedRoot = await resolvedOr(getProfileDir(profile || 'default'))
    if (!within(await resolvedOr(base), trustedRoot)) {
      throw new Error(`Refusing to run: workspace root ${base} links outside the profile`)
    }
    return
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to run: workspace root ${base} is not a directory`)
  }
}

/**
 * Resolve the directory a run is allowed to work in.
 *
 * This is the single read point every run path funnels through (chat, bridge and
 * broker runs alike), so containment lives HERE rather than in each caller — a
 * stored session.workspace is attacker-controlled (the setWorkspace endpoint
 * persists any string), and callers have historically trusted it verbatim.
 * Anything resolving outside the profile's own workspace falls back to it.
 */
export async function ensureHermesRunWorkspace(profile: string, workspace?: string | null): Promise<string> {
  // Unresolved on purpose: this is the namespace callers and the DB speak in, and
  // comparing a raw candidate against a realpath'd base would reject every legit
  // path under a symlinked deployment root. realpath is used only where it is the
  // actual question — whether a link escapes the profile.
  const base = defaultHermesWorkspace(profile)
  await assertWorkspaceRootSafe(profile, base)

  const raw = String(workspace || '').trim()
  const candidate = !raw
    ? base
    : isAbsolute(raw) ? resolve(raw) : resolve(base, raw)

  // Two independent checks, on purpose: the lexical one rejects traversal without
  // touching the disk, the realpath one additionally catches symlinks pointing out
  // of the workspace (it resolves both sides, so it is symlink-root safe).
  const contained = within(candidate, base)
    && await isNearestExistingRealPathWithin(candidate, base)
  // A dangling symlink reads as "absent" to the realpath check (existsSync follows
  // the link), so that check clears it via an ancestor and mkdir would then ENOENT
  // the whole run. Fall back instead of dying.
  const dangling = await lstat(candidate)
    .then(s => s.isSymbolicLink() && !existsSync(candidate))
    .catch(() => false)

  // Checks run BEFORE mkdir so an out-of-bounds path is never created as a side effect.
  const target = contained && !dangling ? candidate : base
  await mkdir(target, { recursive: true })

  // The path could have been swapped between check and mkdir; re-resolve what now
  // exists. Not a complete TOCTOU defence (see SPEC), but it closes the window where
  // a run would launch against a post-check replacement.
  if (!within(await resolvedOr(target), await resolvedOr(base))) {
    throw new Error(`Refusing to run: workspace ${target} escaped the profile after creation`)
  }
  return target
}
