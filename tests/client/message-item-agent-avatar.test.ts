// @vitest-environment jsdom
//
// Regression guard for agent-avatar-non-personal:
// The re-baseline (commit 9f7296e2) made the assistant bubble reuse the ACTIVE
// PROFILE's avatar. In multitenancy each user IS a profile, so the agent ended up
// wearing the user's own Feishu photo ("talking to yourself"). The agent bubble must
// instead render a FIXED, non-personal multiavatar-generated SVG — never the profile's
// uploaded/image avatar.
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

  it('renders a generated (non-personal) avatar for the agent even when the active profile has an image avatar', () => {
    // The active profile carries the user's own uploaded photo.
    const profiles = useProfilesStore()
    profiles.profiles = [
      { name: '孙可', active: true, avatar: { type: 'image', dataUrl: 'data:image/png;base64,AAAA' } } as any,
    ]
    profiles.activeProfileName = '孙可'
    const chat = useChatStore()
    chat.activeSession = { id: 's1', profile: '孙可' } as any

    const wrapper = mount(MessageItem, {
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

    const avatar = wrapper.find('.msg-avatar')
    expect(avatar.exists()).toBe(true)
    // Generated multiavatar SVG is shown...
    expect(avatar.find('.profile-avatar-svg').exists()).toBe(true)
    // ...and the user's personal image avatar is NOT.
    expect(avatar.find('.profile-avatar-image').exists()).toBe(false)
  })
})
