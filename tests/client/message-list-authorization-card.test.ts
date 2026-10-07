// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const chatStoreMock = vi.hoisted(() => ({
  messages: [] as Array<Record<string, any>>,
  activeSessionId: 'session-1',
  activeSession: null as Record<string, any> | null,
  queuedUserMessages: new Map<string, any[]>(),
  focusMessageId: null as string | null,
  isRunActive: false,
  activeExpertAvatar: '',
  abortState: null as any,
  compressionState: null as any,
  removeQueuedMessage: vi.fn(),
  activePendingApproval: null as any,
  activePendingClarify: null as any,
  activePendingReauth: null as any,
  pendingReauths: new Map<string, any>(),
  activePendingAuthorization: null as any,
  respondToAuthorization: vi.fn(),
  respondToClarify: vi.fn(),
  respondApproval: vi.fn(),
  triggerReauthReplay: vi.fn(),
}))
const feedbackStoreMock = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
  LIVE_CHAT_MAX_LOADED_MESSAGES: 300,
}))

vi.mock('@/stores/hermes/feedback', () => ({ useFeedbackStore: () => feedbackStoreMock }))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

// Render the raw i18n key so the assertions pin WHICH copy the card shows,
// independent of any one locale's prose.
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/skillCredentials', () => ({
  startSkillCredentialAuth: vi.fn(),
  fetchSkillCredentials: vi.fn(),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: {
    props: ['message', 'feedbackEligible'],
    template: '<div class="message-item" :data-id="message.id">{{ message.content }}</div>',
  },
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'

function pendingAuthorization(scopes: string[], overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    authorizationId: 'auth-1',
    service: 'lark-cli',
    scopes,
    expiresAt: 0,
    state: 'pending',
    verificationUri: undefined,
    submitting: false,
    error: undefined,
    ...overrides,
  }
}

