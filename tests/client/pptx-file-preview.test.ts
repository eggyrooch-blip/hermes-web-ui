// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PptxFilePreview from '@/components/hermes/files/PptxFilePreview.vue'

const pptxMocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  goToSlide: vi.fn(async () => undefined),
  open: vi.fn(),
  setZoom: vi.fn(async () => undefined),
  zipLimits: { maxEntries: 2_000 },
}))

vi.mock('@aiden0z/pptx-renderer', () => ({
  PptxViewer: { open: pptxMocks.open },
  RECOMMENDED_ZIP_LIMITS: pptxMocks.zipLimits,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButtonGroup: { template: '<div class="button-group"><slot /></div>' },
  NButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NInputNumber: {
    props: ['value', 'size'],
    emits: ['update:value'],
    template: '<input type="number" :value="value" @input="$emit(\'update:value\', Number($event.target.value))">',
  },
  NSpin: {
    props: ['show'],
    template: '<div class="spin"><slot /></div>',
  },
}))

describe('PptxFilePreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pptxMocks.open.mockImplementation(async (_data, container: HTMLElement, options) => {
      const slide = document.createElement('section')
      slide.innerHTML = [
        '<a href="https://evil.test" onclick="steal()">external link</a>',
        '<img src="https://evil.test/pixel.png" onerror="steal()">',
        '<form action="https://evil.test"><input></form>',
        '<iframe src="https://evil.test"></iframe>',
      ].join('')
      container.append(slide)
      options.onSlideRendered?.(0, slide)
      options.onSlideChange?.(0)
      return {
        slideCount: 2,
        currentSlideIndex: 0,
        goToSlide: pptxMocks.goToSlide,
        setZoom: pptxMocks.setZoom,
        destroy: pptxMocks.destroy,
      }
    })
  })

  it('loads untrusted decks with bounded lazy options and removes active content', async () => {
    const wrapper = mount(PptxFilePreview, {
      props: { data: new Uint8Array([1, 2, 3]).buffer },
    })

    await vi.waitFor(() => expect(pptxMocks.open).toHaveBeenCalledOnce())
    const [, , options] = pptxMocks.open.mock.calls[0]
    expect(options).toMatchObject({
      renderMode: 'slide',
      fitMode: 'contain',
      zoomPercent: 100,
      zipLimits: pptxMocks.zipLimits,
      lazySlides: true,
      lazyMedia: true,
      pdfjs: false,
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)

    const host = wrapper.get('.pptx-renderer-host')
    expect(host.find('iframe').exists()).toBe(false)
    expect(host.find('form').exists()).toBe(false)
    expect(host.find('a').attributes('href')).toBeUndefined()
    expect(host.find('a').attributes('onclick')).toBeUndefined()
    expect(host.find('img').attributes('src')).toBeUndefined()
    expect(host.find('img').attributes('onerror')).toBeUndefined()

    await wrapper.findAll('button')[1].trigger('click')
    expect(pptxMocks.goToSlide).toHaveBeenCalledWith(1)

    wrapper.unmount()
    expect(pptxMocks.destroy).toHaveBeenCalledOnce()
    expect(options.signal.aborted).toBe(true)
  })

  it('blocks hyperlink handlers the sanitizer cannot reach', async () => {
    // Stripping href/onclick only removes ATTRIBUTES. The renderer wires its
    // hyperlinks with addEventListener, and there is no way to unregister a
    // listener someone else added — so a deck whose slide is one full-bleed
    // external link would still navigate on any click inside it.
    const opened = vi.fn()
    const slideHandler = vi.fn(() => opened('https://evil.test'))
    pptxMocks.open.mockImplementation(async (_data, container: HTMLElement, options) => {
      const slide = document.createElement('section')
      const hotspot = document.createElement('div')
      hotspot.className = 'hotspot'
      hotspot.addEventListener('click', slideHandler)
      slide.append(hotspot)
      container.append(slide)
      options.onSlideRendered?.(0, slide)
      return {
        slideCount: 1,
        currentSlideIndex: 0,
        goToSlide: pptxMocks.goToSlide,
        setZoom: pptxMocks.setZoom,
        destroy: pptxMocks.destroy,
      }
    })

    const wrapper = mount(PptxFilePreview, {
      attachTo: document.body,
      props: { data: new Uint8Array([1, 2, 3]).buffer },
    })
    await vi.waitFor(() => expect(pptxMocks.open).toHaveBeenCalledOnce())

    const hotspot = wrapper.get('.hotspot')
    hotspot.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    hotspot.element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true }))

    expect(slideHandler).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()

    // The blocker is scoped to the slide host; the toolbar still works.
    wrapper.unmount()
  })

  it('stops blocking once the preview is gone', async () => {
    const wrapper = mount(PptxFilePreview, {
      attachTo: document.body,
      props: { data: new Uint8Array([1, 2, 3]).buffer },
    })
    await vi.waitFor(() => expect(pptxMocks.open).toHaveBeenCalledOnce())
    const host = wrapper.get('.pptx-renderer-host').element as HTMLElement
    wrapper.unmount()

    const afterUnmount = vi.fn()
    host.addEventListener('click', afterUnmount)
    document.body.append(host)
    host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(afterUnmount).toHaveBeenCalledOnce()
    host.remove()
  })
})
