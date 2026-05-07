// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const fetchHermesSessionsMock = vi.hoisted(() => vi.fn())
const fetchHermesSessionMock = vi.hoisted(() => vi.fn())
const renameSessionMock = vi.hoisted(() => vi.fn())
const setSessionWorkspaceMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/sessions', () => ({
  fetchHermesSessions: fetchHermesSessionsMock,
  fetchHermesSession: fetchHermesSessionMock,
  renameSession: renameSessionMock,
  setSessionWorkspace: setSessionWorkspaceMock,
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

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  NDropdown: {
    template: '<div />',
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
    template: '<button class="session-list-item" :class="{ active }" @click="$emit(\'select\')">{{ session.title || session.id }}</button>',
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

    expect(fetchHermesSessionMock).toHaveBeenCalledWith('webui-session')
    expect(wrapper.find('.history-message-list').text()).toBe('webui-session')
  })

  it('shows a profile-scoped history empty state when no Hermes sessions exist', async () => {
    fetchHermesSessionsMock.mockResolvedValue([])

    const wrapper = mount(HistoryView)
    await flushMountedWork()

    expect(fetchHermesSessionMock).not.toHaveBeenCalled()
    expect(wrapper.find('.history-empty-state').exists()).toBe(true)
    expect(wrapper.text()).toContain('chat.historyEmptyTitle')
    expect(wrapper.text()).toContain('chat.historyEmptyHint')
    expect(wrapper.text()).not.toContain('chat.newChat')
    expect(wrapper.find('.history-message-list').exists()).toBe(false)
  })
})
