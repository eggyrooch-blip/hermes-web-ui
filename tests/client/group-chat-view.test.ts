// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const storeMock = vi.hoisted(() => ({
  connect: vi.fn(),
  loadRooms: vi.fn(),
  disconnect: vi.fn(),
  joinRoom: vi.fn(),
  currentRoomId: null,
  rooms: [],
}))

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
}))

const routeMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
}))

const settingsStoreMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeMock,
  useRouter: () => routerMock,
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/group-chat', () => ({
  useGroupChatStore: () => storeMock,
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStoreMock,
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
    storeMock.joinRoom.mockClear()
    settingsStoreMock.fetchSettings.mockClear()
    storeMock.currentRoomId = null
    storeMock.rooms = []
    routerMock.replace.mockClear()
    routeMock.params = {}
  })

  it('opens the group-chat panel in user mode', async () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(GroupChatView)
    await flushPromises()

    expect(storeMock.connect).toHaveBeenCalledOnce()
    expect(storeMock.loadRooms).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('GroupChatPanel')

    wrapper.unmount()
    expect(storeMock.disconnect).toHaveBeenCalledOnce()
  })

  it('keeps the existing group-chat backend flow outside user mode', async () => {
    const wrapper = mount(GroupChatView)
    await flushPromises()

    expect(storeMock.connect).toHaveBeenCalledOnce()
    expect(storeMock.loadRooms).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('GroupChatPanel')

    wrapper.unmount()
    expect(storeMock.disconnect).toHaveBeenCalledOnce()
  })

  it('loads display settings before room data on direct group-chat loads', async () => {
    mount(GroupChatView)
    await flushPromises()

    expect(settingsStoreMock.fetchSettings).toHaveBeenCalledOnce()
    expect(storeMock.loadRooms).toHaveBeenCalledOnce()
    expect(settingsStoreMock.fetchSettings.mock.invocationCallOrder[0]).toBeLessThan(
      storeMock.loadRooms.mock.invocationCallOrder[0],
    )
  })
})
