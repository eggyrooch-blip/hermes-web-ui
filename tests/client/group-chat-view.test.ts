// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const storeMock = vi.hoisted(() => ({
  connect: vi.fn(),
  loadRooms: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/group-chat', () => ({
  useGroupChatStore: () => storeMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/hermes/group-chat/GroupChatPanel.vue', () => ({
  default: { template: '<div>GroupChatPanel</div>' },
}))

import GroupChatView from '@/views/hermes/GroupChatView.vue'

describe('GroupChatView user mode', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    storeMock.connect.mockClear()
    storeMock.loadRooms.mockClear()
    storeMock.disconnect.mockClear()
  })

  it('opens the group-chat panel in user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(GroupChatView)

    expect(storeMock.connect).toHaveBeenCalledOnce()
    expect(storeMock.loadRooms).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('GroupChatPanel')

    wrapper.unmount()
    expect(storeMock.disconnect).toHaveBeenCalledOnce()
  })

  it('keeps the existing group-chat backend flow outside user mode', () => {
    const wrapper = mount(GroupChatView)

    expect(storeMock.connect).toHaveBeenCalledOnce()
    expect(storeMock.loadRooms).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('GroupChatPanel')

    wrapper.unmount()
    expect(storeMock.disconnect).toHaveBeenCalledOnce()
  })
})
