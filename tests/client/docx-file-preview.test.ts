// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const renderAsync = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('docx-preview', () => ({ renderAsync }))

vi.mock('naive-ui', () => ({
  NSpin: { props: ['show'], template: '<div class="spin"><slot /></div>' },
}))

import DocxFilePreview from '@/components/hermes/files/DocxFilePreview.vue'

function fixture(name: string): ArrayBuffer {
  const file = readFileSync(`tests/fixtures/file-preview/${name}`)
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}

describe('DocxFilePreview', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders a real document', async () => {
    const errors: Error[] = []
    const wrapper = mount(DocxFilePreview, {
      props: { data: fixture('sample.docx'), onError: (error: Error) => errors.push(error) },
    })
    await vi.waitFor(() => expect(renderAsync).toHaveBeenCalledOnce())
    expect(errors).toEqual([])
    wrapper.unmount()
  })

  it('refuses a decompression bomb BEFORE handing it to the renderer', async () => {
    // The point of the budget is that docx-preview never starts: it parses
    // word/document.xml and builds the DOM before it returns, so a check that
    // runs after renderAsync can only count damage already done.
    const errors: Error[] = []
    const wrapper = mount(DocxFilePreview, {
      props: { data: fixture('hostile-ratio-bomb.docx'), onError: (error: Error) => errors.push(error) },
    })

    await vi.waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0].message).toMatch(/not safe to preview/)
    expect(renderAsync).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('refuses an oversized word/document.xml before handing it to the renderer', async () => {
    // An archive that clears every package-wide limit but whose single main
    // part is larger than the renderer can build a DOM from.
    vi.resetModules()
    vi.doMock('@/utils/hermes/ooxml-archive', async () => {
      const actual = await vi.importActual<typeof import('@/utils/hermes/ooxml-archive')>(
        '@/utils/hermes/ooxml-archive',
      )
      return {
        ...actual,
        assertBoundedOoxmlArchive: () => ({
          entries: [{ name: 'word/document.xml', compressedBytes: 2_000_000, uncompressedBytes: 40 * 1024 * 1024 }],
          totalUncompressedBytes: 40 * 1024 * 1024,
        }),
      }
    })
    const Fresh = (await import('@/components/hermes/files/DocxFilePreview.vue')).default

    const errors: Error[] = []
    const wrapper = mount(Fresh, {
      props: { data: fixture('sample.docx'), onError: (error: Error) => errors.push(error) },
    })

    await vi.waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0].message).toMatch(/word\/document\.xml is too large to render/)
    expect(renderAsync).not.toHaveBeenCalled()
    wrapper.unmount()
    vi.doUnmock('@/utils/hermes/ooxml-archive')
  })
})
