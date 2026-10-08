import type { Context } from 'koa'
import { lstat, mkdir, readlink, realpath } from 'fs/promises'
import { basename, dirname, join, normalize, resolve } from 'path'
import {
  createFileProvider,
  LocalFileProvider,
  resolveHermesPath,
} from './file-provider'
import { getRequestProfileDir, isChatPlaneRequest } from '../request-context'
import {
  isPathWithin,
  realPathOrResolved,
  relativePathFromBase,
} from './hermes-path'

// Extracted from routes/hermes/files.ts so every endpoint that resolves a
// caller-supplied path — the file CRUD routes and the binary preview
// controller — runs the SAME chat-plane isolation. Duplicating these guards
// per endpoint is how a preview route ends up reading another tenant's
// config.yaml.

export function requestedProfile(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

// Fork's chat-plane isolation predicate. The upstream `isSensitivePath` only
// blocks `.env`/`auth.json` basenames; the fork additionally blocks `config.yaml`
// and any path containing a credentials/tokens/.ssh/feishu_uat segment so a
// Feishu user can never reach root/profile config or materialized secrets even
// inside their own workspace.
const SENSITIVE_FILE_NAMES = new Set(['.env', 'auth.json', 'config.yaml'])
const SENSITIVE_PATH_PARTS = new Set(['credentials', 'tokens', '.ssh', 'feishu_uat'])

/**
 * Lexical blocklist check.
 *
 * Case is folded because macOS and Windows resolve `Config.yaml` to the same
 * inode as `config.yaml`, and `.` / `..` segments are collapsed first so a
 * path cannot walk back onto a blocked name. This is the cheap pre-check only:
 * it reasons about the string the caller sent, so it can never see through a
 * symlink. `resolveWorkspaceRealPath` re-runs it on the canonical target,
 * which is the check that actually holds.
 */
export function isSensitiveFilePath(relativePath: string): boolean {
  const parts = normalize(relativePath.replace(/\\/g, '/'))
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.')
    .map(part => part.toLowerCase())
  const fileName = parts[parts.length - 1] || ''
  return SENSITIVE_FILE_NAMES.has(fileName) || parts.some(part => SENSITIVE_PATH_PARTS.has(part))
}

// Chat-plane requests are scoped to the bound profile's `workspace` subdir so a
// Feishu user can never read/write the profile home, root config, sibling
// profiles, or materialized credentials. Admin/JWT requests keep the upstream
// profile-home behavior (rootDir undefined → resolve via resolveHermesPath).
export async function getFileRootDir(ctx: Context): Promise<string | undefined> {
  if (!isChatPlaneRequest(ctx)) return undefined
  const workspaceDir = join(getRequestProfileDir(ctx), 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  return workspaceDir
}

// Resolve a caller-supplied relative path. When a chat-plane rootDir is in
// effect the path is confined to that workspace (traversal-checked); otherwise
// fall back to the upstream profile-home resolution.
export function resolveFilePath(ctx: any, relativePath: string, rootDir?: string): string {
  if (rootDir) {
    if (!relativePath || relativePath === '.' || relativePath === '/') {
      return rootDir
    }
    const normalized = normalize(relativePath).replace(/\\/g, '/')
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized.startsWith('/')) {
      throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
    }
    const resolved = resolve(rootDir, normalized)
    if (resolved !== rootDir && !resolved.startsWith(rootDir + '/')) {
      throw Object.assign(new Error('Path traversal detected'), { code: 'invalid_path' })
    }
    return resolved
  }
  return resolveHermesPath(relativePath, requestedProfile(ctx))
}

export async function createRequestFileProvider(ctx: any, rootDir?: string) {
  return rootDir ? new LocalFileProvider(rootDir, { noFollow: true }) : createFileProvider(requestedProfile(ctx))
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(message), { code: 'permission_denied' })
}

const MAX_LINK_HOPS = 8

