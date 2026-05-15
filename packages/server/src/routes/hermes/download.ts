import Router from '@koa/router'
import type { Context } from 'koa'
import { mkdir } from 'fs/promises'
import { basename, extname, join } from 'path'
import {
  createFileProvider,
  localProvider,
  isInUploadDir,
  isSensitivePath,
  validatePath,
  resolveHermesPath,
} from '../../services/hermes/file-provider'
import { getRequestProfileDir, isChatPlaneRequest } from '../../services/request-context'
import { getActiveProfileDir } from '../../services/hermes/hermes-profile'
import { config } from '../../config'

/**
 * Roots that are legal targets for absolute-path downloads.
 * Without this whitelist, `validatePath` only checks absoluteness, which
 * historically allowed any reachable file (e.g. /etc/passwd) to be served.
 */
function downloadAllowedRoots(ctx: Context): string[] {
  return [config.uploadDir, getRequestProfileDir(ctx), getActiveProfileDir()]
}

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

async function getDownloadTarget(ctx: Context, filePath: string): Promise<{
  validPath: string
  forceLocalRoot?: string
  useLocalUploadProvider: boolean
}> {
  if (!isChatPlaneRequest(ctx)) {
    const validPath = filePath.startsWith('/')
      ? validatePath(filePath, downloadAllowedRoots(ctx))
      : resolveHermesPath(filePath)
    return { validPath, useLocalUploadProvider: isInUploadDir(validPath) }
  }

  if (filePath.startsWith('/')) {
    // Chat plane only allows absolute paths inside the upload dir.
    const validPath = validatePath(filePath, [config.uploadDir])
    if (!isInUploadDir(validPath)) {
      throw Object.assign(new Error('Absolute downloads are not available in chat plane'), { code: 'invalid_path' })
    }
    return { validPath, useLocalUploadProvider: true }
  }

  const workspaceDir = join(getRequestProfileDir(ctx), 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  return {
    validPath: resolveHermesPath(filePath, workspaceDir),
    forceLocalRoot: workspaceDir,
    useLocalUploadProvider: false,
  }
}

downloadRoutes.get('/api/hermes/download', async (ctx) => {
  const filePath = ctx.query.path as string | undefined
  const fileName = ctx.query.name as string | undefined

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (!filePath.startsWith('/') && isSensitivePath(filePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot download sensitive file', code: 'permission_denied' }
    return
  }

  try {
    const target = await getDownloadTarget(ctx, filePath)

    // Choose provider: always use local for upload directory files
    let data: Buffer
    if (target.useLocalUploadProvider) {
      data = await localProvider.readFile(target.validPath)
    } else {
      const provider = target.forceLocalRoot
        ? await createFileProvider({ rootDir: target.forceLocalRoot, forceLocal: true })
        : await createFileProvider()
      data = await provider.readFile(target.validPath)
    }

    // Determine filename and MIME type
    const name = fileName || basename(target.validPath)
    const mime = getMimeType(name)

    // Set response headers
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.set('Content-Length', String(data.length))
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = data
  } catch (err: any) {
    const code = err.code || 'unknown'
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
    ctx.status = statusMap[code] || 500
    ctx.body = { error: err.message, code }
  }
})
