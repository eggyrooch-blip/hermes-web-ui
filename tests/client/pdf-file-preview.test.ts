// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

const pdfMocks = vi.hoisted(() => ({
  getPage: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(),
  destroy: vi.fn(async () => undefined),
  GlobalWorkerOptions: { workerSrc: '' },
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: pdfMocks.GlobalWorkerOptions,
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 5,
      getPage: pdfMocks.getPage,
      destroy: pdfMocks.destroy,
    }),
  }),
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'blob:worker' }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

vi.mock('naive-ui', () => ({
  NButtonGroup: { template: '<div class="button-group"><slot /></div>' },
  NButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NInputNumber: {
    props: ['value'],
    emits: ['update:value'],
    template: '<input type="number" :value="value" @input="$emit(\'update:value\', Number($event.target.value))">',
  },
  NSpin: { props: ['show'], template: '<div class="spin"><slot /></div>' },
}))

import PdfFilePreview from '@/components/hermes/files/PdfFilePreview.vue'

function makePage(index: number) {
  return {
    index,
    getViewport: () => ({ width: 100 + index, height: 200 + index }),
    render: (options: any) => {
      pdfMocks.render(index, options)
      return { promise: Promise.resolve(), cancel: pdfMocks.cancel }
    },
  }
}

describe('PdfFilePreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as any
  })

  it('drops a slow render whose page the user already left', async () => {
    // Page 1 resolves first (initial load). Then two paging clicks land while
    // the first getPage is still pending; when the stale one finally resolves
    // it must not touch the canvas, or the reader sees the page they left, or
    // pdf.js throws "canvas already in use" and the preview falls into its
    // error state.
    const firstLoad = deferred<any>()
    pdfMocks.getPage.mockImplementationOnce(() => firstLoad.promise)
    const wrapper = mount(PdfFilePreview, { props: { data: new Uint8Array([1, 2, 3]).buffer } })
    firstLoad.resolve(makePage(1))
    await vi.waitFor(() => expect(pdfMocks.render).toHaveBeenCalledTimes(1))
    expect(pdfMocks.render.mock.calls[0][0]).toBe(1)

    const slow = deferred<any>()
    const fast = deferred<any>()
    pdfMocks.getPage.mockImplementationOnce(() => slow.promise)
    pdfMocks.getPage.mockImplementationOnce(() => fast.promise)

    const [, next] = wrapper.findAll('button')
    await next.trigger('click')
    await next.trigger('click')
    await vi.waitFor(() => expect(pdfMocks.getPage).toHaveBeenCalledTimes(3))

    // The newest request completes first, the stale one second.
    fast.resolve(makePage(3))
    await vi.waitFor(() => expect(pdfMocks.render).toHaveBeenCalledTimes(2))
    slow.resolve(makePage(2))
    await Promise.resolve()
    await Promise.resolve()

    const renderedPages = pdfMocks.render.mock.calls.map(call => call[0])
    expect(renderedPages).toEqual([1, 3])
    expect(renderedPages).not.toContain(2)
    wrapper.unmount()
  })
})
