// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

const warningMock = vi.hoisted(() => vi.fn())
const storeMock = vi.hoisted(() => ({
  rooms: [],
  currentRoomId: '',
  roomName: '',
  agents: [],
  userName: '陈先生',
  userId: 'user-1',
  members: [],
  connected: true,
  contextStatuses: new Map(),
  typingText: '',
  sortedMessages: [],
  connect: vi.fn(),
  loadRooms: vi.fn(),
  joinRoom: vi.fn(),
  createNewRoom: vi.fn(),
  addAgentToRoom: vi.fn(),
  setUserInfo: vi.fn(),
}))
const profilesStoreMock = vi.hoisted(() => ({
  profiles: [{ name: 'feishu_g41a5b5g' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/stores/hermes/group-chat', () => ({
  useGroupChatStore: () => storeMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@multiavatar/multiavatar', () => ({
  default: (name: string) => `<svg data-name="${name}"></svg>`,
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    warning: warningMock,
    success: vi.fn(),
    error: vi.fn(),
  }),
  NButton: defineComponent({
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  }),
  NSpace: { template: '<div><slot /></div>' },
  NInput: { template: '<input />' },
  NInputNumber: { template: '<input />' },
  NSelect: { template: '<select />' },
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
  NPopconfirm: { template: '<div><slot name="trigger" /><slot /></div>' },
}))

vi.mock('@/components/hermes/group-chat/GroupMessageList.vue', () => ({
  default: { template: '<div>GroupMessageList</div>' },
}))

vi.mock('@/components/hermes/group-chat/GroupChatInput.vue', () => ({
  default: { template: '<div>GroupChatInput</div>' },
}))

vi.mock('@/components/hermes/group-chat/CreateRoomForm.vue', () => ({
  default: { template: '<div>CreateRoomForm</div>' },
}))

import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'

describe('GroupChatPanel empty room state', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    storeMock.currentRoomId = ''
    storeMock.rooms = []
    warningMock.mockClear()
    profilesStoreMock.fetchProfiles.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('does not open add-agent when no room is selected', async () => {
    const wrapper = mount(GroupChatPanel)
    const addAgentButton = wrapper.find('button[title="groupChat.selectOrCreate"]')

    expect(addAgentButton.exists()).toBe(true)
    expect(addAgentButton.attributes('disabled')).toBeDefined()

    await addAgentButton.trigger('click')

    expect(profilesStoreMock.fetchProfiles).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('groupChat.addAgent')
  })

  it('keeps the upstream sidebar create-room action available', async () => {
    const wrapper = mount(GroupChatPanel, { attachTo: document.body })

    await wrapper.find('button[title="groupChat.createRoom"]').trigger('click')

    expect(document.body.querySelector('.modal')).not.toBeNull()
  })
})
