// @vitest-environment jsdom
//
// Regression guard for agent-avatar-non-personal:
// The re-baseline (commit 9f7296e2) made the assistant bubble reuse the ACTIVE
// PROFILE's avatar. In multitenancy each user IS a profile, so the agent ended up
// wearing the user's own Feishu photo ("talking to yourself"). The agent bubble must
// instead render the AGENT's own per-agent logo (Hermes / Codex / Claude), matching the
// session list — never the profile's uploaded/image avatar.
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

  function mountAssistant(session: Record<string, any>) {
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
          // content empty so MarkdownRenderer (naive-ui) isn't mounted — the avatar
          // renders purely from message.role and is what we assert here.
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })
  }

  it('renders the Hermes agent logo (not the user profile avatar) for a normal session', () => {
    const wrapper = mountAssistant({ id: 's1', profile: '孙可' })
    const avatar = wrapper.get('img.msg-avatar')
    expect(avatar.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(avatar.attributes('alt')).toBe('Hermes')
    // NEVER the user's own photo.
    expect(avatar.attributes('src')).not.toBe(userPhoto)
  })

  it('renders a DIFFERENT (per-agent) logo for a coding-agent session', () => {
    const wrapper = mountAssistant({ id: 's2', profile: '孙可', source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' })
    const avatar = wrapper.get('img.msg-avatar')
    expect(avatar.attributes('src')).toBe('/coding-agents/codex-openai.png')
    expect(avatar.attributes('alt')).toBe('Codex')
  })
})
