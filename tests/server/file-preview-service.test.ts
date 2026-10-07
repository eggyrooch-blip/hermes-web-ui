import { describe, expect, it } from 'vitest'
import {
  assertPreviewFileSize,
  buildFileContentHeaders,
  getFilePreviewDescriptor,
} from '../../packages/server/src/services/hermes/file-preview'

describe('file preview service', () => {
  it('allowlists preview extensions with per-format MIME and size limits', () => {
    expect(getFilePreviewDescriptor('report.PDF')).toMatchObject({ kind: 'pdf', mime: 'application/pdf' })
    expect(getFilePreviewDescriptor('report.docx')).toMatchObject({
      kind: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect(getFilePreviewDescriptor('report.pptx')).toMatchObject({ kind: 'presentation' })
    expect(getFilePreviewDescriptor('report.xlsx')).toMatchObject({ kind: 'spreadsheet' })
    expect(getFilePreviewDescriptor('report.pdf')!.maxBytes).toBeGreaterThan(0)

    // Anything outside the allowlist gets a 415 upstream of any file read.
    expect(getFilePreviewDescriptor('report.xls')).toBeNull()
    expect(getFilePreviewDescriptor('notes.md')).toBeNull()
    expect(getFilePreviewDescriptor('../../config.yaml')).toBeNull()
    expect(getFilePreviewDescriptor('archive.pdf.zip')).toBeNull()
  })

  it('rejects invalid and oversized byte counts', () => {
    const descriptor = getFilePreviewDescriptor('report.pdf')!
    expect(() => assertPreviewFileSize(descriptor.maxBytes, descriptor)).not.toThrow()
    expect(() => assertPreviewFileSize(descriptor.maxBytes + 1, descriptor)).toThrow(/too large/i)
    expect(() => assertPreviewFileSize(-1, descriptor)).toThrow(/invalid/i)
    expect(() => assertPreviewFileSize(Number.NaN, descriptor)).toThrow(/invalid/i)
  })

  it('builds safe inline and attachment response headers', () => {
    const inline = buildFileContentHeaders({
      fileName: '../季度报告.pdf',
      mime: 'application/pdf',
      size: 42,
    })
    expect(inline).toMatchObject({
      'Content-Type': 'application/pdf',
      'Content-Length': '42',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    })
    expect(inline['Content-Disposition']).toContain('inline;')
    expect(inline['Content-Disposition']).toContain("filename*=UTF-8''")
    // The ASCII fallback never carries the traversal prefix or raw non-ASCII.
    expect(inline['Content-Disposition']).not.toContain('../')
    expect(inline['Content-Disposition']).toContain('filename="____.pdf"')

    const attachment = buildFileContentHeaders({
      fileName: 'report.pdf',
      mime: 'application/pdf',
      size: 42,
      download: true,
    })
    expect(attachment['Content-Disposition']).toContain('attachment;')
  })
})
