// @vitest-environment jsdom
//
// Regression guard for agent-avatar-non-personal:
// The re-baseline (commit 9f7296e2) made the assistant bubble reuse the ACTIVE
// PROFILE's avatar. In multitenancy each user IS a profile, so the agent ended up
// wearing the user's own Feishu photo ("talking to yourself").
//
// The prototype has since deleted the assistant identity row entirely — the run's
// signature is the mascot on the thinking line (MessageList), not a per-message
// avatar + name. So the assertion is now the stronger one: an assistant turn
// renders NO avatar at all, and in particular never the user's own photo.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'

describe('MessageItem agent avatar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
    })
  })

  const userPhoto = 'data:image/png;base64,AAAA'

  function mountAssistant(session: Record<string, any>, messageSession?: Record<string, any>) {
    // The active profile carries the user's own uploaded photo.
    const profiles = useProfilesStore()
    profiles.profiles = [
      { name: '孙可', active: true, avatar: { type: 'image', dataUrl: userPhoto } } as any,
    ]
    profiles.activeProfileName = '孙可'
    const chat = useChatStore()
    chat.activeSession = session as any

    return mount(MessageItem, {
      props: {
        message: {
          // content empty so MarkdownRenderer (naive-ui) isn't mounted.
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        } satisfies Message,
        ...(messageSession ? { session: messageSession as any } : {}),
      },
    })
  }

  function expectNoIdentityRow(wrapper: ReturnType<typeof mountAssistant>) {
    // Prototype: no mark, no name, no image above the answer.
    expect(wrapper.find('.msg-agent-head').exists()).toBe(false)
    expect(wrapper.find('.msg-agent-tile').exists()).toBe(false)
    expect(wrapper.find('.msg-agent-name').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    // NEVER the user's own photo, by any route.
    expect(wrapper.html()).not.toContain(userPhoto)
  }

  it('renders no identity row above the answer for a normal session', () => {
    expectNoIdentityRow(mountAssistant({ id: 's1', profile: '孙可' }))
  })

  it('renders no identity row for a session carrying a persisted expert avatar', () => {
    expectNoIdentityRow(
      mountAssistant({
        id: 's-expert',
        profile: '孙可',
        expertId: 'keep-resource-delivery',
        expertLabel: '资源投放专家',
        expertAvatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
      }),
    )
  })

  it('does not let the global active expert avatar leak into a normal session', () => {
    const chat = useChatStore()
    chat.setActiveExpert('keep-resource-delivery', {
      avatar: '/api/hermes/plugin-assets/keep-resource-delivery/expert.png',
      label: '资源投放专家',
    })

    expectNoIdentityRow(mountAssistant({ id: 's-normal', profile: '孙可' }))
  })

  it('renders no identity row for a coding-agent session', () => {
    expectNoIdentityRow(
      mountAssistant({ id: 's2', profile: '孙可', source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' }),
    )
  })

  it('renders no identity row for a history message carrying its own session', () => {
    // History lists render a session that is NOT the globally active one.
    expectNoIdentityRow(
      mountAssistant(
        { id: 'active', profile: '孙可' },
        { id: 'history', profile: '孙可', source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' },
      ),
    )
  })
})
