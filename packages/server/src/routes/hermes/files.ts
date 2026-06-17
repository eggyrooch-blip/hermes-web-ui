import Router from '@koa/router'
import type { Context } from 'koa'
import { mkdir } from 'fs/promises'
import { join, normalize, resolve } from 'path'
import {
  createFileProvider,
  LocalFileProvider,
  resolveHermesPath,
  MAX_EDIT_SIZE,
} from '../../services/hermes/file-provider'
import { requireSuperAdmin } from '../../middleware/user-auth'
import { getRequestProfileDir, isChatPlaneRequest } from '../../services/request-context'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'

function requestedProfile(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

// Fork's chat-plane isolation predicate. The upstream `isSensitivePath` only
// blocks `.env`/`auth.json` basenames; the fork additionally blocks `config.yaml`
// and any path containing a credentials/tokens/.ssh/feishu_uat segment so a
// Feishu user can never reach root/profile config or materialized secrets even
// inside their own workspace. Kept local because we may only edit this file.
const SENSITIVE_FILE_NAMES = new Set(['.env', 'auth.json', 'config.yaml'])
const SENSITIVE_PATH_PARTS = new Set(['credentials', 'tokens', '.ssh', 'feishu_uat'])

function isSensitivePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const fileName = parts[parts.length - 1] || ''
  return SENSITIVE_FILE_NAMES.has(fileName) || parts.some(part => SENSITIVE_PATH_PARTS.has(part))
}

