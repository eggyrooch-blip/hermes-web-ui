import Router from '@koa/router'
import type { Context } from 'koa'
import { mkdir } from 'fs/promises'
import { basename, extname, isAbsolute, join, normalize } from 'path'
import {
  createFileProvider,
  localProvider,
  isInUploadDir,
  isSensitivePath,
  validatePath,
  resolveHermesPath,
} from '../../services/hermes/file-provider'
import {
  getRequestProfileDir,
  isChatPlaneRequest,
} from '../../services/request-context'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { isPathWithin } from '../../services/hermes/hermes-path'

export const downloadRoutes = new Router()

// MIME type mapping for common extensions
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.log': 'text/plain',
}

function getMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

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

async function getDownloadTarget(ctx: Context, filePath: string): Promise<{
  validPath: string
  forceLocalRoot?: string
  useLocalUploadProvider: boolean
}> {
  // Admin / JWT plane: unchanged upstream resolution across the active profile.
  if (!isChatPlaneRequest(ctx)) {
    const profile = legacyProfile(ctx)
    const validPath = isAbsolute(filePath)
      ? validatePath(filePath)
      : resolveHermesPath(filePath, profile)
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
): Promise<{ data: Buffer, name: string, mime: string }> {
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
  if (relative && isSensitivePath(filePath)) {
    throw Object.assign(
      new Error('Cannot download sensitive file'),
      { code: 'permission_denied' },
    )
  }

  const target = await getDownloadTarget(ctx, filePath)

  let data: Buffer
  if (target.useLocalUploadProvider || target.forceLocalRoot) {
    data = await localProvider.readFile(target.validPath)
  } else {
    const provider = await createFileProvider(legacyProfile(ctx))
    data = await provider.readFile(target.validPath)
  }

  const name = fileName || basename(target.validPath)
  return {
    data,
    name,
    mime: getMimeType(name),
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
    const { data, name, mime } = await resolveAndReadHermesFile(ctx, filePath, fileName)
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.set('Content-Length', String(data.length))
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = data
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
    const { data, mime } = await resolveAndReadHermesFile(ctx, filePath, fileName)
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', 'inline')
    ctx.set('Content-Length', String(data.length))
    ctx.set('X-Frame-Options', 'SAMEORIGIN')
    ctx.set('Content-Security-Policy', "frame-ancestors 'self'")
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = data
  } catch (err: any) {
    applyDownloadRouteError(ctx, err)
  }
})
