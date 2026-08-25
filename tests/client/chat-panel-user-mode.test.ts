// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const isStoredSuperAdminMock = vi.hoisted(() => vi.fn(() => false))
const routerPushMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const routerReplaceMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const routerResolveMock = vi.hoisted(() => vi.fn((to: any) => {
  const sessionId = to?.params?.sessionId || ''
  const profile = to?.query?.profile ? `?profile=${encodeURIComponent(to.query.profile)}` : ''
  return { href: `#/hermes/session/${sessionId}${profile}` }
}))
const routeMock = vi.hoisted(() => ({
  name: 'hermes.chat',
  params: {} as Record<string, unknown>,
  query: {} as Record<string, unknown>,
}))
const detailLifecycleMock = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
  nextId: 0,
}))

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
  clearActiveSession: vi.fn(),
  isSessionCompletedUnread: vi.fn(() => false),
  switchSessionModel: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  connected: true,
  // Upstream-rebaseline drift: ChatPanel's model selector reads these.
  modelGroups: [] as Array<Record<string, any>>,
  profileModelGroups: [] as Array<Record<string, any>>,
  customModels: {} as Record<string, any>,
  selectedProvider: '',
  selectedModel: '',
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
  switchProfile: vi.fn(() => Promise.resolve(true)),
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

vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => ({ previewPanelRequestedAt: 0 }),
  // ChatPanel now imports FilesView (the `files` sidebar surface), whose file
  // components pull these module-level helpers in at import time.
  DEFAULT_EDITOR_SCOPE: 'files-view:__default__',
  isTextFile: () => false,
  isPreviewableFile: () => false,
  isHtmlFile: () => false,
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
  useRoute: () => routeMock,
  useRouter: () => ({ push: routerPushMock, replace: routerReplaceMock, resolve: routerResolveMock }),
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
    emits: ['positive-click'],
    // preset="dialog" modals confirm through @positive-click, not a slotted button —
    // the stub needs to offer that affordance or those flows are untestable.
    template: '<div v-if="show"><slot /><button class="n-modal-positive" @click="$emit(\'positive-click\')" /></div>',
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
  useDialog: () => ({
    warning: vi.fn(),
  }),
}))

vi.mock('@/components/hermes/chat/ChatInput.vue', () => ({
  // Renders the scope slot: the workspace chip lives inside the composer box,
  // so a stub that drops slots would hide it from every assertion below.
  default: { template: '<div class="chat-input-stub"><slot name="pillbar" /></div>' },
}))

vi.mock('@/components/hermes/chat/ConversationMonitorPane.vue', () => ({
  default: { template: '<div class="monitor-stub" />' },
}))

vi.mock('@/components/hermes/chat/MessageList.vue', () => ({
  default: { template: '<div class="message-list-stub" />' },
}))

vi.mock('@/components/hermes/chat/SessionListItem.vue', () => ({
  default: {
    props: ['session', 'to'],
    emits: ['select', 'contextmenu'],
    // The `⋯` trigger is stubbed too: the workspace entry point lives in the
    // row menu, so tests need a way to open it.
    template: `<a class="session-item-stub" :href="to" @click.prevent="$emit('select')">{{ session.title }}<button class="session-item-menu-stub" @click.prevent.stop="$emit('contextmenu', $event)" /></a>`,
  },
}))

vi.mock('@/components/hermes/chat/DrawerPanel.vue', () => ({
  default: { template: '<div class="drawer-panel-stub" />' },
}))

vi.mock('@/components/hermes/chat/FolderPicker.vue', () => ({
  default: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<button class="folder-picker-stub" @click="$emit(\'update:modelValue\', \'media-matrix\')" />',
  },
}))

// Upstream-rebaseline drift: ChatPanel now imports these heavy side panels.
// FilesPanel -> FileEditor.vue pulls in monaco-editor (crashes in jsdom at
// import time via document.queryCommandSupported); TerminalPanel pulls xterm.
// Stub them like the other child components above to sever those import chains.
vi.mock('@/components/hermes/chat/RunPanel.vue', () => ({
  default: { template: '<div class="run-panel-stub" />' },
}))

