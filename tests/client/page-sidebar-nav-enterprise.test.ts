// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const pushMock = vi.hoisted(() => vi.fn())
const openSessionSearchMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'

// 应用 is deliberately absent: AppsView still renders mock data, so its entry
// point stays out of the sidebar until a real apps API lands.
describe('PageSidebarNav enterprise chrome', () => {
  beforeEach(() => {
    pushMock.mockClear()
    openSessionSearchMock.mockClear()
  })

  it('does not render the API relay promotion link', () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'chat',
        primaryLabel: 'chat.newChat',
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.apiRelay')
  })

  it('renders the KippiesWork wordmark above the new chat action', async () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'chat',
        primaryLabel: 'chat.newChat',
      },
    })

    const logo = wrapper.find('.page-sidebar-logo')
    expect(logo.exists()).toBe(true)
    expect(logo.element.tagName).toBe('A')
    expect(logo.attributes('href')).toBe('/#/hermes/chat')
    // The logo is the design's finished combination mark, shipped as FOUR
    // bitmaps: mascot and wordmark are separate images (so the mascot can be
    // resized without dragging the lettering with it), each with a light and a
    // dark copy (the ink is baked into the pixels, so one file cannot serve both
    // grounds). It replaced a merged SVG outline of the wordmark alone.
    //
    // Both copies of each piece must be in the DOM: the theme swap is a CSS rule
    // (`.kwlogo-l` / `.kwlogo-d`), not a JS pick, so that the very first frame is
    // already correct instead of flashing the light logo in dark mode.
    const imgs = logo.findAll('img')
    expect(imgs).toHaveLength(4)
    expect(imgs.filter((i) => i.classes().includes('kwlogo-l'))).toHaveLength(2)
    expect(imgs.filter((i) => i.classes().includes('kwlogo-d'))).toHaveLength(2)
    // Exactly one accessible name for the whole logo — four images naming
    // themselves would have a screen reader read the brand four times.
    expect(imgs.filter((i) => i.attributes('alt'))).toHaveLength(1)
    expect(imgs[0].attributes('alt')).toBe('KippiesWork')
    expect(imgs.slice(1).every((i) => i.attributes('aria-hidden') === 'true')).toBe(true)
    // The mascot is the taller of the two pieces — that contrast is the point of
    // splitting them, so it is worth pinning.
    expect(Number(imgs[0].attributes('height'))).toBeGreaterThan(
      Number(imgs[2].attributes('height')),
    )
    expect(wrapper.find('.page-sidebar-tabs').attributes('role')).toBeUndefined()
    // The wordmark shares the header row with the search action, so the
    // header block is what leads the nav and the wordmark leads the header.
    const head = wrapper.find('.page-sidebar-head')
    expect(wrapper.find('.page-sidebar-tabs').element.firstElementChild).toBe(head.element)
    expect(head.element.firstElementChild).toBe(logo.element)

    await logo.trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat' })
  })

  it('keeps the local Hermes logo on reused narrow sidebar variants', () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'group',
        primaryLabel: 'chat.newChat',
      },
    })

    const logo = wrapper.find('.page-sidebar-logo')
    expect(logo.exists()).toBe(true)
    expect(logo.attributes('href')).toBe('/#/hermes/chat')
    // The wordmark shares the header row with the search action, so the
    // header block is what leads the nav and the wordmark leads the header.
    const head = wrapper.find('.page-sidebar-head')
    expect(wrapper.find('.page-sidebar-tabs').element.firstElementChild).toBe(head.element)
    expect(head.element.firstElementChild).toBe(logo.element)
  })

  it('shows expert and automation directly in the home page sidebar before history', () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'chat',
        primaryLabel: 'chat.newChat',
      },
    })

    const labels = wrapper
      .findAll('.page-sidebar-tab')
      .map(button => button.text())

    // Nav follows the KippiesWork design: search moved into the header row,
    // the market is ONE row (its three sections are tabs on the page), and the
    // projects surface is gone entirely.
    expect(labels).toEqual([
      'chat.newChat',
      'agentsHub.title',
      'sidebar.marketsidebar.marketHint',
      'sidebar.jobs',
      'sidebar.files',
    ])
  })

  it('routes expert and automation from the home page sidebar without going through settings', async () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'chat',
        primaryLabel: 'chat.newChat',
      },
    })

    // Click by label rather than index so inserting a tab cannot silently
    // repoint these assertions at the wrong button.
    const byLabel = (label: string) =>
      wrapper.findAll('.page-sidebar-tab').find(button => button.text() === label)!
    await byLabel('sidebar.marketsidebar.marketHint').trigger('click')
    await byLabel('agentsHub.title').trigger('click')
    await byLabel('sidebar.jobs').trigger('click')

    // The market row lands on its first section.
    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat', query: { surface: 'expert' } })
    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat', query: { surface: 'agents' } })
    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat', query: { surface: 'automation' } })
    // The prototype nav carries no history row; the history page lives in the
    // task-list filter popover instead.
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.history' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.expert' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.jobs' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.settings' })
  })
})
