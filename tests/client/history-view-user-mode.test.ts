// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { mount } from '@vue/test-utils'

const fetchHermesSessionsMock = vi.hoisted(() => vi.fn())
const fetchHermesSessionMock = vi.hoisted(() => vi.fn())
const renameSessionMock = vi.hoisted(() => vi.fn())
const setSessionWorkspaceMock = vi.hoisted(() => vi.fn())
const setSessionArchivedMock = vi.hoisted(() => vi.fn())
// Rebaseline: upstream HistoryView no longer loads the auto-selected session
// directly — it navigates (router.push) and a watch on the route drives the
// load. To keep the auto-load semantics genuinely exercised, the router
// push/replace mocks mutate routeState (a reactive object), simulating the real
// router updating the route and re-triggering the component's route watch.
// `reactive` is an import, so it can't run inside vi.hoisted (which executes
// before imports) — routeState is wrapped reactive after imports resolve.
const routeState = reactive({
  params: {} as Record<string, unknown>,
  query: {} as Record<string, unknown>,
})
const routerPushMock = vi.hoisted(() => vi.fn())
const routerReplaceMock = vi.hoisted(() => vi.fn())
function applyRouterLocation(location?: any) {
  routeState.params = location?.params ? { ...location.params } : {}
  routeState.query = location?.query ? { ...location.query } : {}
  return Promise.resolve(undefined)
}

vi.mock('@/api/hermes/sessions', () => ({
  fetchHermesSessions: fetchHermesSessionsMock,
  fetchHermesSession: fetchHermesSessionMock,
  // Rebaseline: upstream HistoryView now tries paginated message loading first and
  // falls back to fetchHermesSession when it returns null. Returning null here keeps
  // these (pre-pagination) tests exercising the fetchHermesSession fallback path.
  fetchSessionMessagesPage: vi.fn(async () => null),
  renameSession: renameSessionMock,
  setSessionWorkspace: setSessionWorkspaceMock,
  setSessionArchived: setSessionArchivedMock,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({ activeSession: null }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ loadModels: vi.fn() }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ fetchProfiles: vi.fn(async () => undefined) }),
}))