vi.mock('@/components/hermes/chat/DetailPanel.vue', async () => {
  const { defineComponent, onMounted, onUnmounted, ref } = await import('vue')
  return {
    default: defineComponent({
      name: 'DetailPanel',
      setup() {
        const id = ++detailLifecycleMock.nextId
        const value = ref(0)
        onMounted(() => detailLifecycleMock.mounted(id))
        onUnmounted(() => detailLifecycleMock.unmounted(id))
        return { id, value }
      },
      template: '<button class="detail-panel-probe" @click="value += 1">{{ id }}:{{ value }}</button>',
    }),
  }
})

vi.mock('@/components/hermes/chat/FilesPanel.vue', () => ({
  default: { template: '<div class="files-panel-stub" />' },
}))

// ChatPanel now imports FilesView (the `files` sidebar surface), whose
// FileEditor.vue pulls in monaco-editor — which crashes at import time under
// jsdom (document.queryCommandSupported is not a function). Sever the import
// chain with a harmless stub, mirroring router-user-mode.test.ts.
vi.mock('monaco-editor', () => ({}))

vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  default: { template: '<div class="terminal-panel-stub" />' },
}))

vi.mock('@/components/layout/PageSidebarNav.vue', () => ({
  default: {
    props: ['primaryLabel', 'active', 'showPrimaryConfig'],
    emits: ['primary', 'primaryConfig'],
    template:
      '<div class="page-sidebar-nav-stub-wrap">'
      + '<button class="page-sidebar-nav-stub" :data-active="active" @click="$emit(\'primary\')">{{ primaryLabel }}</button>'
      + '<button v-if="showPrimaryConfig" class="page-sidebar-nav-config-stub" @click="$emit(\'primaryConfig\')">config</button>'
      // The real component hosts the task list + account row via slots.
      + '<slot name="tasks" /><slot name="footer" />'
      + '</div>',
  },
}))

vi.mock('@/views/hermes/ExpertCatalogView.vue', () => ({
  default: {
    template: '<section class="expert-catalog-stub">Expert Surface</section>',
  },
}))

vi.mock('@/views/hermes/JobsView.vue', () => ({
  default: {
    props: ['embedded'],
    template: '<section class="jobs-view-stub" :data-embedded="embedded">Automation Surface</section>',
  },
}))

import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'

