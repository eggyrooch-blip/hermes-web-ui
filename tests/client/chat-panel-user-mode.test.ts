// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))

const chatStoreMock = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  activeSession: null as Record<string, any> | null,
  activeSessionId: null as string | null,
  isLoadingSessions: false,
  sessionsLoaded: true,
  isStreaming: false,
  switchSession: vi.fn(),
  newChat: vi.fn(),
  deleteSession: vi.fn(),
  loadSessions: vi.fn(),
  isSessionLive: vi.fn(() => false),
}))

const appStoreMock = vi.hoisted(() => ({
  connected: true,
}))

const profilesStoreMock = vi.hoisted(() => ({
  currentUser: null as Record<string, any> | null,
  activeProfileName: 'g41a5b5g',
}))

const prefsStoreMock = vi.hoisted(() => ({
  humanOnly: false,
  isPinned: vi.fn(() => false),
  pruneMissingSessions: vi.fn(),
  removePinned: vi.fn(),
  togglePinned: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

vi.mock('@/stores/hermes/session-browser-prefs', () => ({
  useSessionBrowserPrefsStore: () => prefsStoreMock,
}))

vi.mock('@/api/hermes/sessions', () => ({
  renameSession: vi.fn(),
  setSessionWorkspace: vi.fn(),
  batchDeleteSessions: vi.fn(),
}))

vi.mock('@/shared/session-display', () => ({
  getSourceLabel: (source: string) => source,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled', 'title', 'circle', 'quaternary', 'size', 'type'],
    emits: ['click'],
    template: '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  NDropdown: {
    template: '<div />',
  },
  NInput: {
    props: ['value', 'placeholder'],
    emits: ['update:value', 'keydown'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  },
  NModal: {
    props: ['show'],
    template: '<div v-if="show"><slot /></div>',
  },
  NPopconfirm: {
    template: '<div><slot name="trigger" /><slot /></div>',
  },
  NTooltip: {
    template: '<span><slot name="trigger" /><slot /></span>',
  },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('@/components/hermes/chat/ChatInput.vue', () => ({
  default: { template: '<div class="chat-input-stub" />' },
}))

vi.mock('@/components/hermes/chat/ConversationMonitorPane.vue', () => ({
  default: { template: '<div class="monitor-stub" />' },
}))

vi.mock('@/components/hermes/chat/MessageList.vue', () => ({
  default: { template: '<div class="message-list-stub" />' },
}))

vi.mock('@/components/hermes/chat/SessionListItem.vue', () => ({
  default: { props: ['session'], template: '<button class="session-item-stub">{{ session.title }}</button>' },
}))

vi.mock('@/components/hermes/chat/DrawerPanel.vue', () => ({
  default: { template: '<div class="drawer-panel-stub" />' },
}))

vi.mock('@/components/hermes/chat/FolderPicker.vue', () => ({
  default: { template: '<div class="folder-picker-stub" />' },
}))

import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'

describe('ChatPanel user-mode gateway state', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    appStoreMock.connected = true
    chatStoreMock.sessions = []
    chatStoreMock.activeSession = null
    chatStoreMock.activeSessionId = null
    chatStoreMock.isStreaming = false
    profilesStoreMock.currentUser = null
    profilesStoreMock.activeProfileName = 'g41a5b5g'
    vi.clearAllMocks()
    localStorage.clear()
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  it('does not show a wake hint in user mode when the bound gateway is still connecting', () => {
    isUserModeMock.mockReturnValue(true)
    appStoreMock.connected = false

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a><slot /></a>',
          },
        },
      },
    })

    expect(wrapper.find('.chat-wake-hint').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('chat.gatewayWakeHint')
    expect(wrapper.find('.chat-input-stub').exists()).toBe(true)
  })

  it('does not show a separate personal agent status card in user mode', () => {
    isUserModeMock.mockReturnValue(true)
    appStoreMock.connected = false
    profilesStoreMock.currentUser = {
      name: '陈先生',
      profile: 'g41a5b5g',
    }

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    const card = wrapper.find('.user-agent-card')
    expect(card.exists()).toBe(false)
    expect(wrapper.text()).not.toContain('profile g41a5b5g')
    expect(wrapper.text()).not.toContain('chat.agentStandby')
  })

  it('hides the auto-wake hint when the gateway is already connected', () => {
    isUserModeMock.mockReturnValue(true)
    appStoreMock.connected = true

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    expect(wrapper.find('.chat-wake-hint').exists()).toBe(false)
  })

  it('does not override MessageItem bubble colors in user mode', () => {
    const source = readFileSync(
      join(process.cwd(), 'packages/client/src/components/hermes/chat/ChatPanel.vue'),
      'utf8',
    )

    expect(source).not.toContain(':deep(.message-bubble)')
    expect(source).not.toContain(':deep(.message.user .message-bubble)')
    expect(source).not.toContain(':deep(.message.assistant .message-bubble)')
  })
})
