/**
 * The 全部类型 filter from the prototype's LibraryScreen, mapped onto real
 * files by extension. Directories always pass: they cannot be typed, and
 * hiding them would break navigation while a filter is active.
 */
export type FileTypeFilter = 'all' | 'doc' | 'sheet' | 'image' | 'other'

const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'doc', 'docx', 'pdf', 'html', 'htm', 'rtf'])
const SHEET_EXTS = new Set(['xls', 'xlsx', 'csv', 'tsv', 'numbers'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

export function fileTypeOf(name: string): Exclude<FileTypeFilter, 'all'> {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (DOC_EXTS.has(ext)) return 'doc'
  if (SHEET_EXTS.has(ext)) return 'sheet'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return 'other'
}

export function matchesTypeFilter(
  entry: { name: string; isDir: boolean },
  filter: FileTypeFilter,
): boolean {
  if (filter === 'all' || entry.isDir) return true
  return fileTypeOf(entry.name) === filter
}
