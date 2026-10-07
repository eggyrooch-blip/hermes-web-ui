// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const {
  fetchSkillsMock,
  fetchLinkPreviewsMock,
  micRecorderState,
  micStopMock,
  voiceStatus,
  voiceTranscribeAndSendMock,
} = vi.hoisted(() => ({
  fetchSkillsMock: vi.fn(),
  fetchLinkPreviewsMock: vi.fn(),
  micRecorderState: {
    value: {
      status: 'idle' as 'idle' | 'requesting' | 'recording' | 'stopping' | 'error',
      error: null as Error | null,
    },
  },
  micStopMock: vi.fn(),
  voiceStatus: { value: 'idle' as 'idle' | 'capturing' | 'transcribing' | 'sending' | 'error' },
  voiceTranscribeAndSendMock: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NInput: { template: '<input />' },
  NPopover: { template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
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
  NInputNumber: { template: '<input />' },
  NPopselect: {
    props: ['value', 'options'],
    emits: ['update:value'],
    template: `
      <div class="n-popselect-stub">
        <slot />
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="n-popselect-option"
          :data-value="option.value"
          @click="$emit('update:value', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionReasoningEffort: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/link-previews', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/hermes/link-previews')>()),
  fetchLinkPreviews: fetchLinkPreviewsMock,
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

vi.mock('@/composables/useMicRecorder', () => ({
  useMicRecorder: () => ({
    state: micRecorderState,
    isRecording: { value: false },
    start: vi.fn(),
    stop: micStopMock,
    cancel: vi.fn(),
  }),
}))

vi.mock('@/composables/useVoiceDialogue', () => ({
  useVoiceDialogue: (deps: unknown) => ({
    sessionId: 'test-voice-session',
    events: { value: [] },
    status: voiceStatus,
    activeCaptureId: { value: 'capture-1' },
    activeTurnId: { value: null },
    transcript: { value: '' },
    error: { value: null },
    isBusy: { value: voiceStatus.value !== 'idle' },
    beginCapture: vi.fn(),
    transcribeAndSend: (captureId: string, audio: Blob) => voiceTranscribeAndSendMock(deps, captureId, audio),
    commitTranscript: vi.fn(),
    cancelCapture: vi.fn(),
    markOutputStarted: vi.fn(),
    markOutputDone: vi.fn(),
  }),
}))

function mockViewport(matches: boolean) {
  let currentMatches = matches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    get matches() {
      return currentMatches
    },
    media: '(max-width: 768px)',
    addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.delete(listener)
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => mediaQuery),
  })

  return {
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches
      const event = { matches: nextMatches, media: mediaQuery.media } as MediaQueryListEvent
      listeners.forEach(listener => listener(event))
    },
  }
}

function mountForSession(
  sessionId: string,
  sessionOverrides: Partial<ReturnType<typeof useChatStore>['sessions'][number]> = {},
  options: { chatInputHeight?: number } = {},
) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  if (options.chatInputHeight !== undefined) {
    settingsStore.display = { chat_input_height: options.chatInputHeight }
  }
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  return mount(ChatInput, { global: { plugins: [pinia] } })
}

describe('ChatInput draft persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    micRecorderState.value.status = 'idle'
    micRecorderState.value.error = null
    micStopMock.mockReset()
    micStopMock.mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }))
    voiceStatus.value = 'idle'
    voiceTranscribeAndSendMock.mockReset()
    voiceTranscribeAndSendMock.mockImplementation(async (deps: { sendMessage: (text: string) => unknown }) => {
      await deps.sendMessage('voice transcript')
    })
    mockViewport(false)
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchLinkPreviewsMock.mockReset()
    fetchLinkPreviewsMock.mockResolvedValue({ previews: [] })
  })

  it('restores unsent text for the active session after the chat view is remounted', async () => {
    const wrapper = mountForSession('session-a')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('draft before tab switch')
    await nextTick()
    wrapper.unmount()

    const remounted = mountForSession('session-a')
    await nextTick()

    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('draft before tab switch')
  })

  it('previews a pasted link from any Feishu tenant without changing the draft URL', async () => {
    const url = 'https://acme.feishu.cn/wiki/Q9mXwXqfhi2j5SkR6HjctEpEncf'
    fetchLinkPreviewsMock.mockResolvedValue({
      previews: [{
        kind: 'wiki',
        title: 'Hermes 2026 H2 产品规划',
        type_label: '知识库文档',
        url,
        status: 'resolved',
      }],
    })
    const wrapper = mountForSession('session-feishu', { profile: 'default' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue(url)
    await textarea.trigger('paste', {
      clipboardData: {
        items: [],
        getData: (type: string) => type === 'text/plain' ? url : '',
      },
    })
    await vi.waitFor(() => expect(fetchLinkPreviewsMock).toHaveBeenCalledWith([url], 'default'))
    expect(wrapper.get('.feishu-link-preview').text()).toContain('Hermes 2026 H2 产品规划')
    expect(wrapper.find('.feishu-link-preview-card__body').exists()).toBe(false)
    expect(wrapper.find('.feishu-link-preview-card__footer').exists()).toBe(false)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('\u2063')

    await textarea.setValue('\u2063补充说明')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(useChatStore().sendMessage).toHaveBeenCalledWith(`${url}补充说明`, undefined)
    expect(wrapper.find('.feishu-link-preview').exists()).toBe(false)
  })

  it('preserves a cardified URL at its original position in the sent body', async () => {
    const url = 'https://acme.feishu.cn/wiki/token'
    const original = `帮我看 ${url} 里的第三章`
    fetchLinkPreviewsMock.mockResolvedValue({
      previews: [{ kind: 'wiki', title: '需求文档', type_label: '知识库文档', url, status: 'resolved' }],
    })
    const wrapper = mountForSession('session-inline', { profile: 'default' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue(original)
    await vi.waitFor(() => expect(wrapper.get('.feishu-link-preview').text()).toContain('需求文档'))
    expect((textarea.element as HTMLTextAreaElement).value).toBe('帮我看 \u2063 里的第三章')

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(useChatStore().sendMessage).toHaveBeenCalledWith(original, undefined)
  })

  it('does not carry a previous session preview URL into a new session draft', async () => {
    const url = 'https://acme.feishu.cn/wiki/token'
    localStorage.setItem('hermes_chat_input_drafts_v1', JSON.stringify({ 'session-b': 'session b draft' }))
    fetchLinkPreviewsMock.mockResolvedValue({
      previews: [{ kind: 'wiki', title: 'A 文档', type_label: '知识库文档', url, status: 'resolved' }],
    })
    const wrapper = mountForSession('session-a', { profile: 'profile-a' })
    await wrapper.get('textarea').setValue(url)
    await vi.waitFor(() => expect(wrapper.find('.feishu-link-preview').exists()).toBe(true))

    const store = useChatStore()
    const sessionB = { id: 'session-b', title: 'B', source: 'cli', profile: 'profile-b', messages: [], createdAt: Date.now(), updatedAt: Date.now() } as any
    store.sessions.push(sessionB)
    store.activeSessionId = 'session-b'
    store.activeSession = sessionB
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('session b draft')
    expect((localStorage.getItem('hermes_chat_input_drafts_v1') || '')).not.toContain(`session b draft${url}`)
  })

  it('previews a restored Feishu draft without requiring another paste event', async () => {
    const url = 'https://tenant.feishu.cn/base/base_token?table=table_id&view=view_id'
    localStorage.setItem('hermes_chat_input_drafts_v1', JSON.stringify({ 'session-restored': url }))
    fetchLinkPreviewsMock.mockResolvedValue({
      previews: [{ kind: 'base', title: '月度数据大屏', type_label: '多维表格', url, status: 'resolved' }],
    })

    const wrapper = mountForSession('session-restored', { profile: 'default' })

    await vi.waitFor(() => expect(fetchLinkPreviewsMock).toHaveBeenCalledWith([url], 'default'))
    expect(wrapper.get('.feishu-link-preview').text()).toContain('月度数据大屏')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('\u2063')
  })

  it('shows the resolved title for a public Open Platform document page', async () => {
    const url = 'https://open.feishu.cn/document/server-docs/docs/drive-v1/file/batch_query'
    fetchLinkPreviewsMock.mockResolvedValue({
      previews: [{
        kind: 'open_platform',
        title: '获取文件元数据 - 服务端 API - 飞书开放平台',
        type_label: '开放平台文档',
        url,
        status: 'resolved',
      }],
    })
    const wrapper = mountForSession('session-open-platform', { profile: 'default' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue(url)
    await textarea.trigger('paste', {
      clipboardData: { items: [], getData: () => url },
    })

    await vi.waitFor(() => expect(fetchLinkPreviewsMock).toHaveBeenCalledWith([url], 'default'))
    expect(wrapper.get('.feishu-link-preview').text()).toContain('获取文件元数据 - 服务端 API - 飞书开放平台')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('\u2063')
  })

  it('shows a generic Feishu chip when metadata lookup is unavailable', async () => {
    const url = 'https://globex.larksuite.com/client/todo/task?guid=task-1'
    fetchLinkPreviewsMock.mockRejectedValue(new Error('fetch failed'))
    const wrapper = mountForSession('session-generic', { profile: 'default' })

    await wrapper.get('textarea').setValue(url)
    await wrapper.get('textarea').trigger('paste', {
      clipboardData: { items: [], getData: () => url },
    })
    await vi.waitFor(() => expect(wrapper.get('.feishu-link-preview').text()).toContain('飞书链接'))
    expect(wrapper.text()).not.toContain('fetch failed')
  })

  it('does not preview a domain that merely contains the Feishu name', async () => {
    const url = 'https://evilfeishu.cn/wiki/token'
    const wrapper = mountForSession('session-spoof')

    await wrapper.get('textarea').setValue(url)
    await wrapper.get('textarea').trigger('paste', {
      clipboardData: { items: [], getData: () => url },
    })
    await flushPromises()

    expect(fetchLinkPreviewsMock).not.toHaveBeenCalled()
    expect(wrapper.find('.feishu-link-preview').exists()).toBe(false)
  })

  it('stores drafts under one localStorage key mapped by session id', async () => {
    const wrapperA = mountForSession('session-a')
    await wrapperA.get('textarea').setValue('draft for session a')
    await nextTick()
    wrapperA.unmount()

    const wrapperB = mountForSession('session-b')
    await wrapperB.get('textarea').setValue('draft for session b')
    await nextTick()
    wrapperB.unmount()

    expect(localStorage.getItem('hermes_chat_input_draft_v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1') || '{}')).toEqual({
      'session-a': 'draft for session a',
      'session-b': 'draft for session b',
    })

    const remountedA = mountForSession('session-a')
    await nextTick()
    expect((remountedA.get('textarea').element as HTMLTextAreaElement).value).toBe('draft for session a')
  })

  it('hides context usage for coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      inputTokens: 1200,
      outputTokens: 800,
      contextTokens: 2000,
    })
    await nextTick()

    expect(wrapper.find('.context-info').exists()).toBe(false)
    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })

  it('hides reasoning effort selector for coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
    })
    await nextTick()

    expect(wrapper.find('.n-slider-stub').exists()).toBe(false)
  })

  it('stores the selected reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning')
    const store = useChatStore()

    // Stop 5 of 0..7 — see reasoningEffortOptions in ChatInput.vue.
    await wrapper.get('.n-slider-stub').setValue('5')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('high')
    expect(wrapper.get('.reasoning-effort-button').attributes('style')).toContain('--reasoning-effort-accent-color: #f9c33c')
    expect(wrapper.get('.n-slider-stub').classes()).not.toContain('reasoning-effort-slider--max')
  })

  it('stores maximum reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning-max')
    const store = useChatStore()

    await wrapper.get('.n-slider-stub').setValue('7')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('max')
    expect(wrapper.get('.reasoning-effort-button').attributes('style')).toContain('--reasoning-effort-accent-color: #ef4444')
    expect(wrapper.get('.n-slider-stub').classes()).toContain('reasoning-effort-slider--max')
  })

  it('opens the skill picker from /skill and inserts the selected skill command', async () => {
    fetchSkillsMock.mockResolvedValue({
      categories: [
        {
          name: 'review',
          description: '',
          skills: [
            { name: 'github-pr-review', description: 'Review pull requests', enabled: true },
            { name: 'disabled-skill', description: 'Hidden', enabled: false },
          ],
        },
      ],
      archived: [],
    })
    const wrapper = mountForSession('session-skills', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/skill')
    await nextTick()

    await wrapper.get('.slash-command-item').trigger('mousedown')
    await flushPromises()
    await nextTick()

    expect(fetchSkillsMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/skill github-pr-review')
    expect(wrapper.text()).toContain('Review pull requests')
    expect(wrapper.text()).not.toContain('disabled-skill')

    await wrapper.get('.skill-picker-item').trigger('click')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill github-pr-review ')
  })

  it('uses configured desktop input height and lets drag override it until settings change', async () => {
    const wrapper = mountForSession('session-height', {}, { chatInputHeight: 140 })
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 140px')

    Object.defineProperty(wrapper.get('.input-wrapper').element, 'clientHeight', { value: 140, configurable: true })
    await wrapper.get('.resize-handle').trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 60 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 180px')

    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 120 }
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 120px')
  })

  it('keeps mobile chat input auto-height instead of applying configured height', async () => {
    mockViewport(true)
    const wrapper = mountForSession('session-mobile-height', {}, { chatInputHeight: 180 })
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style') || '').not.toContain('height: 180px')
  })

  it('does not overwrite desktop textarea height when inserting a voice transcript', async () => {
    voiceStatus.value = 'capturing'
    const wrapper = mountForSession('session-voice-height', {}, { chatInputHeight: 150 })
    await nextTick()

    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', { value: 96, configurable: true })

    await wrapper.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('voice transcript')
    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 150px')
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('100%')
  })

  it('clears dragged desktop height after switching to mobile so input restores auto-height', async () => {
    const viewport = mockViewport(false)
    const wrapper = mountForSession('session-mobile-switch-height', {}, { chatInputHeight: 140 })
    await nextTick()

    Object.defineProperty(wrapper.get('.input-wrapper').element, 'clientHeight', { value: 140, configurable: true })
    await wrapper.get('.resize-handle').trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 60 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 180px')

    viewport.setMatches(true)
    await nextTick()

    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', { value: 88, configurable: true })
    await textarea.setValue('mobile text')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('88px')
  })
})
