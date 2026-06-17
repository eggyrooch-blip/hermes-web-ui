// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))

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
  // Upstream-rebaseline drift: ChatPanel render/computed reads these.
  messages: [] as Array<Record<string, any>>,
  runtimeMode: 'agent',
  sessionProfileFilter: '__all__',
  clearSessionCompletedUnread: vi.fn(),
  isSessionCompletedUnread: vi.fn(() => false),
  switchSessionModel: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  connected: true,
  // Upstream-rebaseline drift: ChatPanel's model selector reads these.
  modelGroups: [] as Array<Record<string, any>>,
  profileModelGroups: [] as Array<Record<string, any>>,
  customModels: {} as Record<string, any>,
  displayModelName: vi.fn((m: string) => m),
  getModelAlias: vi.fn((m: string) => m),
  loadModels: vi.fn(),
}))

const profilesStoreMock = vi.hoisted(() => ({
  currentUser: null as Record<string, any> | null,
  activeProfileName: 'user_a',
  // Upstream-rebaseline drift: profileFilterOptions computed maps over this.
  profiles: [] as Array<Record<string, any>>,
  loading: false,
  fetchProfiles: vi.fn(),
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
  // Upstream-rebaseline drift: ChatPanel gates admin-only UI on this.
  isStoredSuperAdmin: isStoredSuperAdminMock,
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
  // Upstream-rebaseline drift: ChatPanel now imports exportSession too.
  exportSession: vi.fn(),
}))

vi.mock('@/api/coding-agents', () => ({
  fetchCodingAgentsStatus: vi.fn(() => Promise.resolve({})),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'hermes.chat', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
  // Upstream-rebaseline drift: ChatPanel now also imports these naive-ui parts.
  NDrawer: {
    props: ['show'],
    template: '<div v-if="show"><slot /></div>',
  },
  NDrawerContent: {
    template: '<div><slot name="header" /><slot /><slot name="footer" /></div>',
  },
  NSelect: {
    props: ['value', 'options'],
    emits: ['update:value'],
    template: '<select class="n-select-stub"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  },
  NRadioGroup: {
    props: ['value'],
    emits: ['update:value'],
    template: '<div class="n-radio-group-stub"><slot /></div>',
  },
  NRadioButton: {
    props: ['value', 'label'],
    template: '<label class="n-radio-button-stub"><slot />{{ label }}</label>',
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

// Upstream-rebaseline drift: ChatPanel now imports these heavy side panels.
// FilesPanel -> FileEditor.vue pulls in monaco-editor (crashes in jsdom at
// import time via document.queryCommandSupported); TerminalPanel pulls xterm.
// Stub them like the other child components above to sever those import chains.
vi.mock('@/components/hermes/chat/OutlinePanel.vue', () => ({
  default: { template: '<div class="outline-panel-stub" />' },
}))

vi.mock('@/components/hermes/chat/FilesPanel.vue', () => ({
  default: { template: '<div class="files-panel-stub" />' },
}))

vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  default: { template: '<div class="terminal-panel-stub" />' },
}))

vi.mock('@/components/layout/PageSidebarNav.vue', () => ({
  default: {
    props: ['primaryLabel'],
    emits: ['primary'],
    template: '<button class="page-sidebar-nav-stub" @click="$emit(\'primary\')">{{ primaryLabel }}</button>',
  },
}))

import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'

describe('ChatPanel user-mode gateway state', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    isStoredSuperAdminMock.mockReturnValue(false)
    appStoreMock.connected = true
    chatStoreMock.sessions = []
    chatStoreMock.activeSession = null
    chatStoreMock.activeSessionId = null
    chatStoreMock.isStreaming = false
    profilesStoreMock.currentUser = null
    profilesStoreMock.activeProfileName = 'user_a'
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
      profile: 'user_a',
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
    expect(wrapper.text()).not.toContain('profile user_a')
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

  it('does not render the session scope hint above the chat session list', () => {
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

    expect(wrapper.find('.session-scope-note').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('chat.sessionScopeHint')
    expect(wrapper.text()).not.toContain('chat.openHistory')
  })

  it('does not offer coding-agent sessions to non-admin users', async () => {
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    appStoreMock.profileModelGroups = [{
      profile: 'user_a',
      groups: [{ provider: 'openai', label: 'OpenAI', models: ['gpt-4.1'] }],
      default_provider: 'openai',
      default: 'gpt-4.1',
    }]

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    await wrapper.get('.page-sidebar-nav-stub').trigger('click')

    expect(wrapper.text()).toContain('Hermes')
    expect(wrapper.text()).not.toContain('Claude Code')
    expect(wrapper.text()).not.toContain('Codex')
    expect(wrapper.text()).not.toContain('codingAgents.launchModeScope')
    expect(wrapper.text()).not.toContain('codingAgents.protocolScope')
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
