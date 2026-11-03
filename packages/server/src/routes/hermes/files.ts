import Router from '@koa/router'
import type { Context } from 'koa'
import { MAX_EDIT_SIZE } from '../../services/hermes/file-provider'
import { requireSuperAdminOrChatPlane } from '../../middleware/user-auth'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'
import {
  createRequestFileProvider,
  getFileRootDir,
  isSensitiveFilePath as isSensitivePath,
  resolveFilePath,
  resolveWorkspaceEntryPath,
  resolveWorkspaceRealPath,
} from '../../services/hermes/file-scope'
import { isNearestExistingRealPathWithin, realPathOrResolved } from '../../services/hermes/hermes-path'
import { previewProfileFile } from '../../controllers/hermes/file-preview'

function withAbsolutePath<T extends { path: string }>(ctx: any, entry: T, rootDir?: string): T & { absolutePath: string } {
  return { ...entry, absolutePath: resolveFilePath(ctx, entry.path, rootDir) }
}

function denySensitivePath(ctx: Context, relativePath: string, action = 'access'): boolean {
  if (!isSensitivePath(relativePath)) return false
  ctx.status = 403
  ctx.body = { error: `Cannot ${action} sensitive file`, code: 'permission_denied' }
  return true
}

async function filterWorkspaceEntries<T extends { path: string; name: string }>(
  ctx: any,
  entries: T[],
  rootDir?: string,
): Promise<T[]> {
  const filtered: T[] = []
  for (const entry of entries) {
    if (isSensitivePath(entry.path || entry.name)) continue
    const absPath = resolveFilePath(ctx, entry.path, rootDir)
    if (rootDir && !(await isNearestExistingRealPathWithin(absPath, rootDir))) continue
    filtered.push(entry)
  }
  return filtered
}

// Every operation below opens the canonical path that resolveWorkspaceRealPath
// validated, never the alias the caller sent: checking `link.txt` and then
// opening `link.txt` leaves the link free to be swapped in between.
//
// The provider is rooted at the canonical workspace too. It derives each
// entry's workspace-relative `path` from its root, and a canonical target under
// a non-canonical root would not be recognised as inside it.
async function workspaceProvider(ctx: any, rootDir?: string) {
  return createRequestFileProvider(ctx, rootDir ? await realPathOrResolved(rootDir) : undefined)
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
    const realPath = await resolveWorkspaceRealPath(absPath, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    let listed = await provider.listDir(realPath)
    // The provider names entries relative to the canonical directory. Hand them
    // back under the path the client navigated with (`linkdir/x`, not
    // `realdir/x`) so tree keys and the next click stay where the user is;
    // every follow-up request is validated again.
    if (rootDir) {
      listed = listed.map(entry => ({ ...entry, path: relativePath ? `${relativePath}/${entry.name}` : entry.name }))
    }
    const entries = await filterWorkspaceEntries(ctx, listed, rootDir)
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
    const realPath = await resolveWorkspaceRealPath(absPath, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    const info = await provider.stat(realPath)
    ctx.body = withAbsolutePath(ctx, info, rootDir)
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/read?path=
fileRoutes.get('/api/hermes/files/read', requireSuperAdminOrChatPlane, async (ctx) => {
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
    const realPath = await resolveWorkspaceRealPath(absPath, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    const data = await provider.readFile(realPath)
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

// GET /api/hermes/files/preview?path=
// Binary-safe sibling of /read for the formats the panel renders with a
// dedicated viewer (pdf / docx / pptx / xlsx). Same isolation as every other
// files route; the extension allowlist and per-format size caps live in the
// controller.
fileRoutes.get('/api/hermes/files/preview', requireSuperAdminOrChatPlane, async (ctx) => {
  const relativePath = (ctx.query.path as string) || ''
  if (relativePath && denySensitivePath(ctx, relativePath, 'preview')) return
  await previewProfileFile(ctx)
})

// PUT /api/hermes/files/write  body: { path, content }
fileRoutes.put('/api/hermes/files/write', requireSuperAdminOrChatPlane, async (ctx) => {
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
    const realPath = await resolveWorkspaceRealPath(absPath, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    await provider.writeFile(realPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// DELETE /api/hermes/files/delete  body: { path, recursive? }
fileRoutes.delete('/api/hermes/files/delete', requireSuperAdminOrChatPlane, async (ctx) => {
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
    const entryPath = await resolveWorkspaceEntryPath(absPath, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    if (recursive) {
      await provider.deleteDir(entryPath)
    } else {
      await provider.deleteFile(entryPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/rename  body: { oldPath, newPath }
fileRoutes.post('/api/hermes/files/rename', requireSuperAdminOrChatPlane, async (ctx) => {
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
    const realOld = await resolveWorkspaceEntryPath(absOld, rootDir)
    const realNew = await resolveWorkspaceRealPath(absNew, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    await provider.renameFile(realOld, realNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/mkdir  body: { path }
fileRoutes.post('/api/hermes/files/mkdir', requireSuperAdminOrChatPlane, async (ctx) => {
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
    const realPath = await resolveWorkspaceRealPath(absPath, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    await provider.mkDir(realPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/copy  body: { srcPath, destPath }
fileRoutes.post('/api/hermes/files/copy', requireSuperAdminOrChatPlane, async (ctx) => {
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
    const realSrc = await resolveWorkspaceRealPath(absSrc, rootDir)
    const realDest = await resolveWorkspaceRealPath(absDest, rootDir)
    const provider = await workspaceProvider(ctx, rootDir)
    await provider.copyFile(realSrc, realDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/upload?path=  (multipart/form-data)
fileRoutes.post('/api/hermes/files/upload', requireSuperAdminOrChatPlane, async (ctx) => {
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
  const provider = await workspaceProvider(ctx, rootDir)
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

    try {
      const absPath = resolveFilePath(ctx, filePath, rootDir)
      const realPath = await resolveWorkspaceRealPath(absPath, rootDir)
      await provider.writeFile(realPath, data)
    } catch (err: any) {
      handleError(ctx, err)
      return
    }
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
})
