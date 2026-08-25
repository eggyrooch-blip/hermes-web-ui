// @vitest-environment jsdom
import { nextTick, defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const apiMocks = vi.hoisted(() => ({
  fetchSessionsMock: vi.fn(),
  searchSessionsMock: vi.fn(),
  searchFilesMock: vi.fn(),
  fetchSkillsMock: vi.fn(),
  routerPushMock: vi.fn(),
  navigateToMock: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchSessions: apiMocks.fetchSessionsMock,
  searchSessions: apiMocks.searchSessionsMock,
}))

// The palette searches three sources now; each is mocked so the module graph
// never reaches the real api/client (which builds a router at import time).
vi.mock('@/api/hermes/files', () => ({
  searchFiles: apiMocks.searchFilesMock,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: apiMocks.fetchSkillsMock,
}))

vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => ({ navigateTo: apiMocks.navigateToMock }),
}))

const chatStoreMock = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  loadSessions: vi.fn(),
  switchSession: vi.fn(),
  newChat: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

const routerCurrentRoute = { value: { name: 'hermes.logs' } }

vi.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: routerCurrentRoute,
    push: apiMocks.routerPushMock,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
    }),
    NModal: {
      props: ['show'],
      emits: ['update:show'],
      template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
    },
    NInput: {
      props: ['value', 'size'],
      emits: ['update:value', 'keydown'],
      template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" @keydown="$emit(\'keydown\', $event)" />',
    },
    NSpin: {
      template: '<div class="n-spin-stub"><slot /></div>',
    },
    NButton: {
      template: '<button class="n-button-stub"><slot /></button>',
    },
  }
})

import SessionSearchModal from '@/components/hermes/chat/SessionSearchModal.vue'
import { useSessionSearch } from '@/composables/useSessionSearch'
import { useKeyboard } from '@/composables/useKeyboard'

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve())
}

describe('session search modal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    chatStoreMock.sessions = []
    chatStoreMock.loadSessions.mockResolvedValue(undefined)
    chatStoreMock.switchSession.mockResolvedValue(undefined)
    apiMocks.fetchSessionsMock.mockResolvedValue([
      {
        id: 'recent-1',
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Recent Docker fix',
        preview: 'recent preview',
        started_at: 1710000000,
        ended_at: 1710000001,
        last_active: 1710000002,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      },
    ])
    apiMocks.searchSessionsMock.mockResolvedValue([
      {
        id: 'match-1',
        source: 'telegram',
        model: 'openai/gpt-5.4',
        title: 'Debugging session',
        preview: 'search preview',
        started_at: 1710001000,
        ended_at: null,
        last_active: 1710001005,
        message_count: 4,
        tool_call_count: 1,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        matched_message_id: 17,
        snippet: 'docker compose up',
        rank: 0.1,
      },
    ])
    apiMocks.searchFilesMock.mockResolvedValue({ entries: [], truncated: false })
    apiMocks.fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    routerCurrentRoute.value = { name: 'hermes.logs' }
  })

  afterEach(() => {
    vi.useRealTimers()
    // `useSessionSearch` is a module singleton — a test that leaves the palette
    // open makes the next one's `openSessionSearch()` a no-op (the watcher only
    // fires on the closed→open edge), and its data load never runs.
    useSessionSearch().sessionSearchOpen.value = false
  })

  it('searches tasks, files and skills together and groups the results', async () => {
    apiMocks.searchFilesMock.mockResolvedValue({
      entries: [{ name: 'docker-notes.md', path: 'notes/docker-notes.md', isDir: false, size: 12, modTime: '' }],
      truncated: true,
    })
    apiMocks.fetchSkillsMock.mockResolvedValue({
      categories: [
        {
          name: 'ops',
          description: '',
          skills: [
            { name: 'docker-deploy', description: 'ship a container' },
            { name: 'unrelated', description: 'nothing to do with it' },
          ],
        },
      ],
      archived: [],
    })

    const { openSessionSearch } = useSessionSearch()
    const wrapper = mount(SessionSearchModal)

    openSessionSearch()
    await flushPromises()
    await nextTick()

    await wrapper.find('input.n-input-stub').setValue('docker')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    await nextTick()

    expect(apiMocks.searchFilesMock).toHaveBeenCalledWith('docker', 10)
    // Only the matching skill, and one header per kind.
    expect(wrapper.findAll('[data-kind="skill"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('docker-notes.md')
    expect(wrapper.text()).toContain('docker-deploy')
    expect(wrapper.text()).not.toContain('unrelated')
    expect(wrapper.findAll('.result-group').map(node => node.text())).toEqual([
      'chat.searchGroup.task',
      'chat.searchGroup.file',
      'chat.searchGroup.skill',
      // The file walk hit its cap, and the palette says so.
      'chat.searchFilesTruncated',
    ])
  })

  it('keeps the other groups when one source fails', async () => {
    apiMocks.searchFilesMock.mockRejectedValue(new Error('workspace unreachable'))
    apiMocks.fetchSkillsMock.mockResolvedValue({
      categories: [{ name: 'ops', description: '', skills: [{ name: 'docker-deploy', description: '' }] }],
      archived: [],
    })

    const { openSessionSearch } = useSessionSearch()
    const wrapper = mount(SessionSearchModal)

    openSessionSearch()
    await flushPromises()
    await nextTick()

    await wrapper.find('input.n-input-stub').setValue('docker')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).toContain('Debugging session')
    expect(wrapper.text()).toContain('docker-deploy')
    expect(wrapper.findAll('[data-kind="file"]')).toHaveLength(0)
  })

  it('opens from Cmd/Ctrl+K and loads recent sessions', async () => {
    const { openSessionSearch, sessionSearchOpen } = useSessionSearch()
    const wrapper = mount(SessionSearchModal, {
      global: {
        stubs: {
          NModal: false,
          NInput: false,
          NSpin: false,
          NButton: false,
        },
      },
    })

    openSessionSearch()
    await flushPromises()
    await nextTick()

    expect(sessionSearchOpen.value).toBe(true)
    expect(apiMocks.fetchSessionsMock).toHaveBeenCalledWith(undefined, 8)
    expect(wrapper.text()).toContain('Recent Docker fix')
  })

  it('searches by content and opens the matched session', async () => {
    const { openSessionSearch } = useSessionSearch()
    const wrapper = mount(SessionSearchModal)

    openSessionSearch()
    await flushPromises()
    await nextTick()

    const input = wrapper.find('input.n-input-stub')
    await input.setValue('docker')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    await nextTick()

    expect(apiMocks.searchSessionsMock).toHaveBeenCalledWith('docker', undefined, 10)
    expect(wrapper.text()).toContain('Debugging session')

    await wrapper.find('button.result-item').trigger('click')
    await flushPromises()

    expect(chatStoreMock.loadSessions).toHaveBeenCalled()
    expect(chatStoreMock.switchSession).toHaveBeenCalledWith('match-1', '17')
    expect(apiMocks.routerPushMock).toHaveBeenCalledWith({ name: 'hermes.session', params: { sessionId: 'match-1' } })
  })
})

describe('keyboard shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const { closeSessionSearch } = useSessionSearch()
    closeSessionSearch()
    chatStoreMock.newChat.mockReset()
  })

  it('opens session search on Cmd/Ctrl+K', async () => {
    const Dummy = defineComponent({
      setup() {
        useKeyboard()
        return () => h('div')
      },
    })

    mount(Dummy)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()

    expect(useSessionSearch().sessionSearchOpen.value).toBe(true)
  })
})