describe('ChatPanel user-mode gateway state', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    isStoredSuperAdminMock.mockReturnValue(false)
    appStoreMock.connected = true
    appStoreMock.modelGroups = []
    appStoreMock.profileModelGroups = []
    appStoreMock.customModels = {}
    appStoreMock.selectedProvider = ''
    appStoreMock.selectedModel = ''
    chatStoreMock.sessions = []
    chatStoreMock.activeSession = null
    chatStoreMock.activeSessionId = null
    chatStoreMock.isStreaming = false
    chatStoreMock.runtimeMode = 'agent'
    routeMock.name = 'hermes.chat'
    routeMock.params = {}
    routeMock.query = {}
    profilesStoreMock.currentUser = null
    profilesStoreMock.activeProfileName = 'user_a'
    profilesStoreMock.profiles = []
    routerPushMock.mockClear()
    routerReplaceMock.mockClear()
    routerResolveMock.mockClear()
    vi.clearAllMocks()
    detailLifecycleMock.nextId = 0
    chatStoreMock.newChat.mockReturnValue({ id: 'new-session', profile: 'user_a' })
    chatStoreMock.loadSessions.mockResolvedValue(undefined)
    appStoreMock.loadModels.mockResolvedValue(undefined)
    profilesStoreMock.fetchProfiles.mockResolvedValue(undefined)
    profilesStoreMock.switchProfile.mockResolvedValue(true)
    localStorage.clear()
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  it('mounts the tool detail once and only hides it across collapse and reopen', async () => {
    isStoredSuperAdminMock.mockReturnValue(true)
    const wrapper = mount(ChatPanel, {
      global: { stubs: { RouterLink: true } },
    })

    expect(wrapper.find('.detail-panel-probe').exists()).toBe(false)
    expect(detailLifecycleMock.mounted).not.toHaveBeenCalled()

    await wrapper.find('.header-tool-toggle').trigger('click')
    await nextTick()
    const detail = wrapper.find('.detail-panel-probe')
    expect(detail.text()).toBe('1:0')
    expect(detailLifecycleMock.mounted).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.chat-tool-panel').attributes('style')).not.toContain('display: none')

    await detail.trigger('click')
    expect(wrapper.find('.detail-panel-probe').text()).toBe('1:1')

    await wrapper.find('.header-tool-toggle').trigger('click')
    await nextTick()
    expect(wrapper.find('.chat-tool-panel').isVisible()).toBe(false)
    expect(wrapper.find('.detail-panel-probe').exists()).toBe(true)
    expect(detailLifecycleMock.unmounted).not.toHaveBeenCalled()

    await wrapper.find('.header-tool-toggle').trigger('click')
    await nextTick()
    expect(wrapper.find('.chat-tool-panel').attributes('style')).not.toContain('display: none')
    expect(wrapper.find('.detail-panel-probe').text()).toBe('1:1')
    expect(detailLifecycleMock.mounted).toHaveBeenCalledTimes(1)
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

  it('renders the expert surface in the chat main area without the chat composer', () => {
    routeMock.query = { surface: 'expert' }

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    expect(wrapper.get('.page-sidebar-nav-stub').attributes('data-active')).toBe('expert')
    expect(wrapper.get('.chat-surface-host').text()).toContain('Expert Surface')
    expect(wrapper.find('.expert-catalog-stub').exists()).toBe(true)
    expect(wrapper.find('.message-list-stub').exists()).toBe(false)
    expect(wrapper.find('.chat-input-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('sidebar.expert')
  })

  it('renders the automation surface in the chat main area without the chat composer', () => {
    routeMock.query = { surface: 'automation' }

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    expect(wrapper.get('.page-sidebar-nav-stub').attributes('data-active')).toBe('automation')
    expect(wrapper.get('.chat-surface-host').text()).toContain('Automation Surface')
    expect(wrapper.find('.jobs-view-stub').attributes()).toHaveProperty('data-embedded')
    expect(wrapper.find('.message-list-stub').exists()).toBe(false)
    expect(wrapper.find('.chat-input-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('jobs.title')
  })

  it('renders the Feishu user row and opens the account menu to reach settings', async () => {
    profilesStoreMock.currentUser = {
      name: '孙可',
      profile: 'feishu_g41a5b5g',
      avatarUrl: 'https://example.com/avatar.png',
    }

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
          // Render the teleported UserMenu inline so it can be queried.
          teleport: true,
        },
      },
    })

    // The footer is one quiet row — avatar + name — not a bordered card, and
    // matching the prototype it has no standalone settings gear: the whole row
    // is the affordance and settings lives inside the account menu.
    const bottom = wrapper.get('.page-sidebar-bottom')
    expect(bottom.text()).toContain('孙可')
    // The redundant profile id is not rendered in the sidebar footer.
    expect(bottom.text()).not.toContain('feishu_g41a5b5g')
    expect(bottom.get('.sidebar-user__avatar img').attributes('src')).toBe('https://example.com/avatar.png')
    expect(bottom.find('.sidebar-user__settings').exists()).toBe(false)

    // Clicking the user row opens the UserMenu; its first item navigates to settings.
    await bottom.get('.sidebar-user__trigger').trigger('click')
    const menu = wrapper.get('.user-menu')
    await menu.findAll('.user-menu__item')[0].trigger('click')

    // Settings opens as a surface inside the chat shell so the sidebar stays put.
    expect(routerPushMock).toHaveBeenCalledWith({ name: 'hermes.chat', query: { surface: 'settings' } })
  })

  it('groups the task list by agent, newest agent first, and labels each group', async () => {
    profilesStoreMock.profiles = [
      { name: 'ops', displayLabel: '运维助手' },
      { name: 'research' },
    ]
    chatStoreMock.sessions = [
      { id: 'a', title: 'ops older', profile: 'ops', createdAt: 1, updatedAt: 10 },
      { id: 'b', title: 'research newest', profile: 'research', createdAt: 1, updatedAt: 30 },
      { id: 'c', title: 'ops newer', profile: 'ops', createdAt: 1, updatedAt: 20 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    const headers = wrapper.findAll('.session-agent-group')
    expect(headers).toHaveLength(2)
    // Group order follows each group's newest session, so the agent you just
    // talked to sits on top.
    expect(headers[0].text()).toContain('research')
    expect(headers[1].text()).toContain('运维助手')
    // The count is part of the header, like the workspace groups'.
    expect(headers[1].text()).toContain('2')

    // Rows stay in newest-first order inside their own group.
    const titles = wrapper.findAll('.session-item-stub').map(r => r.text())
    expect(titles).toEqual(['research newest', 'ops newer', 'ops older'])
  })

  it('shows no group header when every task belongs to one agent', () => {
    profilesStoreMock.profiles = [{ name: 'ops', displayLabel: '运维助手' }]
    chatStoreMock.sessions = [
      { id: 'a', title: 'one', profile: 'ops', createdAt: 1, updatedAt: 2 },
      { id: 'b', title: 'two', profile: 'ops', createdAt: 1, updatedAt: 1 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    // A header would be labelling the only group there is.
    expect(wrapper.findAll('.session-agent-group')).toHaveLength(0)
    expect(wrapper.findAll('.session-item-stub')).toHaveLength(2)
  })

  it('collapses one agent group without touching the others', async () => {
    profilesStoreMock.profiles = [{ name: 'ops' }, { name: 'research' }]
    chatStoreMock.sessions = [
      { id: 'a', title: 'ops task', profile: 'ops', createdAt: 1, updatedAt: 10 },
      { id: 'b', title: 'research task', profile: 'research', createdAt: 1, updatedAt: 30 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    await wrapper.get('[data-testid="session-agent-group-research"]').trigger('click')
    const rows = wrapper.findAll('.session-item-stub')
    expect(rows.find(r => r.text() === 'research task')!.isVisible()).toBe(false)
    expect(rows.find(r => r.text() === 'ops task')!.isVisible()).toBe(true)
  })

  it('keeps an unknown agent\'s tasks in the list under its raw profile name', () => {
    // A deleted agent, or a profile list that has not landed yet: dropping the
    // group would drop the rows with it.
    profilesStoreMock.profiles = [{ name: 'ops' }]
    chatStoreMock.sessions = [
      { id: 'a', title: 'ops task', profile: 'ops', createdAt: 1, updatedAt: 10 },
      { id: 'b', title: 'orphan task', profile: 'gone_profile', createdAt: 1, updatedAt: 20 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    expect(wrapper.find('[data-testid="session-agent-group-gone_profile"]').text()).toContain('gone_profile')
    expect(wrapper.findAll('.session-item-stub').map(r => r.text())).toContain('orphan task')
  })

  it('keeps the session profile in sidebar links and navigation', async () => {
    chatStoreMock.sessions = [{
      id: 'session-feishu',
      title: 'from feishu profile',
      profile: 'feishu_g41a5b5g',
      source: 'api_server',
      createdAt: 1,
      updatedAt: 1,
    }]

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    const item = wrapper.get('.session-item-stub')
    expect(item.attributes('href')).toContain('profile=feishu_g41a5b5g')

    await item.trigger('click')

    expect(routerPushMock).toHaveBeenCalledWith(expect.objectContaining({
      query: { profile: 'feishu_g41a5b5g' },
    }))
  })

  it('switches frontend profile and clears a stale active session when the profile filter changes', async () => {
    profilesStoreMock.profiles = [
      { name: '123' },
      { name: 'feishu_g41a5b5g' },
    ]
    chatStoreMock.sessionProfileFilter = 'feishu_g41a5b5g'
    chatStoreMock.sessions = [
      {
        id: 'old-session',
        title: 'hello',
        profile: 'feishu_g41a5b5g',
        updatedAt: 2,
        messages: [],
      },
    ]
    chatStoreMock.activeSessionId = 'old-session'
    chatStoreMock.activeSession = chatStoreMock.sessions[0]
    chatStoreMock.loadSessions.mockImplementation(async () => {
      chatStoreMock.activeSession = chatStoreMock.sessions[0]
    })

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
          NSelect: {
            props: ['value', 'options'],
            emits: ['update:value'],
            template: '<button class="session-profile-filter" @click="$emit(\'update:value\', \'123\')">{{ value }}</button>',
          },
          Select: {
            props: ['value', 'options'],
            emits: ['update:value'],
            template: '<button class="session-profile-filter" @click="$emit(\'update:value\', \'123\')">{{ value }}</button>',
          },
        },
      },
    })

    // The profile filter lives in the 筛选 popover now (prototype: the task
    // list header carries a single filter icon).
    await wrapper.get('.session-filter-btn').trigger('click')
    wrapper.findComponent('.session-profile-filter').vm.$emit('update:value', '123')
    await flushPromises()

    expect(profilesStoreMock.switchProfile).toHaveBeenCalledWith('123')
    expect(chatStoreMock.loadSessions).toHaveBeenCalledWith('123')
    expect(chatStoreMock.clearActiveSession).toHaveBeenCalled()
    expect(routerReplaceMock).toHaveBeenCalledWith({ name: 'hermes.chat' })
  })

  it('creates ordinary user chats directly on the active profile without the advanced drawer', async () => {
    chatStoreMock.runtimeMode = 'global_agent'
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
    await flushPromises()

    expect(chatStoreMock.newChat).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'user_a',
      provider: 'openai',
      model: 'gpt-4.1',
      source: 'cli',
      agent: 'hermes',
      workspace: null,
    }))
    // The draft is created synchronously and we replace (not push) to its own
    // route — the prototype's instant "new task" never leaves a history entry
    // nor waits on a resume load.
    expect(routerReplaceMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'hermes.session',
      params: { sessionId: 'new-session' },
      query: { profile: 'user_a' },
    }))
    expect(wrapper.find('.folder-picker-stub').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Claude Code')
    expect(wrapper.text()).not.toContain('Codex')
    expect(wrapper.text()).not.toContain('codingAgents.launchModeScope')
    expect(wrapper.text()).not.toContain('codingAgents.protocolScope')
  })

  it('uses the current sidebar provider and model when creating ordinary user chats', async () => {
    chatStoreMock.runtimeMode = 'global_agent'
    profilesStoreMock.activeProfileName = 'user_a'
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    appStoreMock.selectedProvider = 'custom:litellm-sre'
    appStoreMock.selectedModel = 'custom:litellm-sre/tencent-sonnet-4-6'
    appStoreMock.profileModelGroups = [{
      profile: 'user_a',
      groups: [
        { provider: 'openai', label: 'OpenAI', models: ['gpt-4.1'] },
        { provider: 'custom:litellm-sre', label: 'LiteLLM SRE', models: ['custom:litellm-sre/tencent-sonnet-4-6'] },
      ],
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
    await flushPromises()

    expect(chatStoreMock.newChat).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'user_a',
      provider: 'custom:litellm-sre',
      model: 'custom:litellm-sre/tencent-sonnet-4-6',
      source: 'cli',
      agent: 'hermes',
      workspace: null,
    }))
    expect(wrapper.find('.folder-picker-stub').exists()).toBe(false)
  })

  it('groups workspace sessions and carries the selected group into a new chat', async () => {
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    appStoreMock.profileModelGroups = [{
      profile: 'user_a',
      groups: [{ provider: 'openai', label: 'OpenAI', models: ['gpt-4.1'] }],
      default_provider: 'openai',
      default: 'gpt-4.1',
    }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'cli', workspace: 'project-a', messages: [], createdAt: 1, updatedAt: 3 },
      { id: 'a2', profile: 'user_a', title: 'A2', source: 'cli', workspace: 'project-a', messages: [], createdAt: 1, updatedAt: 2 },
      { id: 'plain', profile: 'user_a', title: 'Plain', source: 'cli', workspace: null, messages: [], createdAt: 1, updatedAt: 1 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })
    await wrapper.get('.session-filter-btn').trigger('click')
    const project = wrapper.findAll('.workspace-group-item').find(button => button.text().includes('project-a'))
    expect(project?.text()).toContain('2')

    await project!.trigger('click')
    await wrapper.get('.page-sidebar-nav-stub').trigger('click')
    await flushPromises()

    expect(chatStoreMock.newChat).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'user_a',
      workspace: 'project-a',
      source: 'cli',
    }))
  })

  it('ignores legacy absolute workspace rows when grouping', async () => {
    // Pre-feature rows hold the absolute host workspace root, not a user binding.
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'l1', profile: 'user_a', title: 'L1', source: 'cli', workspace: '/Users/x/.hermes/profiles/user_a/workspace', messages: [], createdAt: 1, updatedAt: 3 },
      { id: 'l2', profile: 'user_a', title: 'L2', source: 'cli', workspace: '/Users/x/.hermes/profiles/user_a/workspace', messages: [], createdAt: 1, updatedAt: 2 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })
    await wrapper.get('.session-filter-btn').trigger('click')

    expect(wrapper.findAll('.workspace-group-item')).toHaveLength(0)
  })

  it('collapses and restores the workspace group list', async () => {
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'cli', workspace: 'project-a', messages: [], createdAt: 1, updatedAt: 3 },
    ]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })
    await wrapper.get('.session-filter-btn').trigger('click')
    const hiddenStyle = () => wrapper.findAll('.workspace-group-item')
      .find(button => button.text().includes('project-a'))!
      .attributes('style') || ''
    const toggle = () => wrapper.get('.workspace-group-toggle')
    expect(hiddenStyle()).not.toContain('display: none')
    expect(toggle().attributes('aria-expanded')).toBe('true')

    await toggle().trigger('click')
    expect(hiddenStyle()).toContain('display: none')
    expect(toggle().attributes('aria-expanded')).toBe('false')

    await toggle().trigger('click')
    expect(hiddenStyle()).not.toContain('display: none')
  })

  // The composer chip that used to carry these is gone; the workspace entry
  // point is the row menu now, and the rules below are about that flow.
  async function openWorkspaceFromRowMenu(wrapper: any) {
    await wrapper.get('.session-item-menu-stub').trigger('click')
    const row = wrapper.findAll('.session-menu__item').find((item: any) => item.text().includes('chat.setWorkspace'))
    expect(row).toBeTruthy()
    await row!.trigger('click')
    await flushPromises()
  }

  it('does not borrow the sidebar filter folder for an unbound session', async () => {
    // The picker states what THIS session is bound to and nothing else. It must not
    // borrow the sidebar filter: an unbound session opened while a workspace filter is
    // active would otherwise pre-fill a binding that does not exist — one blind OK and
    // the user is bound to a folder never chosen.
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'plain', profile: 'user_a', title: 'Plain', source: 'cli', workspace: null, messages: [], createdAt: 1, updatedAt: 1 },
    ]
    chatStoreMock.activeSession = chatStoreMock.sessions[0]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true, teleport: true } } })
    await wrapper.get('.session-filter-btn').trigger('click')
    const project = wrapper.findAll('.workspace-group-item').find(button => button.text().includes('project-a'))
    if (project) await project.trigger('click')
    chatStoreMock.activeSession = chatStoreMock.sessions[0]
    await flushPromises()

    await openWorkspaceFromRowMenu(wrapper)

    const input = wrapper.find('.workspace-modal input')
    if (input.exists()) expect((input.element as HTMLInputElement).value).not.toContain('project-a')
  })

  it('offers the workspace entry point on a server-hydrated api_server session', async () => {
    // The WebUI creates sessions as source:"cli" client-side, but the SERVER persists
    // them as "api_server" — so this is the shape every session has after a refresh or
    // when opened from history. The entry point must survive that round-trip.
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'api_server', workspace: null, messages: [], createdAt: 1, updatedAt: 3 },
    ]
    chatStoreMock.activeSession = chatStoreMock.sessions[0]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true, teleport: true } } })
    await wrapper.get('.session-item-menu-stub').trigger('click')

    const labels = wrapper.findAll('.session-menu__item').map(item => item.text())
    expect(labels.some(label => label.includes('chat.setWorkspace'))).toBe(true)
  })

  it('forks a new session instead of rebinding an api_server session that has messages', async () => {
    // Same predicate gates the fork branch. If it regresses, this path falls through to
    // an in-place rebind and the user gets the server's 409 instead of a new session.
    const { setSessionWorkspace } = await import('@/api/hermes/sessions')
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'api_server', workspace: 'media-probe', messageCount: 3, messages: [], createdAt: 1, updatedAt: 3 },
    ]
    chatStoreMock.activeSession = chatStoreMock.sessions[0]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true, teleport: true } } })
    await openWorkspaceFromRowMenu(wrapper)

    const confirm = wrapper.findAll('button').find(button => button.text().includes('common.confirm'))
    if (confirm) {
      await confirm.trigger('click')
      await flushPromises()
      expect(setSessionWorkspace).not.toHaveBeenCalled()
    }
  })

  it('shows the workspace entry point on a server-hydrated api_server session', async () => {
    // The WebUI creates sessions as source:"cli" client-side, but the SERVER persists
    // them as "api_server" — so this is the shape every session has after a refresh or
    // when opened from history. The entry point must survive that round-trip.
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'api_server', workspace: null, messages: [], createdAt: 1, updatedAt: 3 },
    ]
    chatStoreMock.activeSession = chatStoreMock.sessions[0]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    expect(wrapper.find('.composer-workspace-button').exists()).toBe(true)
  })

  it('shows the bound folder name on a server-hydrated api_server session', async () => {
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'api_server', workspace: 'media-probe', messages: [], createdAt: 1, updatedAt: 3 },
    ]
    chatStoreMock.activeSession = chatStoreMock.sessions[0]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    expect(wrapper.get('.composer-workspace-button').text()).toContain('media-probe')
  })

  it('forks a new session instead of rebinding an api_server session that has messages', async () => {
    // Same predicate gates the fork branch. If it regresses, this path falls through to
    // an in-place rebind and the user gets the server's 409 instead of a new session.
    const { setSessionWorkspace } = await import('@/api/hermes/sessions')
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    chatStoreMock.sessions = [
      { id: 'a1', profile: 'user_a', title: 'A1', source: 'api_server', workspace: 'media-probe', messageCount: 3, messages: [], createdAt: 1, updatedAt: 3 },
    ]
    chatStoreMock.activeSession = chatStoreMock.sessions[0]

    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })
    await wrapper.get('.composer-workspace-button').trigger('click')
    await wrapper.get('.folder-picker-stub').trigger('click')
    await wrapper.get('.n-modal-positive').trigger('click')
    await flushPromises()

    expect(chatStoreMock.newChat).toHaveBeenCalled()
    expect(setSessionWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the workspace entry point off coding-agent and global-agent sessions', async () => {
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    for (const source of ['coding_agent', 'global_agent']) {
      chatStoreMock.sessions = [
        { id: `s-${source}`, profile: 'user_a', title: source, source, workspace: null, messages: [], createdAt: 1, updatedAt: 3 },
      ]
      chatStoreMock.activeSession = chatStoreMock.sessions[0]

      const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

      expect(wrapper.find('.composer-workspace-button').exists()).toBe(false)
    }
  })

  it('does not pair a custom selected model with an unrelated fallback provider for new chats', async () => {
    // Prototype onNewTask creates the draft directly off the sidebar primary
    // click (see handleNewChatPrimary) — there is no modal step to drive here,
    // just the same default-model resolution the ordinary-chat path exercises.
    profilesStoreMock.profiles = [{ name: 'user_a' }]
    appStoreMock.modelGroups = [{
      provider: 'anthropic',
      label: 'Anthropic',
      models: ['claude-sonnet-4-6'],
    }]
    appStoreMock.profileModelGroups = []
    appStoreMock.selectedProvider = 'custom:litellm-sre'
    appStoreMock.selectedModel = 'custom:litellm-sre/tencent-sonnet-4-6'
    appStoreMock.customModels = {
      'custom:litellm-sre': ['custom:litellm-sre/tencent-sonnet-4-6'],
    }
    chatStoreMock.newChat.mockReturnValue({ id: 'new-session' })

    const wrapper = mount(ChatPanel, {
      global: {
        stubs: {
          RouterLink: true,
        },
      },
    })

    await wrapper.get('.page-sidebar-nav-stub').trigger('click')
    await flushPromises()

    expect(chatStoreMock.newChat).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }))
  })

  it('does not create a chat through an ambient default profile when authorization is unavailable', async () => {
    profilesStoreMock.profiles = []

    const wrapper = mount(ChatPanel, {
      global: { stubs: { RouterLink: true } },
    })

    await wrapper.get('.page-sidebar-nav-stub').trigger('click')
    await flushPromises()

    expect(profilesStoreMock.fetchProfiles).toHaveBeenCalled()
    expect(chatStoreMock.newChat).not.toHaveBeenCalled()
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

  it('falls back to the initial glyph when the expert avatar image fails to load', async () => {
    chatStoreMock.activeSession = {
      id: 's-exp', title: '', source: 'cli', messages: [],
      expertId: 'keep-resource-delivery', expertLabel: '资源投放专家', expertAvatar: '/gone.png',
    }
    chatStoreMock.activeSessionId = 's-exp'
    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })

    const img = wrapper.find('img.expert-session-avatar')
    expect(img.exists()).toBe(true)
    await img.trigger('error')
    await nextTick()

    expect(wrapper.find('img.expert-session-avatar').exists()).toBe(false)
    const fallback = wrapper.find('.expert-session-avatar--fallback')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toBe('资')
  })

  it('renders no expert identity for a global-agent session even with stale expert metadata', () => {
    chatStoreMock.activeSession = {
      id: 's-ga', title: '', source: 'global_agent', messages: [],
      expertId: 'keep-resource-delivery', expertLabel: '资源投放专家', expertAvatar: '/x.png',
    }
    chatStoreMock.activeSessionId = 's-ga'
    const wrapper = mount(ChatPanel, { global: { stubs: { RouterLink: true } } })
    expect(wrapper.find('.expert-session-identity').exists()).toBe(false)
  })
})
