import { randomBytes } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { getProfileUploadDir } from '../services/hermes/upload-paths'
import { getRequestProfileDir, isChatPlaneRequest } from '../services/request-context'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../lib/multipart'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../lib/request-body'

const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024
const MAX_CONFIGURED_UPLOAD_SIZE = 1024 * 1024 * 1024

function getMaxUploadSize(): number {
  const raw = process.env.HERMES_MAX_UPLOAD_SIZE?.trim() || ''
  const configured = /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_CONFIGURED_UPLOAD_SIZE
    ? configured
    : DEFAULT_MAX_UPLOAD_SIZE
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

// Fork: chat-plane uploads are isolated to the caller's OWNED profile workspace
// (getRequestProfileDir strips any caller-supplied selector the user does not own
// and falls back to ctx.state.user.profile), and only a RELATIVE path is returned
// so the absolute host layout never leaks to a multi-tenant chat user. Admin/JWT
// requests keep the upstream per-profile uploadDir behavior unchanged.
async function getUploadTarget(ctx: any, savedName: string): Promise<{ savedPath: string; responsePath: string }> {
  if (!isChatPlaneRequest(ctx)) {
    const uploadDir = getProfileUploadDir(requestedProfile(ctx))
    await mkdir(uploadDir, { recursive: true })
    const savedPath = join(uploadDir, savedName)
    return { savedPath, responsePath: savedPath }
  }

  const relativePath = `uploads/${savedName}`
  const uploadDir = join(getRequestProfileDir(ctx), 'workspace', 'uploads')
  await mkdir(uploadDir, { recursive: true })
  return { savedPath: join(uploadDir, savedName), responsePath: relativePath }
}

export async function handleUpload(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data' }; return
  }
  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400; ctx.body = { error: 'Missing boundary' }; return
  }
  let chunks: Buffer[] = []
  let totalSize = 0
  let oversize = false
  const maxUploadSize = getMaxUploadSize()
  for await (const chunk of nonDestroyingRequestBody(ctx.req)) {
    totalSize += chunk.length
    if (totalSize > maxUploadSize) {
      oversize = true
      break
    }
    chunks.push(chunk)
  }
  if (oversize) {
    chunks = []
    await drainRejectedRequest(ctx.req)
    ctx.status = 413
    ctx.body = { error: `File too large (max ${Math.ceil(maxUploadSize / 1024 / 1024)}MB)` }
    return
  }
  const raw = Buffer.concat(chunks)
  const parts = splitMultipart(raw, boundaryBuf)
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
        ctx.status = 400; ctx.body = { error: error.message }; return
      }
      throw error
    }
    if (!filename) continue
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    const savedName = randomBytes(8).toString('hex') + ext
    const target = await getUploadTarget(ctx, savedName)
    await writeFile(target.savedPath, data)
    results.push({ name: filename, path: target.responsePath })
  }
  ctx.body = { files: results }
}
