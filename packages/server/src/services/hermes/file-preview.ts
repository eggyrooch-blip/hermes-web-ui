import { basename, extname } from 'path'

// Allowlist + per-format byte caps for the binary preview endpoint. Only the
// four containers the panel can actually render are listed: an extension that
// is not here gets a 415 and the UI keeps offering a download, which is the
// behaviour every non-previewable file already had.
export type FilePreviewKind = 'pdf' | 'docx' | 'presentation' | 'spreadsheet'

export interface FilePreviewDescriptor {
  kind: FilePreviewKind
  mime: string
  maxBytes: number
}

const MEBIBYTE = 1024 * 1024

function envByteLimit(name: string, fallback: number): number {
  const value = Number.parseInt(String(process.env[name] || ''), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Caps are per format because the cost of rendering differs: a PDF streams
// page by page, while a docx/pptx/xlsx is fully expanded in the browser.
const PREVIEW_LIMITS: Record<FilePreviewKind, number> = {
  pdf: envByteLimit('MAX_PDF_PREVIEW_SIZE', 50 * MEBIBYTE),
  docx: envByteLimit('MAX_DOCX_PREVIEW_SIZE', 25 * MEBIBYTE),
  presentation: envByteLimit('MAX_PRESENTATION_PREVIEW_SIZE', 50 * MEBIBYTE),
  spreadsheet: envByteLimit('MAX_SPREADSHEET_PREVIEW_SIZE', 25 * MEBIBYTE),
}

const PREVIEW_BY_EXTENSION: Record<string, Omit<FilePreviewDescriptor, 'maxBytes'>> = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.pptx': { kind: 'presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.xlsx': { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
}

export function getFilePreviewDescriptor(fileName: string): FilePreviewDescriptor | null {
  const entry = PREVIEW_BY_EXTENSION[extname(fileName).toLowerCase()]
  return entry ? { ...entry, maxBytes: PREVIEW_LIMITS[entry.kind] } : null
}

export function assertPreviewFileSize(size: number, descriptor: FilePreviewDescriptor): void {
  if (!Number.isFinite(size) || size < 0) {
    throw Object.assign(new Error('Invalid file size'), { code: 'invalid_file', status: 400 })
  }
  if (size > descriptor.maxBytes) {
    throw Object.assign(
      new Error(`File too large to preview: ${size} bytes (limit ${descriptor.maxBytes})`),
      { code: 'file_too_large', status: 413 },
    )
  }
}

function safeAsciiFilename(fileName: string): string {
  return basename(fileName)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_') || 'file'
}

// `nosniff` plus an exact Content-Type is what lets the client refuse a
// response whose type does not match the extension it dispatched on.
export function buildFileContentHeaders(options: {
  fileName: string
  mime: string
  size: number
  download?: boolean
}): Record<string, string> {
  const fileName = basename(options.fileName) || 'file'
  const disposition = options.download ? 'attachment' : 'inline'
  return {
    'Content-Type': options.mime,
    'Content-Disposition': `${disposition}; filename="${safeAsciiFilename(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Content-Length': String(options.size),
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
}
