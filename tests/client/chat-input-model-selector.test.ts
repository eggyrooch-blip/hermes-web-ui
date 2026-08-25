// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const chatStoreMock = vi.hoisted(() => ({
  activeSession: null as any,
  activeSessionId: null as string | null,
  activeExpertId: null as string | null,
  isStreaming: false,
  isAborting: false,
  setAutoPlaySpeech: vi.fn(),
  setActiveExpert: vi.fn(),
  setActiveExpertDisplay: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
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
  NInputNumber: {
    template: '<input />',
  },
  NPopselect: {
    props: ['value', 'options'],
    template: '<div><slot /></div>',
  },
  NPopover: {
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
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
    chatStoreMock.activeExpertId = null
    fetchExpertsMock.mockResolvedValue({ experts: [] })
  })

  it('hosts the model picker in the composer tool row via the #model slot', () => {
    // The model picker used to live in the ChatPanel header; it now lives in the
    // composer tool row. ChatInput owns only the placement (a #model slot in the
    // tool row); the host (ChatPanel) injects the actual trigger so the model
    // selection logic stays there. The picker must render inside `.input-top-bar`.
    const wrapper = shallowMount(ChatInput, {
      slots: {
        model: '<div data-testid="model-selector" />',
      },
      // ComposerBox (the shared box the composer roots on) must render for real:
      // stubbed, it swallows its default slot and the tool row never exists.
      global: { stubs: { ComposerBox: false } },
    })

    const picker = wrapper.find('[data-testid="model-selector"]')
    expect(picker.exists()).toBe(true)
    expect(picker.element.closest('.input-top-bar')).not.toBeNull()
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
})
