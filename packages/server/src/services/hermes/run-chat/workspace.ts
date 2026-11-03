import { lstat, mkdir, realpath, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { getProfileDir } from '../hermes-profile'
import { isNearestExistingRealPathWithin } from '../hermes-path'

export function defaultHermesWorkspace(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'workspace')
}

function within(target: string, base: string): boolean {
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return target === base || target.startsWith(prefix)
}

/**
 * The workspace root is the boundary every other check is measured against, so it
 * must be a real directory the deployment created — never a symlink. A symlinked
 * root can't vouch for itself (a realpath comparison would resolve both sides to the
 * link target), a link into the profile root would widen the run to the whole profile
 * incl. credentials, and a dangling link would ENOENT the run at mkdir. Deployments
 * create these as plain directories, so reject any symlink root outright and
 * fail closed on a non-directory.
 */
async function assertWorkspaceRootSafe(base: string): Promise<void> {
  const stats = await lstat(base).catch(() => null)
  if (!stats) return // absent → mkdir creates a real directory under the profile
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to run: workspace root ${base} is a symlink`)
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
 * stored session.workspace must still be treated as attacker-controlled (legacy
 * rows predate validation), and callers have historically trusted it verbatim.
 * Anything explicitly selected must already be a real directory within the
 * profile workspace. Invalid stored/request values fail closed before dispatch.
 */
export async function ensureHermesRunWorkspace(profile: string, workspace?: string | null): Promise<string> {
  // Unresolved on purpose: this is the namespace callers and the DB speak in, and
  // comparing a raw candidate against a realpath'd base would reject every legit
  // path under a symlinked deployment root. realpath is used only where it is the
  // actual question — whether a link escapes the profile.
  const base = defaultHermesWorkspace(profile)
  await assertWorkspaceRootSafe(base)

  const raw = String(workspace || '').trim()
  if (!raw) {
    await mkdir(base, { recursive: true })
    return base
  }
  if (raw.includes('\0') || raw.includes('\\') || raw.split('/').includes('..')) {
    throw new Error('Invalid workspace')
  }

  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)

  // Two independent checks, on purpose: the lexical one rejects traversal without
  // touching the disk, the realpath one additionally catches symlinks pointing out
  // of the workspace (it resolves both sides, so it is symlink-root safe).
  const contained = within(candidate, base)
    && await isNearestExistingRealPathWithin(candidate, base)
  const directory = await stat(candidate).then(value => value.isDirectory()).catch(() => false)
  if (!contained || !directory) throw new Error('Invalid workspace')

  // Re-resolve immediately before dispatch so a symlink replacement does not turn a
  // previously valid lexical path into a cross-profile cwd.
  if (!within(await realpath(candidate), await realpath(base))) throw new Error('Invalid workspace')
  return candidate
}

export async function normalizeHermesSessionWorkspace(profile: string, workspace?: string | null): Promise<string | null> {
  const target = await ensureHermesRunWorkspace(profile, workspace)
  const normalized = relative(defaultHermesWorkspace(profile), target)
  return normalized ? normalized.split(sep).join('/') : null
}

/**
 * Same normalization, but for a value READ BACK from `sessions.workspace` rather
 * than one a user just picked. Those two are not the same trust question: an
 * explicit selection must fail closed, while a stored row may predate validation
 * entirely (the old endpoint persisted any string, the old admin picker handed out
 * absolute host paths) or may simply point at a directory that has since been
 * deleted. Failing those closed would strand the session — no run, and a 500 on
 * every model switch — for a value the user never chose in this UI. Falling back
 * to null means the run uses the profile workspace root, exactly as it did before
 * this feature existed; callers persist the null and the stale binding disappears.
 * Containment is not weakened: the fallback is the root, never the bad path.
 */
export async function normalizeStoredHermesSessionWorkspace(profile: string, workspace?: string | null): Promise<string | null> {
  try {
    return await normalizeHermesSessionWorkspace(profile, workspace)
  } catch {
    return null
  }
}
