export interface ZipPreviewLimits {
  maxEntries: number
  maxEntryUncompressedBytes: number
  maxTotalUncompressedBytes: number
  /**
   * Highest expansion factor a single entry may declare. Office XML parts
   * normally compress 5-20x; a part that claims 200x is a decompression bomb,
   * not a document. Only applied above `ratioCheckFloorBytes` so that a tiny
   * part compressing unusually well is not mistaken for an attack.
   */
  maxEntryCompressionRatio: number
  ratioCheckFloorBytes: number
}

export const DEFAULT_OOXML_ZIP_LIMITS: ZipPreviewLimits = {
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxEntryCompressionRatio: 200,
  ratioCheckFloorBytes: 64 * 1024,
}

export interface OoxmlArchiveEntry {
  name: string
  compressedBytes: number
  uncompressedBytes: number
}

export interface OoxmlArchiveSummary {
  entries: OoxmlArchiveEntry[]
  totalUncompressedBytes: number
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const MIN_END_RECORD_SIZE = 22
const MAX_ZIP_COMMENT_SIZE = 0xffff
const CENTRAL_DIRECTORY_HEADER_SIZE = 46

function invalidArchive(message: string): Error {
  return new Error(`Office archive is not safe to preview: ${message}`)
}

/**
 * Find THE end-of-central-directory record — the one that actually terminates
 * the file, whose declared comment length consumes every remaining byte.
 *
 * Accepting any trailing EOCD signature (the previous behaviour) let an
 * attacker append a second, lying EOCD after a real archive: the guard would
 * read that one's entry count (e.g. 0) and walk no entries at all, clearing
 * every size limit below, while JSZip — which docx-preview and the pptx
 * renderer use — went on to parse and inflate the real central directory. The
 * check and the parse must agree on which directory they are describing, so
 * only a terminal record counts.
 */
function findEndRecord(view: DataView): number {
  const firstCandidate = view.byteLength - MIN_END_RECORD_SIZE
  const lowerBound = Math.max(0, firstCandidate - MAX_ZIP_COMMENT_SIZE)
  for (let offset = firstCandidate; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue
    const commentSize = view.getUint16(offset + 20, true)
    if (offset + MIN_END_RECORD_SIZE + commentSize === view.byteLength) return offset
  }
  throw invalidArchive('ZIP directory is missing')
}

/**
 * Validate an OOXML (docx/pptx/xlsx) package against preview limits WITHOUT
 * inflating it, and return what the central directory declares so callers can
 * apply their own, tighter per-part budgets.
 *
 * Every structural check here exists so the bytes this function measured are
 * the same bytes the renderer will later inflate.
 */
export function assertBoundedOoxmlArchive(
  data: ArrayBuffer,
  limits: ZipPreviewLimits = DEFAULT_OOXML_ZIP_LIMITS,
): OoxmlArchiveSummary {
  if (data.byteLength < MIN_END_RECORD_SIZE) throw invalidArchive('file is truncated')
  const view = new DataView(data)
  const endOffset = findEndRecord(view)
  const diskNumber = view.getUint16(endOffset + 4, true)
  const directoryDisk = view.getUint16(endOffset + 6, true)
  const entriesOnDisk = view.getUint16(endOffset + 8, true)
  const entryCount = view.getUint16(endOffset + 10, true)
  const directorySize = view.getUint32(endOffset + 12, true)
  const directoryOffset = view.getUint32(endOffset + 16, true)

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw invalidArchive('multi-disk ZIP files are unsupported')
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw invalidArchive('ZIP64 files are unsupported')
  }
  // An OOXML package always has parts. A zero-entry directory is either not a
  // document or a forged record trying to skip the walk below.
  if (entryCount === 0) throw invalidArchive('ZIP directory declares no entries')
  if (entryCount > limits.maxEntries) throw invalidArchive('too many archive entries')
  // The central directory must sit immediately before the record that
  // describes it; anything else means the two disagree about what is indexed.
  if (directoryOffset + directorySize !== endOffset) throw invalidArchive('ZIP directory is invalid')

  const directoryEnd = directoryOffset + directorySize
  const entries: OoxmlArchiveEntry[] = []
  const nameBytes = new Uint8Array(data)
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let cursor = directoryOffset
  let totalUncompressedBytes = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_DIRECTORY_HEADER_SIZE > directoryEnd
      || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_ENTRY) {
      throw invalidArchive('ZIP entry metadata is invalid')
    }
    const compressedBytes = view.getUint32(cursor + 20, true)
    const uncompressedBytes = view.getUint32(cursor + 24, true)
    if (uncompressedBytes === 0xffffffff || compressedBytes === 0xffffffff) {
      throw invalidArchive('ZIP64 entries are unsupported')
    }
    if (uncompressedBytes > limits.maxEntryUncompressedBytes) {
      throw invalidArchive('an archive entry is too large')
    }
    if (uncompressedBytes > limits.ratioCheckFloorBytes
      && uncompressedBytes / Math.max(compressedBytes, 1) > limits.maxEntryCompressionRatio) {
      throw invalidArchive('an archive entry expands too much to be a document')
    }
    totalUncompressedBytes += uncompressedBytes
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw invalidArchive('expanded archive is too large')
    }
    const fileNameSize = view.getUint16(cursor + 28, true)
    const extraSize = view.getUint16(cursor + 30, true)
    const entryCommentSize = view.getUint16(cursor + 32, true)
    const nameStart = cursor + CENTRAL_DIRECTORY_HEADER_SIZE
    const nameEnd = nameStart + fileNameSize
    if (nameEnd > directoryEnd) throw invalidArchive('ZIP entry metadata is invalid')
    entries.push({
      name: decoder.decode(nameBytes.subarray(nameStart, nameEnd)),
      compressedBytes,
      uncompressedBytes,
    })
    cursor = nameEnd + extraSize + entryCommentSize
  }
  // The walk must land exactly on the end of the directory: trailing slack
  // would mean entries this guard never measured.
  if (cursor !== directoryEnd) throw invalidArchive('ZIP directory size is invalid')

  return { entries, totalUncompressedBytes }
}

export interface PartBudget {
  /** Entry name, matched case-insensitively against the archive's parts. */
  name: string
  maxUncompressedBytes: number
}

/**
 * Apply a per-part budget on top of the archive-wide limits.
 *
 * The archive limits bound what the whole package may expand to; they do not
 * bound what a SINGLE XML part may expand to, and a renderer that builds one
 * DOM node per element is bounded by that part, not by the package. Checking
 * declared sizes here means an oversized part is refused before the renderer
 * starts parsing rather than after it has already built the DOM.
 */
export function assertBoundedOoxmlParts(
  summary: OoxmlArchiveSummary,
  budgets: readonly PartBudget[],
): void {
  for (const budget of budgets) {
    const wanted = budget.name.toLowerCase()
    for (const entry of summary.entries) {
      if (entry.name.toLowerCase() !== wanted) continue
      if (entry.uncompressedBytes > budget.maxUncompressedBytes) {
        throw invalidArchive(`${budget.name} is too large to render`)
      }
    }
  }
}