describe('MessageList inline authorization card', () => {
  beforeEach(() => {
    chatStoreMock.messages = []
    chatStoreMock.activeSessionId = 'session-1'
    chatStoreMock.activeSession = { id: 'session-1', source: 'cli' }
    chatStoreMock.queuedUserMessages = new Map()
    chatStoreMock.activePendingApproval = null
    chatStoreMock.activePendingClarify = null
    chatStoreMock.activePendingReauth = null
    chatStoreMock.activePendingAuthorization = null
    vi.clearAllMocks()
  })

  // The consent page grants the connector APPLICATION its full permission set;
  // `scopes` is a model-supplied intent label that never narrows that grant. A
  // bare scope list therefore reads as a promise the click does not keep.
  it('tells the user the grant is app-wide whenever it shows a requested scope', () => {
    chatStoreMock.activePendingAuthorization = pendingAuthorization(['read'])

    const wrapper = mount(MessageList)
    const scopeLine = wrapper.get('[data-testid="authorization-scopes"]')

    // The requested scope is still shown, as context.
    expect(scopeLine.text()).toContain('chat.authorizationScopes')
    expect(scopeLine.text()).toContain('read')
    // ...but never on its own.
    expect(wrapper.find('[data-testid="authorization-grant-note"]').exists()).toBe(true)
    expect(scopeLine.text()).toContain('chat.authorizationScopesGrantHint')
  })

  it('keeps the broader-grant wording for a multi-scope request', () => {
    chatStoreMock.activePendingAuthorization = pendingAuthorization(['read', 'im:message', 'drive:file'])

    const wrapper = mount(MessageList)
    const scopeLine = wrapper.get('[data-testid="authorization-scopes"]')

    for (const scope of ['read', 'im:message', 'drive:file']) {
      expect(scopeLine.text()).toContain(scope)
    }
    expect(scopeLine.text()).toContain('chat.authorizationScopesGrantHint')
  })

  it('shows neither the scope list nor the grant note when no scope was requested', () => {
    chatStoreMock.activePendingAuthorization = pendingAuthorization([])

    const wrapper = mount(MessageList)

    expect(wrapper.find('[data-testid="authorization-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="authorization-scopes"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="authorization-grant-note"]').exists()).toBe(false)
  })

  // Guards the copy itself against being gutted back to a placeholder in any
  // locale. Deliberately does not pin exact prose — only that every locale ships
  // a real, translated, distinct sentence.
  it('ships real broader-grant copy in every locale', () => {
    const locales = { de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    const seen = new Set<string>()

    for (const [locale, messages] of Object.entries(locales)) {
      const hint = (messages.chat as Record<string, unknown>).authorizationScopesGrantHint
      expect(typeof hint, locale).toBe('string')
      expect((hint as string).length, locale).toBeGreaterThan(20)
      expect(hint, locale).not.toBe((messages.chat as Record<string, unknown>).authorizationScopes)
      seen.add(hint as string)
    }
    // Ten distinct translations, i.e. nobody copy-pasted English into the rest.
    expect(seen.size).toBe(10)
  })

  // sunke: 「能不能别让我已经完成授权呢？」 The server resolves the authorization
  // itself, so the success path is zero clicks in chat after 去授权.
  it('offers only 去授权 and 取消 as actions', () => {
    chatStoreMock.activePendingAuthorization = pendingAuthorization(['read'])

    const wrapper = mount(MessageList)

    expect(wrapper.find('[data-testid="authorization-authorize"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="authorization-cancel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="authorization-confirm"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="authorization-recheck"]').exists()).toBe(false)
  })

  it('never emits a confirm on its own while waiting', async () => {
    vi.useFakeTimers()
    try {
      chatStoreMock.activePendingAuthorization = pendingAuthorization(['read'], {
        state: 'authorizing',
        verificationUri: 'https://broker.invalid/device/AB12',
      })
      const wrapper = mount(MessageList)

      // Well past the old 3-second poll, and past the fallback delay too.
      await vi.advanceTimersByTimeAsync(30_000)
      await nextTick()

      expect(chatStoreMock.respondToAuthorization).not.toHaveBeenCalled()
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals the recheck fallback only after the wait drags, and it emits confirm', async () => {
    vi.useFakeTimers()
    try {
      chatStoreMock.activePendingAuthorization = pendingAuthorization(['read'], {
        state: 'authorizing',
        verificationUri: 'https://broker.invalid/device/AB12',
      })
      const wrapper = mount(MessageList)

      expect(wrapper.find('[data-testid="authorization-recheck"]').exists()).toBe(false)

      await vi.advanceTimersByTimeAsync(19_000)
      await nextTick()
      expect(wrapper.find('[data-testid="authorization-recheck"]').exists()).toBe(false)

      await vi.advanceTimersByTimeAsync(2_000)
      await nextTick()
      const link = wrapper.get('[data-testid="authorization-recheck"]')
      // Secondary by construction: a text link, not a third competing button.
      expect(link.element.tagName).toBe('BUTTON')
      expect(link.classes()).toContain('authorization-recheck-link')
      expect(link.attributes('aria-label')).toBe('chat.authorizationRecheckAria')

      await link.trigger('click')
      expect(chatStoreMock.respondToAuthorization).toHaveBeenCalledWith('confirm')
      expect(chatStoreMock.respondToAuthorization).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows no recheck fallback once the card has resolved', async () => {
    vi.useFakeTimers()
    try {
      chatStoreMock.activePendingAuthorization = pendingAuthorization(['read'], { state: 'success' })
      const wrapper = mount(MessageList)

      await vi.advanceTimersByTimeAsync(30_000)
      await nextTick()

      expect(wrapper.find('[data-testid="authorization-recheck"]').exists()).toBe(false)
      expect(chatStoreMock.respondToAuthorization).not.toHaveBeenCalled()
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never names a CLI, a token, or an open id in the authorization copy', () => {
    const locales = { de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }

    for (const [locale, messages] of Object.entries(locales)) {
      const chat = messages.chat as Record<string, unknown>
      const authorizationCopy = Object.entries(chat)
        .filter(([key]) => key.startsWith('authorization'))
        .map(([, value]) => String(value))
        .join(' ')
      for (const forbidden of ['lark-cli', 'kep-cli', 'token', 'ou_', 'Bearer']) {
        expect(authorizationCopy.toLowerCase(), `${locale} / ${forbidden}`)
          .not.toContain(forbidden.toLowerCase())
      }
    }
  })
})
