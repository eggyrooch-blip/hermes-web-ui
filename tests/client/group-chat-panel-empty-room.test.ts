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
  profiles: [{ name: 'feishu_user_a' }],
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
  NSelect: defineComponent({
    props: ['options', 'value'],
    template: '<select><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
  NPopconfirm: { template: '<div><slot name="trigger" /><slot /></div>' },
  NDropdown: { template: '<div><slot /></div>' },
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

// Upstream PageSidebarNav pulls in the router (history/session-search/etc.); the
// only behavior this suite cares about is its `primary` action, so stub it down
// to a single button that surfaces the create-room label and re-emits `primary`.
vi.mock('@/components/layout/PageSidebarNav.vue', () => ({
  default: defineComponent({
    props: ['primaryLabel'],
    emits: ['primary'],
    template: '<button class="page-sidebar-primary" :title="primaryLabel" @click="$emit(\'primary\')">{{ primaryLabel }}</button>',
  }),
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

  it('shows the empty-room prompt when no room is selected', () => {
    const wrapper = mount(GroupChatPanel)

    // Upstream renders the select-or-create prompt instead of a chat shell.
    expect(wrapper.text()).toContain('groupChat.selectOrCreate')
    expect(wrapper.text()).not.toContain('GroupMessageList')
  })

  it('keeps the upstream sidebar create-room action available', async () => {
    const wrapper = mount(GroupChatPanel, { attachTo: document.body })

    await wrapper.find('button.page-sidebar-primary[title="groupChat.createRoom"]').trigger('click')

    expect(document.body.querySelector('.modal')).not.toBeNull()
    expect(document.body.textContent).toContain('groupChat.createRoom')
  })
})
