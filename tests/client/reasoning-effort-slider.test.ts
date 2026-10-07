// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zh from '@/i18n/locales/zh'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import zhTW from '@/i18n/locales/zh-TW'

// The store must be a real reactive proxy: the slider position, the accent
// colour and the popover heading are all computeds off activeSession, so a
// plain object would never invalidate them after a change.
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
  setSessionReasoningEffort: vi.fn(async () => true),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
  newChat: vi.fn(),
  setSessionProject: vi.fn(),
}))

const appStoreMock = vi.hoisted(() => ({
  selectedModel: 'default-model',
  selectedProvider: 'default-provider',
}))

const profilesStoreMock = vi.hoisted(() => ({ activeProfileName: 'user_a' }))
const messageMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))

vi.mock('@/stores/hermes/chat', async () => {
  const { reactive } = await import('vue')
  return { useChatStore: () => reactive(chatState) }
})

vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => appStoreMock }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profilesStoreMock }))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(() => Promise.resolve(200000)),
  consumeSessionExpertSaveError: vi.fn(() => null),
}))

vi.mock('@/api/hermes/model-context', () => ({ setModelContext: vi.fn() }))
vi.mock('@/api/hermes/cowork', () => ({ getCoworkProject: vi.fn() }))
vi.mock('@/api/hermes/experts', () => ({ fetchExperts: vi.fn(() => Promise.resolve({ experts: [] })) }))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<span><slot name="trigger" /><slot /></span>' },
  NSwitch: { props: ['size', 'round', 'value'], template: '<input type="checkbox" />' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: {
    name: 'NPopover',
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    name: 'NSlider',
    props: ['value', 'min', 'max', 'step', 'formatTooltip'],
    emits: ['update:value'],
    template: `
      <input
        class="n-slider-stub"
        type="range"
        :value="value"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
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

/** Stop index → stored value. The INDEX is what the slider emits, so this
 *  table is the contract between the handle position and what the agent gets.
 *  The values are core 0.21.3's parse_reasoning_effort vocabulary
 *  (hermes_constants.VALID_REASONING_EFFORTS plus the off state). */
const STOPS: Array<[number, string]> = [
  [0, ''],
  [1, 'none'],
  [2, 'minimal'],
  [3, 'low'],
  [4, 'medium'],
  [5, 'high'],
  [6, 'xhigh'],
  [7, 'max'],
]

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

describe('ChatInput reasoning effort slider', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    chatStore.setSessionReasoningEffort.mockResolvedValue(true)
    chatStore.activeSession = { id: 's1', source: 'cli', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 's1'
    chatStore.sessions = [chatStore.activeSession]
    chatStore.activeExpertId = null
    chatStore.runtimeMode = 'agent'
    chatStore.isStreaming = false
    chatStore.setSessionProject.mockReturnValue(null)
  })

  it('spans the eight stops from config default to max', async () => {
    const wrapper = await mountInput()
    const slider = wrapper.get('.n-slider-stub')

    expect(slider.attributes('min')).toBe('0')
    expect(slider.attributes('max')).toBe(String(STOPS.length - 1))
    expect(slider.attributes('step')).toBe('1')
  })

  it.each(STOPS)('writes stop %i as %s', async (index, expected) => {
    const wrapper = await mountInput()

    await wrapper.get('.n-slider-stub').setValue(String(index))
    await flushPromises()

    expect(chatStore.setSessionReasoningEffort).toHaveBeenCalledWith('s1', expected)
  })

  it('places the handle on the stop the session already holds', async () => {
    chatStore.activeSession.reasoningEffort = 'xhigh'
    const wrapper = await mountInput()

    expect((wrapper.get('.n-slider-stub').element as HTMLInputElement).value).toBe('6')
  })

  // An effort the slider has no stop for (an older row, or one written by
  // another surface) must not leave the handle unplaced.
  it('falls back to the first stop for a value it does not know', async () => {
    chatStore.activeSession.reasoningEffort = 'ultra'
    const wrapper = await mountInput()

    expect((wrapper.get('.n-slider-stub').element as HTMLInputElement).value).toBe('0')
  })

  it('names the current level in the popover heading', async () => {
    chatStore.activeSession.reasoningEffort = 'high'
    const wrapper = await mountInput()

    expect(wrapper.get('.reasoning-effort-slider-heading').text())
      .toContain(zh.chat.reasoningEffort.options.high)
  })

  // The slider prints only its two end labels, so without the count it reads
  // as a two-way switch rather than a scale.
  it('says how many levels the slider has', async () => {
    const wrapper = await mountInput()

    expect(wrapper.get('.reasoning-effort-slider-hint').text())
      .toBe(`拖动选择 · 共 ${STOPS.length} 档`)
  })

  it('hides the slider for coding-agent sessions', async () => {
    chatStore.activeSession = { id: 'codex-1', source: 'coding_agent', agent: 'codex', messageCount: 0, messages: [] }
    chatStore.activeSessionId = 'codex-1'
    chatStore.sessions = [chatStore.activeSession]
    const wrapper = await mountInput()

    expect(wrapper.find('.n-slider-stub').exists()).toBe(false)
  })
})

describe('reasoning effort locale coverage', () => {
  const locales: Record<string, any> = { de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }

  it.each(Object.keys(locales))('%s translates every stop and the drag hint', (name) => {
    const options = locales[name].chat.reasoningEffort.options
    for (const [, value] of STOPS) {
      const key = value || 'default'
      expect(options[key], `${name} missing chat.reasoningEffort.options.${key}`).toEqual(expect.any(String))
    }
    const hint = locales[name].chat.reasoningEffort.dragHint
    expect(hint, `${name} missing chat.reasoningEffort.dragHint`).toEqual(expect.any(String))
    expect(String(hint), `${name} drops {count}`).toContain('{count}')
  })
})