vi.mock('@/stores/hermes/session-browser-prefs', () => ({
  useSessionBrowserPrefsStore: () => ({
    isPinned: () => false,
    togglePin: vi.fn(),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  NDropdown: {
    props: ['options'],
    emits: ['select'],
    template: '<div class="mock-dropdown"><button v-for="option in options" :key="option.key" :data-key="option.key" @click="$emit(\'select\', option.key)">{{ option.key }}</button></div>',
  },
  NInput: {
    props: ['value'],
    emits: ['update:value'],
    template: '<input />',
  },
  NModal: {
    template: '<div><slot /></div>',
  },
  NTooltip: {
    template: '<span><slot name="trigger" /><slot /></span>',
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/components/hermes/chat/FolderPicker.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/components/hermes/chat/HistoryMessageList.vue', () => ({
  default: {
    props: ['session'],
    template: '<div class="history-message-list">{{ session?.id || "empty" }}</div>',
  },
}))

vi.mock('@/components/hermes/chat/SessionListItem.vue', () => ({
  default: {
    props: ['session', 'active'],
    emits: ['select', 'contextmenu'],
    template: '<button class="session-list-item" :class="{ active, archived: session.isArchived }" @click="$emit(\'select\')" @contextmenu.prevent="$emit(\'contextmenu\', $event)">{{ session.title || session.id }}</button>',
  },
}))

import HistoryView from '@/views/hermes/HistoryView.vue'

function sessionSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'webui-session',
    source: 'webui',
    model: 'test-model',
    title: 'Web UI Session',
    started_at: 100,
    ended_at: null,
    last_active: 120,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    messages: [{ id: 1, session_id: 'webui-session', role: 'user', content: 'hello', timestamp: 100 }],
    ...overrides,
  }
}

async function flushMountedWork() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('HistoryView user-mode session loading', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchHermesSessionsMock.mockReset()
    fetchHermesSessionMock.mockReset()
    renameSessionMock.mockReset()
    setSessionWorkspaceMock.mockReset()
    setSessionArchivedMock.mockReset()
    setSessionArchivedMock.mockResolvedValue(true)
    // Reinstall the routeState-mutating implementation so navigation simulates
    // the real router driving the component's route watch.
    routerPushMock.mockReset()
    routerReplaceMock.mockReset()
    routerPushMock.mockImplementation(applyRouterLocation)
    routerReplaceMock.mockImplementation(applyRouterLocation)
    routeState.params = {}
    routeState.query = {}
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as any
  })

  it('auto-loads the first available Hermes session when no CLI session exists', async () => {
    const summary = sessionSummary({ messages: undefined })
    fetchHermesSessionsMock.mockResolvedValue([summary])
    fetchHermesSessionMock.mockResolvedValue(sessionSummary())

    const wrapper = mount(HistoryView)
    await flushMountedWork()

    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'hermes.historySession',
      params: { sessionId: 'webui-session' },
      query: undefined,
    })
    expect(wrapper.find('.history-message-list').text()).toBe('webui-session')
  })

  it('loads the deep-linked history session from the requested profile', async () => {
    routeState.params = { sessionId: 'webui-session' }
    routeState.query = { profile: 'tester' }
    const summary = sessionSummary({ profile: 'tester', messages: undefined })
    fetchHermesSessionsMock.mockResolvedValue([summary])
    fetchHermesSessionMock.mockResolvedValue(sessionSummary({ profile: 'tester' }))

    const wrapper = mount(HistoryView)
    await flushMountedWork()

    expect(fetchHermesSessionsMock).toHaveBeenCalledWith(undefined, undefined, 'tester')
    expect(fetchHermesSessionMock).toHaveBeenCalledWith('webui-session', 'tester')
    expect(wrapper.find('.history-message-list').text()).toBe('webui-session')
  })

  it('shows a profile-scoped history empty state when no Hermes sessions exist', async () => {
    fetchHermesSessionsMock.mockResolvedValue([])

    const wrapper = mount(HistoryView)
    await flushMountedWork()

    // Rebaseline: upstream removed the fork's dedicated `.history-empty-state`
    // panel (and its `chat.historyEmptyTitle`/`historyEmptyHint` strings — none
    // of these exist in the upstream component). With zero sessions the sidebar
    // renders the `.session-empty` placeholder (`chat.noSessions`) and the main
    // area always mounts HistoryMessageList with a null session (renders "empty").
    expect(fetchHermesSessionMock).not.toHaveBeenCalled()
    expect(wrapper.find('.session-empty').exists()).toBe(true)
    expect(wrapper.find('.session-empty').text()).toBe('chat.noSessions')
    expect(wrapper.find('.history-message-list').exists()).toBe(true)
    expect(wrapper.find('.history-message-list').text()).toBe('empty')
  })

  it('shows archived and local-only coding-agent sessions in History', async () => {
    fetchHermesSessionsMock.mockResolvedValue([
      sessionSummary({ id: 'archived-session', title: 'Archived session', is_archived: true }),
      sessionSummary({
        id: 'codex-local',
        source: 'coding_agent',
        agent: 'codex',
        agent_session_id: 'codex-agent-session',
        title: 'Codex local only',
      }),
    ])
    fetchHermesSessionMock.mockResolvedValue(sessionSummary({ id: 'archived-session', title: 'Archived session' }))

    const wrapper = mount(HistoryView)
    await flushMountedWork()

    expect(wrapper.text()).toContain('Archived session')
    expect(wrapper.text()).toContain('Codex local only')
  })

  it('unarchives an archived History session through the sessions API', async () => {
    fetchHermesSessionsMock
      .mockResolvedValueOnce([
        sessionSummary({ id: 'archived-session', profile: 'tester', title: 'Archived session', is_archived: true }),
      ])
      .mockResolvedValueOnce([
        sessionSummary({ id: 'archived-session', profile: 'tester', title: 'Archived session', is_archived: false }),
      ])
    fetchHermesSessionMock.mockResolvedValue(sessionSummary({ id: 'archived-session', profile: 'tester' }))

    const wrapper = mount(HistoryView)
    await flushMountedWork()

    await wrapper.find('.session-list-item').trigger('contextmenu')
    await wrapper.find('[data-key="unarchive"]').trigger('click')
    await flushMountedWork()

    expect(setSessionArchivedMock).toHaveBeenCalledWith('archived-session', false, 'tester')
    expect(fetchHermesSessionsMock).toHaveBeenCalledTimes(2)
  })
})
