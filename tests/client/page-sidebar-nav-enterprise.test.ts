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

  it('renders the local Hermes logo above the new chat action', async () => {
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
    expect(logo.text()).toContain('Hermes')
    expect(logo.find('img').attributes('src')).toBe('/logo.png')
    expect(logo.find('img').attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.page-sidebar-tabs').attributes('role')).toBeUndefined()
    expect(wrapper.find('.page-sidebar-tabs').element.firstElementChild).toBe(logo.element)

    await logo.trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat' })
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

    expect(labels).toEqual([
      'chat.newChat',
      'sidebar.search',
      'sidebar.expert',
      'sidebar.jobs',
      'sidebar.history',
    ])
  })

  it('routes expert and automation from the home page sidebar without going through settings', async () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'chat',
        primaryLabel: 'chat.newChat',
      },
    })

    await wrapper.findAll('.page-sidebar-tab')[2].trigger('click')
    await wrapper.findAll('.page-sidebar-tab')[3].trigger('click')
    await wrapper.findAll('.page-sidebar-tab')[4].trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat', query: { surface: 'expert' } })
    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.chat', query: { surface: 'automation' } })
    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.history' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.expert' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.jobs' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.settings' })
  })
})
