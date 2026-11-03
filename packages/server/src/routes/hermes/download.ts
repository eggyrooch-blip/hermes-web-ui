import Router from '@koa/router'
import type { Context } from 'koa'
import { createReadStream } from 'fs'
import { mkdir } from 'fs/promises'
import { basename, isAbsolute, join, normalize } from 'path'
import {
  createFileProvider,
  localProvider,
  MAX_DOWNLOAD_SIZE,
  isInUploadDir,
  isSensitivePath,
  validatePath,
  resolveHermesPath,
} from '../../services/hermes/file-provider'
import {
  getRequestProfileDir,
  isChatPlaneRequest,
} from '../../services/request-context'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import {
  isNearestExistingRealPathWithin,
  isPathWithin,
  nearestExistingRealPath,
} from '../../services/hermes/hermes-path'
import { config } from '../../config'
import { getArtifactMimeType } from '../../services/hermes/artifact-publication'

export const downloadRoutes = new Router()

const statusMap: Record<string, number> = {
  missing_path: 400,
  invalid_path: 400,
  not_found: 404,
  ENOENT: 404,
  permission_denied: 403,
  file_too_large: 413,
  unsupported_backend: 501,
  backend_error: 502,
  backend_timeout: 504,
}

/**
 * Chat-plane multi-tenant isolation: relative paths that point at a profile's
 * runtime config or materialized credentials must never be downloadable, even
 * though they live under the bound profile's home. This mirrors the fork's
 * isSensitivePath blocklist so a chat-plane user can only reach their own
 * workspace artifacts, never `config.yaml`, `.env`, `auth.json`, or anything
 * under `credentials/`, `tokens/`, `.ssh/`, `feishu_uat/`.
 */
const CHAT_PLANE_SENSITIVE_FILES = new Set(['.env', 'auth.json', 'config.yaml'])
const CHAT_PLANE_SENSITIVE_PARTS = new Set(['credentials', 'tokens', '.ssh', 'feishu_uat'])

function isChatPlaneSensitiveRelative(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return false
  const fileName = parts[parts.length - 1]
  return CHAT_PLANE_SENSITIVE_FILES.has(fileName) || parts.some(part => CHAT_PLANE_SENSITIVE_PARTS.has(part))
}

/**
 * Legacy / admin (JWT) resolution: keep upstream behavior so admin downloads
 * across the active profile keep working unchanged.
 */
function legacyProfile(ctx: Context): string {
  return (ctx.state as any)?.profile?.name || getActiveProfileName() || 'default'
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(message), { code: 'permission_denied' })
}

/**
 * Admin / ops plane download fence, applied to every resolved target (absolute
 * or relative). `super_admin` already has a host shell through the terminal, so
 * it keeps host-wide reads; every other role may only read inside the shared
 * upload dir or its current profile dir. Both checks run on the real
 * (symlink-resolved) path so a link planted inside an allowed root — e.g.
 * `workspace/notes.txt -> <APP_HOME>/.token` — cannot smuggle out a secret or
 * an arbitrary host file.
 */
async function assertAdminPlaneTargetAllowed(ctx: Context, validPath: string): Promise<void> {
  if (isSensitivePath(await nearestExistingRealPath(validPath))) {
    throw permissionDenied('Cannot download sensitive file')
  }
  if ((ctx.state as any)?.user?.role === 'super_admin') return
  const allowedRoots = [config.uploadDir, getProfileDir(legacyProfile(ctx))]
  for (const root of allowedRoots) {
    if (isPathWithin(validPath, root) && await isNearestExistingRealPathWithin(validPath, root)) return
  }
  throw permissionDenied('Absolute downloads are limited to the upload and profile directories')
}

