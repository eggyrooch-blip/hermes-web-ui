// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'

const chatStoreMock = vi.hoisted(() => ({
  activeSession: null as any,
  activeSessionId: null as string | null,
  sessions: [] as any[],
  activeExpertId: null as string | null,
  runtimeMode: 'agent',
  isStreaming: false,
  consumeStagedComposerDraft: vi.fn(() => ''),
  isAborting: false,
  setAutoPlaySpeech: vi.fn(),
  setActiveExpert: vi.fn(),
  selectActiveExpert: vi.fn(),
  refreshSessionListOnly: vi.fn(),
  setActiveExpertDisplay: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
  newChat: vi.fn(),
  setSessionProject: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'default-model',
  selectedProvider: 'default-provider',
}))

const profilesStoreMock = vi.hoisted(() => ({
  activeProfileName: 'user_a',
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

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(() => Promise.resolve(200000)),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn(),
}))

const getCoworkProjectMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/hermes/cowork', () => ({
  getCoworkProject: getCoworkProjectMock,
}))

const fetchExpertsMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/hermes/experts', () => ({
  fetchExperts: fetchExpertsMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    template: '<button><slot /><slot name="icon" /></button>',
  },
  NTooltip: {
    template: '<span><slot name="trigger" /><slot /></span>',
  },
  NSwitch: {
    template: '<input type="checkbox" />',
  },
  NModal: {
    props: ['show'],
    template: '<div v-if="show"><slot /><slot name="footer" /></div>',
  },
  NPopover: {
    name: 'NPopover',
    template: '<div><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    name: 'NSlider',
    props: ['value', 'min', 'max', 'step', 'formatTooltip'],
    emits: ['update:value'],
    template: '<div class="n-slider-stub" />',
  },
  NInputNumber: {
    template: '<input />',
  },
  NPopselect: {
    name: 'NPopselect',
    props: ['value', 'options', 'disabled'],
    emits: ['update:value'],
    template: '<div><slot /></div>',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'

describe('ChatInput model selector placement', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    chatStoreMock.activeSession = null
    chatStoreMock.activeSessionId = null
    chatStoreMock.sessions = []
    chatStoreMock.activeExpertId = null
    chatStoreMock.selectActiveExpert.mockResolvedValue(true)
    chatStoreMock.refreshSessionListOnly.mockResolvedValue(undefined)
    chatStoreMock.runtimeMode = 'agent'
    fetchExpertsMock.mockResolvedValue({ experts: [] })
    chatStoreMock.setSessionProject.mockReturnValue(null)
  })

  it('does not render the model selector in the chat input toolbar', () => {
    const wrapper = shallowMount(ChatInput, {
      global: {
        stubs: {
          ModelSelector: {
            template: '<div data-testid="model-selector" />',
          },
        },
      },
    })

    expect(wrapper.find('[data-testid="model-selector"]').exists()).toBe(false)
  })

  it('uses the existing chat toolbar for Project selection', async () => {
    const wrapper = shallowMount(ChatInput)

    expect(wrapper.findComponent({ name: 'CoworkProjectPicker' }).exists()).toBe(true)
    wrapper.unmount()

    chatStoreMock.activeSession = { id: 'coding', source: 'coding_agent', messages: [] }
    const coding = shallowMount(ChatInput)
    expect(coding.findComponent({ name: 'CoworkProjectPicker' }).exists()).toBe(false)
    coding.unmount()

    chatStoreMock.activeSession = null
    chatStoreMock.runtimeMode = 'global_agent'
    const global = shallowMount(ChatInput)
    expect(global.findComponent({ name: 'CoworkProjectPicker' }).exists()).toBe(false)
  })

  it('ignores an older Project query response after the route changes', async () => {
    const route = reactive({ query: { project: 'project-a' } })
    const routerPush = vi.fn()
    const session = { id: 'session-1', source: 'cli', messages: [] }
    let resolveA!: (value: any) => void
    let resolveB!: (value: any) => void
    getCoworkProjectMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve }))
    chatStoreMock.activeSession = session
    chatStoreMock.activeSessionId = session.id
    chatStoreMock.sessions = [session]
    chatStoreMock.setSessionProject.mockReturnValue(session.id)

    const wrapper = shallowMount(ChatInput, {
      global: { config: { globalProperties: { $route: route, $router: { push: routerPush } } } },
    })
    await nextTick()
    expect(getCoworkProjectMock).toHaveBeenCalledWith('project-a')

    route.query.project = 'project-b'
    await nextTick()
    expect(getCoworkProjectMock).toHaveBeenCalledWith('project-b')

    resolveB({ id: 'project-b', name: 'Beta' })
    await flushPromises()
    resolveA({ id: 'project-a', name: 'Alpha' })
    await flushPromises()

    expect(chatStoreMock.setSessionProject).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.setSessionProject).toHaveBeenCalledWith(session.id, expect.objectContaining({ id: 'project-b' }))
    expect(chatStoreMock.setSessionProject).not.toHaveBeenCalledWith(session.id, expect.objectContaining({ id: 'project-a' }))
    wrapper.unmount()
  })

  it.each([
    ['plain', { id: 'plain', title: 'Plain', source: 'cli' }, null, false],
    ['coding', { id: 'coding', title: 'Coding', source: 'coding_agent', expertId: 'expert-a' }, 'expert-a', false],
    ['global', { id: 'global', title: 'Global', source: 'global_agent', expertId: 'expert-a' }, 'expert-a', false],
    ['changed catalog', { id: 'changed', title: 'Changed', source: 'cli', expertId: 'expert-b' }, 'expert-b', false],
    ['bound expert', { id: 'expert', title: 'Expert work', source: 'cli', expertId: 'expert-a' }, 'expert-a', true],
  ])('shows scheduled execution only for a current catalog-bound expert session: %s', async (_label, session, expertId, visible) => {
    chatStoreMock.activeSession = { messages: [], ...session }
    chatStoreMock.activeSessionId = session.id
    chatStoreMock.activeExpertId = expertId
    fetchExpertsMock.mockResolvedValue({
      experts: [{ id: 'expert-a', name: 'Expert A', skills: ['planner'] }],
    })
    const wrapper = shallowMount(ChatInput, {
      global: {
        stubs: {
          ChatScheduledEntry: { template: '<div data-testid="scheduled-entry" />' },
        },
      },
    })

    await flushPromises()
    expect(wrapper.find('[data-testid="scheduled-entry"]').exists()).toBe(visible)
    wrapper.unmount()
  })

  it('allows the user to clear a selected expert before the first run', async () => {
    chatStoreMock.activeSession = {
      id: 'expert-draft', source: 'cli', expertId: 'expert-a', messageCount: 0, messages: [],
    }
    chatStoreMock.activeSessionId = 'expert-draft'
    chatStoreMock.activeExpertId = 'expert-a'
    fetchExpertsMock.mockResolvedValue({ experts: [{ id: 'expert-a', name: 'Expert A' }] })
    const wrapper = shallowMount(ChatInput)
    await flushPromises()

    const picker = wrapper.findAllComponents({ name: 'NPopselect' })
      .find(component => (component.props('options') as any[])?.some(option => option.value === 'expert-a'))!
    expect(picker.props('disabled')).not.toBe(true)
    picker.vm.$emit('update:value', '')
    await flushPromises()

    expect(chatStoreMock.selectActiveExpert).toHaveBeenCalledWith(null, undefined)
  })
})
