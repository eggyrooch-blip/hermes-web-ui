import { randomBytes } from 'crypto'
import { mkdir, unlink } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join, extname } from 'path'
import { pipeline } from 'stream/promises'
import busboy from 'busboy'
import { config } from '../config'
import { getRequestProfileDir, isChatPlaneRequest } from '../services/request-context'

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB
const UPLOAD_BODY_TIMEOUT_MS = 60_000 // total time the client has to deliver the multipart body

async function getUploadTarget(ctx: any, savedName: string): Promise<{ savedPath: string; responsePath: string }> {
  if (!isChatPlaneRequest(ctx)) {
    return {
      savedPath: `${config.uploadDir}/${savedName}`,
      responsePath: `${config.uploadDir}/${savedName}`,
    }
  }

  const relativePath = `uploads/${savedName}`
  const workspaceDir = join(getRequestProfileDir(ctx), 'workspace')
  const uploadDir = join(workspaceDir, 'uploads')
  await mkdir(uploadDir, { recursive: true })

  return {
    savedPath: join(uploadDir, savedName),
    responsePath: relativePath,
  }
}

interface UploadResult { name: string; path: string }

export async function handleUpload(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data' }; return
  }

  // SECURITY: reject oversize uploads up-front via Content-Length so we don't
  // even start consuming the socket. The busboy fileSize cap below catches
  // clients that lie about (or omit) Content-Length.
  const declaredLen = parseInt(ctx.get('content-length') || '0', 10)
  if (declaredLen > MAX_UPLOAD_SIZE) {
    ctx.status = 413; ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }; return
  }

  // Pre-create the chat-plane upload target dir so first-write is cheap.
  // (Admin-plane writes into config.uploadDir which the bootstrap already creates.)
  if (isChatPlaneRequest(ctx)) {
    await mkdir(join(getRequestProfileDir(ctx), 'workspace', 'uploads'), { recursive: true })
  }

  const bb = busboy({
    headers: ctx.req.headers,
    limits: {
      fileSize: MAX_UPLOAD_SIZE,
      files: 16,
      fieldSize: 1024 * 64,
    },
  })

  const results: UploadResult[] = []
  const cleanupPaths: string[] = []
  let aborted = false
  let timedOut = false
  let limitExceeded = false

  const abortTimer = setTimeout(() => {
    timedOut = true
    try { ctx.req.destroy(new Error('Upload deadline exceeded')) } catch { /* socket already gone */ }
  }, UPLOAD_BODY_TIMEOUT_MS)

  const done = new Promise<void>((resolve, reject) => {
    bb.on('file', async (_field, fileStream, info) => {
      try {
        const original = info.filename || 'upload.bin'
        const ext = extname(original).toLowerCase()
        const savedName = randomBytes(8).toString('hex') + ext
        const target = await getUploadTarget(ctx, savedName)
        cleanupPaths.push(target.savedPath)

        let bytes = 0
        fileStream.on('data', chunk => { bytes += (chunk as Buffer).length })
        fileStream.on('limit', () => { limitExceeded = true })

        await pipeline(fileStream, createWriteStream(target.savedPath))
        if (limitExceeded || bytes > MAX_UPLOAD_SIZE) return
        results.push({ name: original, path: target.responsePath })
      } catch (err) {
        reject(err)
      }
    })
    bb.on('error', err => reject(err))
    bb.on('close', () => resolve())
    bb.on('finish', () => resolve())
  })

  ctx.req.on('aborted', () => { aborted = true })

  try {
    ctx.req.pipe(bb)
    await done
  } catch (err) {
    clearTimeout(abortTimer)
    for (const p of cleanupPaths) { try { await unlink(p) } catch { /* best-effort */ } }
    if (timedOut) { ctx.status = 408; ctx.body = { error: 'Upload timed out' }; return }
    if (aborted) { ctx.status = 400; ctx.body = { error: 'Upload aborted' }; return }
    throw err
  }
  clearTimeout(abortTimer)

  if (limitExceeded) {
    for (const p of cleanupPaths) { try { await unlink(p) } catch { /* best-effort */ } }
    ctx.status = 413; ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }; return
  }

  ctx.body = { files: results }
}
