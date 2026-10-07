// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zh from '@/i18n/locales/zh'

const LOCKED_COPY = zh.chat.expertSlot.lockedByMessages
const SAVE_FAILED_COPY = zh.common.saveFailed

// The store has to be a real reactive proxy: `expertSelectionLocked` is a
// computed, and a plain mock object tracks no dependencies, so a message that
// arrives after the first render would never invalidate the cached value.
const chatState = vi.hoisted(() => ({
  activeSession: null as any,
  activeSessionId: null as string | null,
  sessions: [] as any[],
  activeExpertId: null as string | null,
  runtimeMode: 'agent',
  isStreaming: false,
  isAborting: false,
  consumeStagedComposerDraft: vi.fn(() => ''),
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

const messageMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', async () => {
  const { reactive } = await import('vue')
  return { useChatStore: () => reactive(chatState) }
})

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => appStoreMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStoreMock,
}))

const consumeSessionExpertSaveErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(() => Promise.resolve(200000)),
  consumeSessionExpertSaveError: consumeSessionExpertSaveErrorMock,
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn(),
}))

vi.mock('@/api/hermes/cowork', () => ({
  getCoworkProject: vi.fn(),
}))

const fetchExpertsMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/hermes/experts', () => ({
  fetchExperts: fetchExpertsMock,
}))