async function getDownloadTarget(ctx: Context, filePath: string): Promise<{
  validPath: string
  forceLocalRoot?: string
  useLocalUploadProvider: boolean
}> {
  // Admin / JWT plane: relative paths keep upstream resolution across the
  // active profile. Absolute targets are fenced here; relative targets are
  // fenced in resolveAndReadHermesFile once the provider is known (see there).
  if (!isChatPlaneRequest(ctx)) {
    const profile = legacyProfile(ctx)
    let validPath: string
    if (isAbsolute(filePath)) {
      validPath = validatePath(filePath)
      await assertAdminPlaneTargetAllowed(ctx, validPath)
    } else {
      validPath = resolveHermesPath(filePath, profile)
    }
    return { validPath, useLocalUploadProvider: isInUploadDir(validPath) }
  }

  // Chat plane: confined to the bound profile.
  if (isAbsolute(filePath)) {
    // Absolute downloads are only legal inside the shared upload dir; anything
    // else (profile/root config, arbitrary host paths) is rejected.
    const validPath = validatePath(filePath)
    if (!isInUploadDir(validPath)) {
      throw Object.assign(
        new Error('Absolute downloads are not available in chat plane'),
        { code: 'invalid_path' },
      )
    }
    return { validPath, useLocalUploadProvider: true }
  }

  // Relative downloads are scoped to the bound profile's workspace dir. The
  // request profile is resolved by getRequestProfileDir, which already strips
  // unowned caller-supplied selectors via ownerOwnsProfile(openid, profile).
  const workspaceDir = join(getRequestProfileDir(ctx), 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  let normalized = normalize(filePath).replace(/\\/g, '/')
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
  }
  // Artifact display paths (from MEDIA: lines / the embedded browser) carry a
  // `workspace/` prefix, but the chat plane already roots at the workspace dir —
  // so a literal `workspace/foo.html` would resolve to workspace/workspace/foo.html
  // (404). Strip one leading `workspace/` so the display path and the API path
  // line up. Normal relative downloads (no prefix) are unaffected.
  normalized = normalized.replace(/^workspace\//, '')
  const resolved = join(workspaceDir, normalized)
  if (!isPathWithin(resolved, workspaceDir)) {
    throw Object.assign(new Error('Path traversal detected'), { code: 'invalid_path' })
  }
  if (!(await isNearestExistingRealPathWithin(resolved, workspaceDir))) {
    throw Object.assign(new Error('Path escapes workspace'), { code: 'permission_denied' })
  }
  return {
    validPath: resolved,
    forceLocalRoot: workspaceDir,
    useLocalUploadProvider: false,
  }
}

async function resolveAndReadHermesFile(
  ctx: Context,
  filePath: string,
  fileName?: string,
): Promise<{ body: Buffer | ReturnType<typeof createReadStream>, length: number, name: string, mime: string }> {
  // Chat-plane display paths (MEDIA rewrites / file cards / embedded browser)
  // arrive as `/workspace/<rel>`. Normalize to a workspace-relative path HERE,
  // before the sensitive-path checks below, so the blocklist and traversal
  // guards all run against the stripped form — stripping inside
  // getDownloadTarget instead would let `/workspace/credentials/token` bypass
  // isChatPlaneSensitiveRelative. Exact-prefix match only: `/workspace`,
  // `/workspace/` (empty rest) and `/workspace-not/x` are left untouched.
  if (isChatPlaneRequest(ctx) && filePath.startsWith('/workspace/')) {
    const rel = filePath.slice('/workspace/'.length)
    if (rel) filePath = rel
  }
  const relative = !isAbsolute(filePath)
  if (relative && isChatPlaneRequest(ctx) && isChatPlaneSensitiveRelative(filePath)) {
    throw Object.assign(
      new Error('Cannot download sensitive file'),
      { code: 'permission_denied' },
    )
  }
  // Sensitive files are blocked for every role: relative paths on both planes,
  // absolute paths on the admin plane. (Chat-plane absolute paths are already
  // confined to the upload dir by getDownloadTarget, and keep its 400 there.)
  if ((relative || !isChatPlaneRequest(ctx)) && isSensitivePath(filePath)) {
    throw permissionDenied('Cannot download sensitive file')
  }

  const target = await getDownloadTarget(ctx, filePath)

  const provider = target.useLocalUploadProvider || target.forceLocalRoot
    ? localProvider
    : await createFileProvider(legacyProfile(ctx))
  // Relative admin-plane targets are lexically inside the profile dir already
  // (resolveHermesPath), but a host read follows symlinks planted there — e.g.
  // `workspace/notes.txt -> <APP_HOME>/.token`. Fence the real target whenever
  // the host filesystem does the read. Remote backends (docker/ssh/...) read
  // inside their own sandbox, where a host realpath means nothing.
  if (!isChatPlaneRequest(ctx) && !isAbsolute(filePath) && provider.type === 'local') {
    await assertAdminPlaneTargetAllowed(ctx, target.validPath)
  }
  let body: Buffer | ReturnType<typeof createReadStream>
  let length: number
  if (provider.type === 'local') {
    const file = await provider.stat(target.validPath)
    if (file.isDir) throw Object.assign(new Error('Not a file'), { code: 'not_found' })
    if (file.size > MAX_DOWNLOAD_SIZE) {
      throw Object.assign(new Error(`File too large: ${file.size} bytes`), { code: 'file_too_large' })
    }
    body = createReadStream(target.validPath)
    length = file.size
  } else {
    body = await provider.readFile(target.validPath)
    length = body.length
  }

  const name = fileName || basename(target.validPath)
  return {
    body,
    length,
    name,
    mime: getArtifactMimeType(name),
  }
}

function applyDownloadRouteError(ctx: Context, err: any): void {
  const code = err.code || 'unknown'
  ctx.status = statusMap[code] || 500
  ctx.body = { error: err.message, code }
}

downloadRoutes.get('/api/hermes/download', async (ctx) => {
  const filePath = ctx.query.path as string | undefined
  const fileName = ctx.query.name as string | undefined

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }

  try {
    const { body, length, name, mime } = await resolveAndReadHermesFile(ctx, filePath, fileName)
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.set('Content-Length', String(length))
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = body
  } catch (err: any) {
    applyDownloadRouteError(ctx, err)
  }
})

downloadRoutes.get('/api/hermes/preview', async (ctx) => {
  const filePath = ctx.query.path as string | undefined
  const fileName = ctx.query.name as string | undefined

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }

  try {
    const { body, length, mime } = await resolveAndReadHermesFile(ctx, filePath, fileName)
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', 'inline')
    ctx.set('Content-Length', String(length))
    ctx.set('X-Frame-Options', 'SAMEORIGIN')
    ctx.set('Content-Security-Policy', "frame-ancestors 'self'")
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = body
  } catch (err: any) {
    applyDownloadRouteError(ctx, err)
  }
})
