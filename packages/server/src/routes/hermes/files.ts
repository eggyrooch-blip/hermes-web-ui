import Router from '@koa/router'
import type { Context } from 'koa'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import {
  createFileProvider,
  resolveHermesPath,
  isSensitivePath,
  MAX_EDIT_SIZE,
} from '../../services/hermes/file-provider'
import { getRequestProfileDir, isChatPlaneRequest } from '../../services/request-context'

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

async function getFileRootDir(ctx: Context): Promise<string | undefined> {
  if (!isChatPlaneRequest(ctx)) return undefined
  const workspaceDir = join(getRequestProfileDir(ctx), 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  return workspaceDir
}

function resolveFilePath(relativePath: string, rootDir?: string): string {
  return resolveHermesPath(relativePath, rootDir)
}

async function createRequestFileProvider(rootDir?: string) {
  return rootDir ? createFileProvider({ rootDir, forceLocal: true }) : createFileProvider()
}

// GET /api/hermes/files/list?path=
fileRoutes.get('/api/hermes/files/list', async (ctx) => {
  const relativePath = (ctx.query.path as string) || ''
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(relativePath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
    const entries = await provider.listDir(absPath)
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { entries, path: relativePath }
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
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(relativePath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
    const info = await provider.stat(absPath)
    ctx.body = info
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/read?path=
fileRoutes.get('/api/hermes/files/read', async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(relativePath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
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
fileRoutes.put('/api/hermes/files/write', async (ctx) => {
  const { path: relativePath, content } = ctx.request.body as { path?: string; content?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot modify sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const buf = Buffer.from(content || '', 'utf-8')
    if (buf.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(relativePath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
    await provider.writeFile(absPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// DELETE /api/hermes/files/delete  body: { path, recursive? }
fileRoutes.delete('/api/hermes/files/delete', async (ctx) => {
  const body = (ctx.request.body || {}) as { path?: string; recursive?: boolean }
  const relativePath = body.path || (ctx.query.path as string)
  const recursive = body.recursive ?? ctx.query.recursive === 'true'
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot delete sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(relativePath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
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
fileRoutes.post('/api/hermes/files/rename', async (ctx) => {
  const { oldPath, newPath } = ctx.request.body as { oldPath?: string; newPath?: string }
  if (!oldPath || !newPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing oldPath or newPath', code: 'missing_path' }
    return
  }
  if (isSensitivePath(oldPath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot rename sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const rootDir = await getFileRootDir(ctx)
    const absOld = resolveFilePath(oldPath, rootDir)
    const absNew = resolveFilePath(newPath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
    await provider.renameFile(absOld, absNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/mkdir  body: { path }
fileRoutes.post('/api/hermes/files/mkdir', async (ctx) => {
  const { path: relativePath } = ctx.request.body as { path?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const rootDir = await getFileRootDir(ctx)
    const absPath = resolveFilePath(relativePath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
    await provider.mkDir(absPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/copy  body: { srcPath, destPath }
fileRoutes.post('/api/hermes/files/copy', async (ctx) => {
  const { srcPath, destPath } = ctx.request.body as { srcPath?: string; destPath?: string }
  if (!srcPath || !destPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing srcPath or destPath', code: 'missing_path' }
    return
  }
  try {
    const rootDir = await getFileRootDir(ctx)
    const absSrc = resolveFilePath(srcPath, rootDir)
    const absDest = resolveFilePath(destPath, rootDir)
    const provider = await createRequestFileProvider(rootDir)
    await provider.copyFile(absSrc, absDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/upload?path=  (multipart/form-data)
fileRoutes.post('/api/hermes/files/upload', async (ctx) => {
  const targetDir = (ctx.query.path as string) || ''
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data', code: 'invalid_request' }
    return
  }

  const boundary = '--' + contentType.split('boundary=')[1]
  if (!boundary || boundary === '--undefined') {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary', code: 'invalid_request' }
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const boundaryBuf = Buffer.from(boundary)
  const parts = splitMultipart(raw, boundaryBuf)
  const rootDir = await getFileRootDir(ctx)
  const provider = await createRequestFileProvider(rootDir)
  const results: { name: string; path: string }[] = []

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    let filename = ''
    const filenameStarMatch = header.match(/filename\*=UTF-8''(.+)/i)
    if (filenameStarMatch) {
      filename = decodeURIComponent(filenameStarMatch[1])
    } else {
      const filenameMatch = header.match(/filename="([^"]+)"/)
      if (!filenameMatch) continue
      filename = filenameMatch[1]
    }

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

    const absPath = resolveFilePath(filePath, rootDir)
    await provider.writeFile(absPath, data)
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
})

function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      const partStart = start + 2
      parts.push(raw.subarray(partStart, idx))
    }
    start = idx + boundary.length
  }
  return parts
}