/**
 * Canonical form of a path that may not exist yet: the realpath of the nearest
 * existing ancestor with the missing segments appended unchanged, so a new file
 * is written to `<real parent>/<name>` and not to the parent directory itself.
 *
 * Existence is tested with lstat, not stat: a dangling symlink exists as a link
 * even though its target does not. Treating it as missing would append its name
 * lexically and let the later open follow it to wherever it points. Instead the
 * link is read and its target canonicalised in turn (bounded hops), so
 * `draft.txt -> notes/todo.txt` resolves to `<root>/notes/todo.txt` and the
 * containment check runs on where the write will really land.
 */
async function canonicalPath(absPath: string, hops = 0): Promise<string> {
  const missing: string[] = []
  let current = resolve(absPath)
  for (;;) {
    if (await lstat(current).then(() => true, () => false)) {
      const tail = missing.reverse()
      const real = await realpath(current).catch(() => null)
      if (real) return tail.length ? join(real, ...tail) : real
      if (hops >= MAX_LINK_HOPS) throw permissionDenied('Too many symlink hops')
      const target = await readlink(current).catch(() => {
        throw permissionDenied('Path contains an unresolvable symlink')
      })
      const resolvedTarget = await canonicalPath(resolve(dirname(current), target), hops + 1)
      return tail.length ? join(resolvedTarget, ...tail) : resolvedTarget
    }
    const parent = dirname(current)
    if (parent === current) return resolve(absPath)
    missing.push(basename(current))
    current = parent
  }
}

async function assertInsideWorkspace(canonical: string, rootDir: string): Promise<void> {
  const canonicalRoot = await realPathOrResolved(rootDir)
  if (!isPathWithin(canonical, canonicalRoot)) throw permissionDenied('Path escapes workspace')
  const relative = relativePathFromBase(canonical, canonicalRoot)
  if (relative === null) throw permissionDenied('Path escapes workspace')
  if (relative && isSensitiveFilePath(relative)) {
    throw permissionDenied('Cannot access sensitive file')
  }
}

/**
 * Resolve `absPath` to the path the filesystem will actually open and confirm
 * that path is legal, returning it so the caller can use IT rather than the
 * alias it was handed.
 *
 * Confining the canonical target to the workspace is not enough on its own: a
 * symlink at `workspace/report.pdf` pointing at `workspace/config.yaml` stays
 * inside the workspace, passes the caller-supplied-string blocklist (its name
 * is `report.pdf`), and then serves the blocked file. So the blocklist runs a
 * second time against the canonical, workspace-relative path.
 *
 * Callers must read through the returned path. Checking the alias and then
 * re-opening the alias leaves the link free to change in between.
 */
export async function resolveWorkspaceRealPath(absPath: string, rootDir?: string): Promise<string> {
  if (!rootDir) return absPath
  const canonical = await canonicalPath(absPath)
  await assertInsideWorkspace(canonical, rootDir)
  return canonical
}

/**
 * For operations on the directory entry itself (unlink, rm, rename source):
 * the canonical parent plus the original name, with the final component NOT
 * resolved. Those syscalls never follow a final symlink, so deleting
 * `link.txt` removes the link and leaves its target alone. The target is still
 * validated, so a link that points outside the workspace stays refused, and
 * the entry path itself must be inside the workspace and off the blocklist.
 */
export async function resolveWorkspaceEntryPath(absPath: string, rootDir?: string): Promise<string> {
  if (!rootDir) return absPath
  const real = await resolveWorkspaceRealPath(absPath, rootDir)
  const canonicalRoot = await realPathOrResolved(rootDir)
  if (real === canonicalRoot) return real
  const entry = join(await canonicalPath(dirname(resolve(absPath))), basename(resolve(absPath)))
  await assertInsideWorkspace(entry, rootDir)
  return entry
}

export async function assertWorkspaceRealPath(absPath: string, rootDir?: string): Promise<void> {
  await resolveWorkspaceRealPath(absPath, rootDir)
}
