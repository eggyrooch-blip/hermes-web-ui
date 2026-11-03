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
  NPopover: { template: '<div><slot name="trigger" /></div>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
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
function dropFiles(wrapper: ReturnType<typeof mountForSession>, files: File[]) {
  return wrapper.get('.input-wrapper').trigger('drop', {
    dataTransfer: { files },
  })
}

function imageFile(name = 'shot.png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

/**
 * Before sending, a picked image must be visible as a thumbnail, openable as a
 * full-size overlay, and removable — the overlay must not survive removing or
 * sending the attachment it points at.
 */
describe('ChatInput uploaded image preview', () => {
  let revokedUrls: string[]

  beforeEach(() => {
    localStorage.clear()
    revokedUrls = []
    micRecorderState.value.status = 'idle'
    micRecorderState.value.error = null
    micStopMock.mockReset()
    voiceStatus.value = 'idle'
    voiceTranscribeAndSendMock.mockReset()
    mockViewport(false)
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchLinkPreviewsMock.mockReset()
    fetchLinkPreviewsMock.mockResolvedValue({ previews: [] })

    let counter = 0
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: vi.fn(() => `blob:preview-${++counter}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: vi.fn((url: string) => { revokedUrls.push(url) }),
    })
  })

  it('shows a clickable thumbnail for a picked image before it is sent', async () => {
    const wrapper = mountForSession('preview-session')
    await dropFiles(wrapper, [imageFile()])
    await nextTick()

    const thumbButton = wrapper.get('.attachment-thumb-button')
    expect(thumbButton.attributes('aria-label')).toBe('shot.png')
    expect(wrapper.get('.attachment-thumb').attributes('src')).toBe('blob:preview-1')
    // Nothing was sent by picking the file.
    expect(useChatStore().sendMessage).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('opens the full-size overlay on thumbnail click and closes it again', async () => {
    const wrapper = mountForSession('preview-session')
    await dropFiles(wrapper, [imageFile()])
    await nextTick()

    expect(document.querySelector('.image-preview-overlay')).toBeNull()

    await wrapper.get('.attachment-thumb-button').trigger('click')
    await nextTick()

    const overlay = document.querySelector('.image-preview-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay?.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(document.querySelector('.image-preview-overlay')).toBeNull()

    wrapper.unmount()
  })

  it('removes the attachment, its object URL, and any open overlay', async () => {
    const wrapper = mountForSession('preview-session')
    await dropFiles(wrapper, [imageFile()])
    await nextTick()

    await wrapper.get('.attachment-thumb-button').trigger('click')
    await nextTick()
    expect(document.querySelector('.image-preview-overlay')).not.toBeNull()

    await wrapper.get('.attachment-remove').trigger('click')
    await nextTick()

    expect(wrapper.find('.attachment-preview').exists()).toBe(false)
    expect(document.querySelector('.image-preview-overlay')).toBeNull()
    expect(revokedUrls).toContain('blob:preview-1')

    wrapper.unmount()
  })

  it('does not make non-image attachments clickable', async () => {
    const wrapper = mountForSession('preview-session')
    await dropFiles(wrapper, [new File(['text'], 'notes.txt', { type: 'text/plain' })])
    await nextTick()

    expect(wrapper.find('.attachment-file').exists()).toBe(true)
    expect(wrapper.find('.attachment-thumb-button').exists()).toBe(false)

    wrapper.unmount()
  })

  it('clears the overlay when the message is sent', async () => {
    const wrapper = mountForSession('preview-session')
    await dropFiles(wrapper, [imageFile()])
    await nextTick()

    await wrapper.get('.attachment-thumb-button').trigger('click')
    await nextTick()
    expect(document.querySelector('.image-preview-overlay')).not.toBeNull()

    await wrapper.get('textarea').setValue('look at this')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await nextTick()

    expect(useChatStore().sendMessage).toHaveBeenCalled()
    expect(document.querySelector('.image-preview-overlay')).toBeNull()
    expect(wrapper.find('.attachment-preview').exists()).toBe(false)

    wrapper.unmount()
  })
})
