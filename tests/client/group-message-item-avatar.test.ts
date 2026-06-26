// @vitest-environment jsdom
//
// Regression guard: in a group chat, an AGENT (bot) message shows the Hermes agent logo
// — never the agent profile's avatar (which in multitenancy is the owner's Feishu photo).
// Human member messages keep their own avatar.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))

import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'
import type { ChatMessage } from '@/api/hermes/group-chat'

function mountGroup(message: Partial<ChatMessage>, agents: any[], members: any[] = []) {
  return mount(GroupMessageItem, {
    props: {
      message: {
        id: 'm1',
        roomId: 'room-1',
        senderId: 'x',
        senderName: 'x',
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        ...message,
      } as ChatMessage,
      agents,
      members,
      currentUserId: 'user-1',
    },
    global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
  })
}

describe('GroupMessageItem avatar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(), getVoices: vi.fn(() => []),
        speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      },
    })
  })

  it('shows the Hermes agent logo for an agent message, not a profile avatar', () => {
    const wrapper = mountGroup(
      { senderId: 'agent-1', senderName: 'UAT Agent' },
      [{ id: 'a', roomId: 'room-1', agentId: 'agent-1', profile: 'feishu_owner', name: 'UAT Agent', description: '', invited: 1 }],
    )
    const logo = wrapper.get('.avatar .group-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    // No profile/member avatar component for the agent.
    expect(wrapper.find('.avatar').findComponent({ name: 'ProfileAvatar' }).exists()).toBe(false)
  })

  it('shows the member avatar (not the agent logo) for a human member message', () => {
    const wrapper = mountGroup(
      { senderId: 'user-2', senderName: 'Bob' },
      [{ id: 'a', roomId: 'room-1', agentId: 'agent-1', profile: 'feishu_owner', name: 'UAT Agent', description: '', invited: 1 }],
      [{ userId: 'user-2', name: 'Bob', avatar: JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,AAAA' }) }],
    )
    // Member keeps the ProfileAvatar component; no agent logo.
    expect(wrapper.find('.avatar .group-agent-logo').exists()).toBe(false)
    expect(wrapper.find('.avatar').findComponent({ name: 'ProfileAvatar' }).exists()).toBe(true)
  })
})
