// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import readXlsxFile from 'read-excel-file/node'
import {
  getBinaryPreviewKind,
  getFileExtension,
  isBinaryPreviewFile,
  previewMimeMatches,
} from '@/utils/hermes/file-preview'
import {
  MAX_CELL_CHARACTERS,
  MAX_TABLE_CELLS,
  limitTabularRows,
} from '@/utils/hermes/tabular-preview'
import {
  DEFAULT_OOXML_ZIP_LIMITS,
  assertBoundedOoxmlArchive,
  assertBoundedOoxmlParts,
} from '@/utils/hermes/ooxml-archive'

const mockFilesApi = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  statFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  mkDir: vi.fn(),
  copyFile: vi.fn(),
  uploadFiles: vi.fn(),
  fetchFilePreviewBlob: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  getFilePreviewUrl: vi.fn(),
}))

vi.mock('@/api/hermes/files', () => mockFilesApi)

const { getLanguageFromPath, isPreviewableFile, useFilesStore } = await import('@/stores/hermes/files')

const FIXTURE_DIR = 'tests/fixtures/file-preview'

function fixtureBuffer(name: string): ArrayBuffer {
  const file = readFileSync(`${FIXTURE_DIR}/${name}`)
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}

describe('generated file preview formats', () => {
  // A central-directory-only ZIP: enough structure for the bounds check to
  // walk, with the declared uncompressed size as the single variable.
  function zipDirectoryFixture(uncompressedBytes: number): ArrayBuffer {
    const buffer = new ArrayBuffer(46 + 22)
    const view = new DataView(buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint32(24, uncompressedBytes, true)
    view.setUint32(46, 0x06054b50, true)
    view.setUint16(54, 1, true)
    view.setUint16(56, 1, true)
    view.setUint32(58, 46, true)
    view.setUint32(62, 0, true)
    return buffer
  }

  it('maps the four office extensions to dedicated renderers and validates MIME types', () => {
    expect(getFileExtension('reports/Q3 summary.XLSX')).toBe('.xlsx')
    expect(getBinaryPreviewKind('report.pdf')).toBe('pdf')
    expect(getBinaryPreviewKind('report.PDF')).toBe('pdf')
    expect(getBinaryPreviewKind('brief.docx')).toBe('docx')
    expect(getBinaryPreviewKind('deck.pptx')).toBe('presentation')
    expect(getBinaryPreviewKind('metrics.xlsx')).toBe('spreadsheet')

    // Legacy binary formats have no renderer here; they must keep the download
    // path rather than open an empty pane.
    expect(getBinaryPreviewKind('legacy.xls')).toBeNull()
    expect(getBinaryPreviewKind('legacy.doc')).toBeNull()
    expect(getBinaryPreviewKind('legacy.ppt')).toBeNull()
    expect(getBinaryPreviewKind('notes.md')).toBeNull()
    expect(isBinaryPreviewFile('metrics.csv')).toBe(false)

    expect(previewMimeMatches('pdf', 'application/pdf')).toBe(true)
    expect(previewMimeMatches('pdf', 'text/html')).toBe(false)
    expect(previewMimeMatches('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    expect(previewMimeMatches('presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true)
    expect(previewMimeMatches('spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=utf-8')).toBe(true)
    expect(previewMimeMatches('spreadsheet', 'application/octet-stream')).toBe(false)
  })

  it('keeps the existing image / markdown / html / text classification intact', () => {
    expect(isPreviewableFile('notes.md')).toBe(true)
    expect(isPreviewableFile('report.html')).toBe(true)
    expect(isPreviewableFile('diagram.png')).toBe(true)
    expect(isPreviewableFile('metrics.csv')).toBe(true)
    expect(getLanguageFromPath('metrics.csv')).toBe('plaintext')
    expect(getLanguageFromPath('package.json')).toBe('json')
    expect(getLanguageFromPath('src/main.rs')).toBe('rust')

    // The four new kinds join the previewable set without displacing anything.
    expect(isPreviewableFile('report.pdf')).toBe(true)
    expect(isPreviewableFile('brief.docx')).toBe(true)
    expect(isPreviewableFile('deck.pptx')).toBe(true)
    expect(isPreviewableFile('metrics.xlsx')).toBe(true)
    expect(isPreviewableFile('archive.zip')).toBe(false)
  })

  it('opens office files as binary previews without reading them as text', async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const store = useFilesStore()

    await store.openPreview({
      name: 'metrics.xlsx',
      path: 'reports/metrics.xlsx',
      isDir: false,
      size: 5_485,
      modTime: '2026-09-21T00:00:00.000Z',
    })

    expect(store.previewFile).toEqual({ path: 'reports/metrics.xlsx', type: 'spreadsheet' })
    expect(mockFilesApi.readFile).not.toHaveBeenCalled()

    await store.openPreview({
      name: 'deck.pptx',
      path: 'deck.pptx',
      isDir: false,
      size: 29_174,
      modTime: '2026-09-21T00:00:00.000Z',
    })
    expect(store.previewFile).toEqual({ path: 'deck.pptx', type: 'presentation' })
    expect(mockFilesApi.readFile).not.toHaveBeenCalled()
  })

  it('resolves chat-plane display paths for office files by probing, not reading', async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const store = useFilesStore()

    // The workspace-relative path misses (admin plane), the ws-prefixed one hits.
    mockFilesApi.statFile
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ name: 'report.pdf', path: 'workspace/report.pdf', isDir: false, size: 683, modTime: '' })

    await store.previewByDisplayPath('/workspace/report.pdf')

    expect(mockFilesApi.statFile).toHaveBeenNthCalledWith(1, 'report.pdf')
    expect(mockFilesApi.statFile).toHaveBeenNthCalledWith(2, 'workspace/report.pdf')
    expect(store.previewFile).toEqual({ path: 'workspace/report.pdf', type: 'pdf' })
    expect(mockFilesApi.readFile).not.toHaveBeenCalled()
  })

  it('opens a changed office file as a rendered document, not as a decoded patch', async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const store = useFilesStore()
    mockFilesApi.statFile.mockResolvedValueOnce({
      name: 'metrics.xlsx', path: 'reports/metrics.xlsx', isDir: false, size: 5_485, modTime: '',
    })

    await store.previewWorkspaceDiffFile({
      displayPath: '/workspace/reports/metrics.xlsx',
      changeId: 'change-1',
      fileId: 7,
      sessionId: 'session-1',
      profile: 'tenant-a',
    })

    // Binary bytes decoded as UTF-8 render as mojibake, so the diff card must
    // take the same blob path a plain card does — while keeping the diff
    // metadata so the patch tab stays reachable.
    expect(mockFilesApi.readFile).not.toHaveBeenCalled()
    expect(store.previewFile).toMatchObject({
      path: 'reports/metrics.xlsx',
      type: 'spreadsheet',
      diff: { changeId: 'change-1', fileId: 7, sessionId: 'session-1', profile: 'tenant-a' },
    })
    expect(store.previewFile).not.toHaveProperty('content')
  })

  it('still reads text files changed by a run as text', async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const store = useFilesStore()
    mockFilesApi.readFile.mockResolvedValueOnce({ path: 'src/a.ts', content: 'const a = 1' })

    await store.previewWorkspaceDiffFile({
      displayPath: '/workspace/src/a.ts',
      changeId: 'change-2',
      fileId: 1,
      sessionId: 'session-1',
    })

    expect(store.previewFile).toMatchObject({ type: 'text', content: 'const a = 1' })
  })

  it('enforces table and cell limits when flattening a worksheet', () => {
    const oversizedRows = Array.from({ length: MAX_TABLE_CELLS + 1 }, (_, index) => [index])
    const limited = limitTabularRows(oversizedRows)
    expect(limited.truncated).toBe(true)
    expect(limited.rows.length).toBeLessThanOrEqual(1_000)

    const longCell = limitTabularRows([['x'.repeat(MAX_CELL_CHARACTERS + 10)]])
    expect(longCell.truncated).toBe(true)
    expect(longCell.rows[0][0]).toHaveLength(MAX_CELL_CHARACTERS + 1)

    const mixed = limitTabularRows([[1, null, new Date('2026-09-21T00:00:00.000Z'), { a: 1 }]])
    expect(mixed.rows[0]).toEqual(['1', '', '2026-09-21T00:00:00.000Z', '{"a":1}'])
    expect(mixed.truncated).toBe(false)
  })

  it('rejects OOXML archives whose expanded entries exceed preview limits', () => {
    expect(() => assertBoundedOoxmlArchive(zipDirectoryFixture(1_024))).not.toThrow()
    expect(() => assertBoundedOoxmlArchive(zipDirectoryFixture(65 * 1024 * 1024))).toThrow(/not safe to preview/)
    expect(() => assertBoundedOoxmlArchive(new ArrayBuffer(22))).toThrow(/ZIP directory is missing/)
  })

  it('refuses an archive whose trailing EOCD record lies about the directory', () => {
    // A real workbook with a second, zero-entry end-of-central-directory record
    // appended. The guard used to read that record, walk no entries, and clear
    // every size limit, while JSZip went on parsing the real directory below it.
    const hostile = fixtureBuffer('hostile-appended-eocd.xlsx')
    expect(() => assertBoundedOoxmlArchive(hostile)).toThrow(/not safe to preview/)

    // The honest version of the same workbook still opens.
    expect(() => assertBoundedOoxmlArchive(fixtureBuffer('sample.xlsx'))).not.toThrow()
  })

  it('refuses a directory that does not abut the record describing it', () => {
    // 46 bytes of directory, then eight bytes of slack, then the record. The
    // record and the directory are no longer describing the same bytes, so an
    // entry could hide in the gap that this guard never measured.
    const buffer = new ArrayBuffer(46 + 8 + 22)
    const view = new DataView(buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint32(24, 1_024, true)
    const eocd = 46 + 8
    view.setUint32(eocd, 0x06054b50, true)
    view.setUint16(eocd + 8, 1, true)
    view.setUint16(eocd + 10, 1, true)
    view.setUint32(eocd + 12, 46, true)
    view.setUint32(eocd + 16, 0, true)
    expect(() => assertBoundedOoxmlArchive(buffer)).toThrow(/ZIP directory is invalid/)
  })

  it('refuses a directory whose declared size is longer than its entries', () => {
    // directorySize claims 54 bytes but the single 46-byte entry ends sooner,
    // so the walk cannot land on the declared end.
    const buffer = new ArrayBuffer(54 + 22)
    const view = new DataView(buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint32(24, 1_024, true)
    view.setUint32(54, 0x06054b50, true)
    view.setUint16(54 + 8, 1, true)
    view.setUint16(54 + 10, 1, true)
    view.setUint32(54 + 12, 54, true)
    view.setUint32(54 + 16, 0, true)
    expect(() => assertBoundedOoxmlArchive(buffer)).toThrow(/ZIP directory size is invalid/)
  })

  it('refuses a directory that declares no entries at all', () => {
    const buffer = new ArrayBuffer(22)
    const view = new DataView(buffer)
    view.setUint32(0, 0x06054b50, true)
    expect(() => assertBoundedOoxmlArchive(buffer)).toThrow(/declares no entries/)
  })

  it('refuses an entry that expands far beyond any real document', () => {
    // 34 MB of wordprocessing XML from 97 KB on disk. Nothing about the
    // declared sizes breaks the per-entry or total caps — only the ratio does.
    const bomb = fixtureBuffer('hostile-ratio-bomb.docx')
    expect(() => assertBoundedOoxmlArchive(bomb)).toThrow(/expands too much/)

    const entry = { name: 'word/document.xml', compressedBytes: 99_103, uncompressedBytes: 34_000_134 }
    expect(entry.uncompressedBytes).toBeLessThan(DEFAULT_OOXML_ZIP_LIMITS.maxEntryUncompressedBytes)
    expect(entry.uncompressedBytes).toBeLessThan(DEFAULT_OOXML_ZIP_LIMITS.maxTotalUncompressedBytes)
  })

  it('leaves small well-compressing parts alone', () => {
    // Below the ratio floor a high expansion factor is normal, not an attack.
    const summary = assertBoundedOoxmlArchive(fixtureBuffer('sample.pptx'))
    expect(summary.entries.length).toBeGreaterThan(0)
    expect(summary.totalUncompressedBytes).toBeGreaterThan(0)
    expect(summary.entries.some(entry => entry.name === '[Content_Types].xml')).toBe(true)
  })

  it('enforces a per-part budget on top of the archive-wide limits', () => {
    const summary = {
      entries: [
        { name: 'word/document.xml', compressedBytes: 900_000, uncompressedBytes: 9_000_000 },
        { name: 'word/styles.xml', compressedBytes: 900, uncompressedBytes: 9_000 },
      ],
      totalUncompressedBytes: 9_009_000,
    }
    expect(() => assertBoundedOoxmlParts(summary, [
      { name: 'word/document.xml', maxUncompressedBytes: 4 * 1024 * 1024 },
    ])).toThrow(/too large to render/)
    // Case folding, because part names come from the archive, not from us.
    expect(() => assertBoundedOoxmlParts(summary, [
      { name: 'WORD/DOCUMENT.XML', maxUncompressedBytes: 4 * 1024 * 1024 },
    ])).toThrow(/too large to render/)
    expect(() => assertBoundedOoxmlParts(summary, [
      { name: 'word/document.xml', maxUncompressedBytes: 16 * 1024 * 1024 },
    ])).not.toThrow()
  })

  it('accepts the real docx / pptx / xlsx fixtures and rejects a corrupted one', () => {
    for (const name of ['sample.docx', 'sample.pptx', 'sample.xlsx']) {
      const data = fixtureBuffer(name)
      expect(getBinaryPreviewKind(name)).not.toBeNull()
      expect(() => assertBoundedOoxmlArchive(data)).not.toThrow()
    }

    // Truncating the archive destroys the end-of-central-directory record,
    // which is the corrupt-file case the panel must surface as a download.
    const truncated = fixtureBuffer('sample.xlsx').slice(0, 512)
    expect(() => assertBoundedOoxmlArchive(truncated)).toThrow(/not safe to preview/)
  })

  it('parses the real xlsx fixture into the rows the table renders', async () => {
    const rows = await readXlsxFile(`${FIXTURE_DIR}/sample.xlsx`)
    const limited = limitTabularRows(rows)
    expect(limited.truncated).toBe(false)
    expect(limited.rows[0]).toEqual(['Region', 'Quarter', 'Revenue'])
    expect(limited.rows[1]).toEqual(['北京', 'Q1', '1200'])
    expect(limited.rows).toHaveLength(4)
  })

  it('ships a pdf fixture that is a real single-page document', () => {
    const pdf = readFileSync(`${FIXTURE_DIR}/sample.pdf`)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('/Type /Page')
    expect(pdf.subarray(-6).toString('latin1').trim()).toBe('%%EOF')
  })

  it('routes office previews through the binary endpoint and keeps a download fallback', () => {
    const filePreviewSource = readFileSync('packages/client/src/components/hermes/files/FilePreview.vue', 'utf8')

    // Office bytes must come from the preview endpoint, never from readFile.
    expect(filePreviewSource).toContain('fetchFilePreviewBlob')
    expect(filePreviewSource).toContain('previewMimeMatches')
    // A failed fetch or a renderer that throws lands on an error plus a download.
    expect(filePreviewSource).toMatch(/binaryError[\s\S]*files\.downloadInstead/)
    expect(filePreviewSource).toContain('@error="handleRendererError"')
    // The existing HTML/image/text branches are untouched.
    expect(filePreviewSource).toContain('sandbox="allow-same-origin"')
    expect(filePreviewSource).toContain("filesStore.previewFile.type === 'image'")
  })
})