vi.mock('naive-ui', () => ({
  NButton: {
    template: '<button><slot /><slot name="icon" /></button>',
  },
  NTooltip: {
    template: '<span><slot name="trigger" /><slot /></span>',
  },
  NSwitch: {
    props: ['size', 'round', 'value'],
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
  useMessage: () => messageMock,
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { useChatStore } from '@/stores/hermes/chat'

const chatStore = useChatStore() as any
const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'zh', messages: { zh } })

const EXPERT = { id: 'expert-a', name: 'Expert A', title: '专家 A', avatar: 'https://example.invalid/a.png' }

// Mounted for real, not shallow: the disabled state and the hint live on the
// button inside the tooltip's trigger slot, which a shallow render never reaches.
// Only the unrelated sibling widgets are stubbed out.
async function mountInput() {
  const wrapper = mount(ChatInput, {
    global: {
      plugins: [i18n],
      stubs: {
        AgentPicker: { template: '<div />' },
        CoworkProjectPicker: { template: '<div />' },
        ChatScheduledEntry: { template: '<div />' },
        FeishuLinkPreviewCard: { template: '<div />' },
        VoiceDialogueControls: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

function expertPicker(wrapper: Awaited<ReturnType<typeof mountInput>>) {
  return wrapper.findAllComponents({ name: 'NPopselect' })
    .find(component => (component.props('options') as any[])?.some(option => option.value === EXPERT.id))!
}

describe('ChatInput expert slot lock', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    chatStore.activeSession = null
    chatStore.activeSessionId = null
    chatStore.sessions = []
    chatStore.activeExpertId = null
    chatStore.runtimeMode = 'agent'
    chatStore.isStreaming = false
    chatStore.selectActiveExpert.mockResolvedValue(true)
    chatStore.refreshSessionListOnly.mockResolvedValue(undefined)
    consumeSessionExpertSaveErrorMock.mockReturnValue(null)
    chatStore.setSessionProject.mockReturnValue(null)
    fetchExpertsMock.mockResolvedValue({ experts: [EXPERT] })
  })

  it('locks the slot and explains why when the session has messages but no expert', async () => {
    chatStore.activeSession = { id: 'has-messages', source: 'cli', messageCount: 2, messages: [] }
    chatStore.activeSessionId = 'has-messages'
    const wrapper = await mountInput()

    expect(expertPicker(wrapper).props('disabled')).toBe(true)
    const button = wrapper.get('.expert-slot-button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-label')).toContain(LOCKED_COPY)
    wrapper.unmount()
  })

  it('keeps the slot locked when the session has messages and a bound expert', async () => {
    chatStore.activeSession = {
      id: 'bound', source: 'cli', expertId: EXPERT.id, messageCount: 0, messages: [{ id: 'm1' }],
    }
    chatStore.activeSessionId = 'bound'
    chatStore.activeExpertId = EXPERT.id
    const wrapper = await mountInput()

    expect(expertPicker(wrapper).props('disabled')).toBe(true)
    const button = wrapper.get('.expert-slot-button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-label')).toContain(EXPERT.title)
    wrapper.unmount()
  })

  it('lets a session without messages pick an expert and shows no error', async () => {
    chatStore.activeSession = { id: 'fresh', source: 'cli', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 'fresh'
    const wrapper = await mountInput()

    const picker = expertPicker(wrapper)
    expect(picker.props('disabled')).toBe(false)
    expect(wrapper.get('.expert-slot-button').attributes('disabled')).toBeUndefined()

    picker.vm.$emit('update:value', EXPERT.id)
    await flushPromises()

    expect(chatStore.selectActiveExpert).toHaveBeenCalledWith(EXPERT.id, {
      avatar: EXPERT.avatar,
      label: EXPERT.title,
    })
    expect(messageMock.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reports the fixed-expert rule from this request\u2019s 409 even after the active session changed', async () => {
    chatStore.activeSession = { id: 'race', source: 'cli', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 'race'
    chatStore.selectActiveExpert.mockResolvedValue(false)
    // The user switches to a different, still-empty session while the save is
    // in flight: judging the copy off `activeSession` would now say "generic
    // failure" for a request the server refused on the fixed-expert rule.
    chatStore.refreshSessionListOnly.mockImplementation(async () => {
      chatStore.activeSession = { id: 'other', source: 'cli', messageCount: 0, messages: [] }
      chatStore.activeSessionId = 'other'
    })
    consumeSessionExpertSaveErrorMock.mockImplementation((sessionId: string) => (
      sessionId === 'race'
        ? { status: 409, message: 'API Error 409: Expert is fixed once the session has messages' }
        : null
    ))
    const wrapper = await mountInput()

    expertPicker(wrapper).vm.$emit('update:value', EXPERT.id)
    await flushPromises()

    expect(chatStore.refreshSessionListOnly).toHaveBeenCalled()
    expect(consumeSessionExpertSaveErrorMock).toHaveBeenCalledWith('race')
    expect(messageMock.error).toHaveBeenCalledWith(LOCKED_COPY)
    expect(messageMock.error).not.toHaveBeenCalledWith(SAVE_FAILED_COPY)
    wrapper.unmount()
  })

  it('still surfaces the 409 copy when the session-list refresh rejects', async () => {
    chatStore.activeSession = { id: 'refresh-fails', source: 'cli', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 'refresh-fails'
    chatStore.selectActiveExpert.mockResolvedValue(false)
    chatStore.refreshSessionListOnly.mockRejectedValue(new Error('refresh exploded'))
    consumeSessionExpertSaveErrorMock.mockReturnValue({
      status: 409,
      message: 'API Error 409: Expert is fixed once the session has messages',
    })
    const wrapper = await mountInput()

    expertPicker(wrapper).vm.$emit('update:value', EXPERT.id)
    await flushPromises()

    expect(messageMock.error).toHaveBeenCalledWith(LOCKED_COPY)
    wrapper.unmount()
  })

  it('reports a generic save failure for a non-409 error even once the session has messages', async () => {
    chatStore.activeSession = { id: 'server-error', source: 'cli', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 'server-error'
    chatStore.selectActiveExpert.mockResolvedValue(false)
    // A message lands during the save: the old inference would have blamed the
    // fixed-expert rule for what was really a 500.
    chatStore.refreshSessionListOnly.mockImplementation(async () => {
      chatStore.activeSession = { id: 'server-error', source: 'cli', messageCount: 2, messages: [] }
    })
    consumeSessionExpertSaveErrorMock.mockReturnValue({ status: 500, message: 'API Error 500: boom' })
    const wrapper = await mountInput()

    expertPicker(wrapper).vm.$emit('update:value', EXPERT.id)
    await flushPromises()

    expect(messageMock.error).toHaveBeenCalledWith(SAVE_FAILED_COPY)
    expect(messageMock.error).not.toHaveBeenCalledWith(LOCKED_COPY)
    wrapper.unmount()
  })

  it('reports a generic save failure when no reason was recorded for the request', async () => {
    chatStore.activeSession = { id: 'plain-failure', source: 'cli', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 'plain-failure'
    chatStore.selectActiveExpert.mockResolvedValue(false)
    consumeSessionExpertSaveErrorMock.mockReturnValue(null)
    const wrapper = await mountInput()

    expertPicker(wrapper).vm.$emit('update:value', EXPERT.id)
    await flushPromises()

    expect(messageMock.error).toHaveBeenCalledWith(SAVE_FAILED_COPY)
    expect(messageMock.error).not.toHaveBeenCalledWith(LOCKED_COPY)
    wrapper.unmount()
  })
})
