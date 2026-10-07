import { basename } from 'path'
import { open } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import {
  createRequestFileProvider,
  getFileRootDir,
  resolveFilePath,
  resolveWorkspaceRealPath,
} from '../../services/hermes/file-scope'
import {
  assertPreviewFileSize,
  buildFileContentHeaders,
  getFilePreviewDescriptor,
} from '../../services/hermes/file-preview'

function handlePreviewError(ctx: any, err: any): void {
  const code = err?.code || 'preview_failed'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    invalid_file: 400,
    not_a_file: 400,
    unsupported_preview: 415,
    not_found: 404,
    ENOENT: 404,
    permission_denied: 403,
    file_too_large: 413,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = Number(err?.status || statusMap[code] || 500)
  ctx.body = { error: err?.message || 'Failed to preview file', code }
}

function unsupportedPreview(): Error {
  return Object.assign(new Error('File type is not supported for preview'), {
    code: 'unsupported_preview',
    status: 415,
  })
}

/**
 * Serves the raw bytes of a pdf / docx / pptx / xlsx so the panel can render
 * it in place.
 *
 * Path resolution goes through the shared file-scope helpers, so a chat-plane
 * request stays inside its own profile workspace exactly as the list/read/write
 * routes do, and the bytes are read through the CANONICAL path those helpers
 * returned rather than the alias the caller sent.
 */
export async function previewProfileFile(ctx: any): Promise<void> {
  const relativePath = typeof ctx.query?.path === 'string' ? ctx.query.path : ''
  if (!relativePath) {
    handlePreviewError(ctx, Object.assign(new Error('Missing path parameter'), { code: 'missing_path' }))
    return
  }

  let handle: FileHandle | null = null
  try {
    // Fast refusal on the requested name, before any filesystem work.
    if (!getFilePreviewDescriptor(relativePath)) throw unsupportedPreview()

    const rootDir = await getFileRootDir(ctx)
    const requestedPath = resolveFilePath(ctx, relativePath, rootDir)
    const fullPath = await resolveWorkspaceRealPath(requestedPath, rootDir)

    // Re-derive the descriptor from the path that will actually be opened. A
    // symlink named `report.pdf` whose target is `notes.txt` must not be served
    // as a PDF: the renderer trusts the Content-Type we send.
    const descriptor = getFilePreviewDescriptor(fullPath)
    if (!descriptor) throw unsupportedPreview()

    const provider = await createRequestFileProvider(ctx, rootDir)
    const info = await provider.stat(fullPath)
    if (info.isDir) {
      throw Object.assign(new Error('Not a file'), { code: 'not_a_file', status: 400 })
    }
    assertPreviewFileSize(info.size, descriptor)

    if (provider.type === 'local') {
      // Stream from a single open handle instead of buffering the whole file.
      // A 50MB PDF held in a Node Buffer is 50MB of shared server heap that an
      // aborted browser fetch never reclaims, and opening the path a second
      // time after the stat would re-run every check against a file that may
      // have changed. One handle, fstat'd and range-bounded, fixes both.
      handle = await open(fullPath, 'r')
      const stat = await handle.stat()
      if (stat.isDirectory()) {
        throw Object.assign(new Error('Not a file'), { code: 'not_a_file', status: 400 })
      }
      assertPreviewFileSize(stat.size, descriptor)

      const headers = buildFileContentHeaders({
        fileName: basename(relativePath),
        mime: descriptor.mime,
        size: stat.size,
      })
      for (const [name, value] of Object.entries(headers)) ctx.set(name, value)

      if (stat.size === 0) {
        await handle.close()
        handle = null
        ctx.body = Buffer.alloc(0)
        return
      }

      // `end` is inclusive, so a file that grows after the fstat still sends
      // exactly the bytes Content-Length promised.
      const stream = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: true })
      // createReadStream({ autoClose: true }) owns the handle from here.
      handle = null
      const abort = () => stream.destroy()
      ctx.req.once('aborted', abort)
      ctx.req.once('close', abort)
      ctx.body = stream
      return
    }

    // Remote backends (docker/ssh/...) have no local handle to stream from.
    // The second size check catches a file that grew between stat and read.
    const data = await provider.readFile(fullPath)
    assertPreviewFileSize(data.length, descriptor)
    const headers = buildFileContentHeaders({
      fileName: basename(relativePath),
      mime: descriptor.mime,
      size: data.length,
    })
    for (const [name, value] of Object.entries(headers)) ctx.set(name, value)
    ctx.body = data
  } catch (err: any) {
    handlePreviewError(ctx, err)
  } finally {
    if (handle) await handle.close().catch(() => { /* already failing */ })
  }
}
