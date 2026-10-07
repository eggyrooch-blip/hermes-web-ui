// Classification for the four formats that need a binary fetch plus a
// dedicated renderer (pdf / docx / pptx / xlsx). Image, markdown, HTML and
// text keep the predicates they already have in `stores/hermes/files`, which
// read the file as UTF-8 text — these four cannot go down that path at all,
// so they are the only kinds this module knows about.
export type BinaryPreviewKind = 'pdf' | 'docx' | 'presentation' | 'spreadsheet'
export type FilePreviewKind = 'image' | 'markdown' | 'text' | 'html' | BinaryPreviewKind

// Only the OOXML/PDF containers our bundled renderers can actually parse.
// The legacy binary formats (.doc/.xls/.ppt) are deliberately absent: marking
// them previewable would replace a working download with a blank pane.
const BINARY_PREVIEW_KINDS: Record<string, BinaryPreviewKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'presentation',
  '.xlsx': 'spreadsheet',
}

const BINARY_PREVIEW_MIMES: Record<BinaryPreviewKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function getFileExtension(name: string): string {
  const basename = name.split(/[\\/]/).pop() || ''
  const index = basename.lastIndexOf('.')
  return index >= 0 ? basename.slice(index).toLowerCase() : ''
}

export function getBinaryPreviewKind(name: string): BinaryPreviewKind | null {
  return BINARY_PREVIEW_KINDS[getFileExtension(name)] || null
}

export function isBinaryPreviewFile(name: string): boolean {
  return getBinaryPreviewKind(name) !== null
}

// The renderers parse whatever bytes they are handed, so a response whose
// Content-Type does not match the extension we dispatched on is refused
// before it reaches docx-preview / pdfjs / the pptx renderer.
export function previewMimeMatches(kind: BinaryPreviewKind, mime: string): boolean {
  return mime.split(';')[0].trim().toLowerCase() === BINARY_PREVIEW_MIMES[kind]
}
