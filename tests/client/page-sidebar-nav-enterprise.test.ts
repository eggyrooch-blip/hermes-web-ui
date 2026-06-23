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

  it('keeps expert and automation out of the chat page sidebar', () => {
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
      'sidebar.history',
    ])
  })

  it('does not route expert or automation actions from the chat page sidebar', async () => {
    const wrapper = mount(PageSidebarNav, {
      props: {
        active: 'chat',
        primaryLabel: 'chat.newChat',
      },
    })

    await wrapper.findAll('.page-sidebar-tab')[2].trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.history' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.expert' })
    expect(pushMock).not.toHaveBeenCalledWith({ name: 'hermes.jobs' })
  })
})