// Chat-plane requests are scoped to the bound profile's `workspace` subdir so a
// Feishu user can never read/write the profile home, root config, sibling
// profiles, or materialized credentials. Admin/JWT requests keep the upstream
// profile-home behavior (rootDir undefined → resolve via resolveHermesPath).
async function getFileRootDir(ctx: Context): Promise<string | undefined> {
  if (!isChatPlaneRequest(ctx)) return undefined
  const workspaceDir = join(getRequestProfileDir(ctx), 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  return workspaceDir
}

// Resolve a caller-supplied relative path. When a chat-plane rootDir is in
// effect the path is confined to that workspace (traversal-checked); otherwise
// fall back to the upstream profile-home resolution.
function resolveFilePath(ctx: any, relativePath: string, rootDir?: string): string {
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

async function createRequestFileProvider(ctx: any, rootDir?: string) {
  return rootDir ? new LocalFileProvider(rootDir) : createFileProvider(requestedProfile(ctx))
}

function withAbsolutePath<T extends { path: string }>(ctx: any, entry: T, rootDir?: string): T & { absolutePath: string } {
  return { ...entry, absolutePath: resolveFilePath(ctx, entry.path, rootDir) }
}

function denySensitivePath(ctx: Context, relativePath: string, action = 'access'): boolean {
  if (!isSensitivePath(relativePath)) return false
  ctx.status = 403
  ctx.body = { error: `Cannot ${action} sensitive file`, code: 'permission_denied' }
  return true
}

export const fileRoutes = new Router()

function handleError(ctx: any, err: any) {
  const code = err.code || 'unknown'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    not_found: 404,
    ENOENT: 404,
    already_exists: 409,
    permission_denied: 403,
    file_too_large: 413,
    not_a_directory: 400,
    not_a_file: 400,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = statusMap[code] || 500
  ctx.body = { error: err.message, code }
}

// GET /api/hermes/files/list?path=
fileRoutes.get('/api/hermes/files/list', async (ctx) => {
  const relativePath = (ctx.query.path as string) || ''
  if (relativePath && denySensitivePath(ctx, relativePath)) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(ctx, relativePath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    const entries = (await provider.listDir(absPath))
      .filter(entry => !isSensitivePath(entry.path || entry.name))
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { entries: entries.map(entry => withAbsolutePath(ctx, entry, rootDir)), path: relativePath, absolutePath: absPath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/stat?path=
fileRoutes.get('/api/hermes/files/stat', async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, relativePath)) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(ctx, relativePath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    const info = await provider.stat(absPath)
    ctx.body = withAbsolutePath(ctx, info, rootDir)
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/read?path=
fileRoutes.get('/api/hermes/files/read', requireSuperAdmin, async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, relativePath)) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(ctx, relativePath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    const data = await provider.readFile(absPath)
    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'File too large to edit', code: 'file_too_large' }
      return
    }
    ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// PUT /api/hermes/files/write  body: { path, content }
fileRoutes.put('/api/hermes/files/write', requireSuperAdmin, async (ctx) => {
  const { path: relativePath, content } = ctx.request.body as { path?: string; content?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, relativePath, 'modify')) return
  try {
    const buf = Buffer.from(content || '', 'utf-8')
    if (buf.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(ctx, relativePath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    await provider.writeFile(absPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// DELETE /api/hermes/files/delete  body: { path, recursive? }
fileRoutes.delete('/api/hermes/files/delete', requireSuperAdmin, async (ctx) => {
  const body = (ctx.request.body || {}) as { path?: string; recursive?: boolean }
  const query = (ctx.query || {}) as { path?: string; recursive?: string }
  const relativePath = body.path || (query.path as string)
  const recursive = body.recursive ?? query.recursive === 'true'
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, relativePath, 'delete')) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(ctx, relativePath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    if (recursive) {
      await provider.deleteDir(absPath)
    } else {
      await provider.deleteFile(absPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/rename  body: { oldPath, newPath }
fileRoutes.post('/api/hermes/files/rename', requireSuperAdmin, async (ctx) => {
  const { oldPath, newPath } = ctx.request.body as { oldPath?: string; newPath?: string }
  if (!oldPath || !newPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing oldPath or newPath', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, oldPath, 'rename')) return
  if (denySensitivePath(ctx, newPath, 'rename into')) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absOld = resolveFilePath(ctx, oldPath, rootDir)
    const absNew = resolveFilePath(ctx, newPath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    await provider.renameFile(absOld, absNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/mkdir  body: { path }
fileRoutes.post('/api/hermes/files/mkdir', requireSuperAdmin, async (ctx) => {
  const { path: relativePath } = ctx.request.body as { path?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, relativePath, 'create')) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(ctx, relativePath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    await provider.mkDir(absPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/copy  body: { srcPath, destPath }
fileRoutes.post('/api/hermes/files/copy', requireSuperAdmin, async (ctx) => {
  const { srcPath, destPath } = ctx.request.body as { srcPath?: string; destPath?: string }
  if (!srcPath || !destPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing srcPath or destPath', code: 'missing_path' }
    return
  }
  if (denySensitivePath(ctx, srcPath, 'copy')) return
  if (denySensitivePath(ctx, destPath, 'copy into')) return
  try {
    const rootDir = await getFileRootDir(ctx)
    const absSrc = resolveFilePath(ctx, srcPath, rootDir)
    const absDest = resolveFilePath(ctx, destPath, rootDir)
    const provider = await createRequestFileProvider(ctx, rootDir)
    await provider.copyFile(absSrc, absDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/upload?path=  (multipart/form-data)
fileRoutes.post('/api/hermes/files/upload', requireSuperAdmin, async (ctx) => {
  const targetDir = (ctx.query.path as string) || ''
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data', code: 'invalid_request' }
    return
  }

  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary', code: 'invalid_request' }
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const parts = splitMultipart(raw, boundaryBuf)
  const rootDir = await getFileRootDir(ctx)
  const provider = await createRequestFileProvider(ctx, rootDir)
  const results: { name: string; path: string }[] = []

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: error.message, code: 'invalid_request' }
        return
      }
      throw error
    }
    if (!filename) continue

    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File ${filename} too large`, code: 'file_too_large' }
      return
    }

    const filePath = targetDir ? `${targetDir}/${filename}` : filename
    if (isSensitivePath(filePath)) {
      ctx.status = 403
      ctx.body = { error: `Cannot overwrite sensitive file: ${filename}`, code: 'permission_denied' }
      return
    }

    const absPath = resolveFilePath(ctx, filePath, rootDir)
    await provider.writeFile(absPath, data)
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
})
