// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const chatStoreMock = vi.hoisted(() => ({
  messages: [] as Array<Record<string, any>>,
  activeSessionId: 'session-1',
  queuedUserMessages: new Map<string, any[]>(),
  focusMessageId: null as string | null,
  isRunActive: false,
  activeExpertAvatar: '',
  abortState: null as any,
  compressionState: null as any,
  removeQueuedMessage: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: {
    props: ['message'],
    template: `
      <div class="message-item" :data-role="message.role" :data-id="message.id">
        <template v-if="message.role === 'tool'">
          {{ message.toolName }} {{ message.toolPreview }}
        </template>
        <template v-else>{{ message.content }}</template>
      </div>
    `,
  },
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'

describe('MessageList streaming display', () => {
  beforeEach(() => {
    chatStoreMock.messages = []
    chatStoreMock.activeSessionId = 'session-1'
    chatStoreMock.queuedUserMessages = new Map()
    chatStoreMock.focusMessageId = null
    chatStoreMock.isRunActive = false
    chatStoreMock.activeExpertAvatar = ''
    chatStoreMock.abortState = null
    chatStoreMock.compressionState = null
    vi.clearAllMocks()
  })

  it('hides a transient reasoning-only assistant bubble while the thinking animation owns the run state', () => {
    chatStoreMock.isRunActive = true
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
      { id: 'a1', role: 'assistant', content: '', reasoning: 'checking context', isStreaming: true, timestamp: Date.now() },
    ]

    const wrapper = mount(MessageList)

    expect(wrapper.findAll('.message-item').map(node => node.attributes('data-id'))).toEqual(['u1'])
    expect(wrapper.find('.streaming-indicator').exists()).toBe(true)
    // Upstream rebaseline replaced the fork's <video class="thinking-video"> with an
    // <img class="thinking-avatar"> (thinking.gif) inside the streaming indicator.
    expect(wrapper.find('.thinking-avatar').exists()).toBe(true)
  })

  it('uses the selected expert avatar for the live thinking indicator', () => {
    const expertAvatar = '/api/hermes/plugin-assets/keep-resource-delivery/expert.png'
    chatStoreMock.isRunActive = true
    chatStoreMock.activeExpertAvatar = expertAvatar
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
    ]

    const wrapper = mount(MessageList)

    const avatar = wrapper.get('img.thinking-avatar')
    expect(avatar.attributes('src')).toBe(expertAvatar)
  })

  it('shows current tool calls in the streaming tool panel while the run is active', () => {
    chatStoreMock.isRunActive = true
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'run terminal', timestamp: Date.now() },
      {
        id: 't1',
        role: 'tool',
        content: '',
        toolName: 'terminal',
        toolPreview: 'python3 -c "print(1)"',
        toolStatus: 'running',
        timestamp: Date.now(),
      },
    ]

    const wrapper = mount(MessageList)

    expect(wrapper.findAll('.message-item').map(node => node.attributes('data-id'))).toEqual(['u1'])
    expect(wrapper.find('.tool-calls-panel').exists()).toBe(true)
    expect(wrapper.text()).toContain('terminal')
    expect(wrapper.text()).toContain('python3 -c "print(1)"')
    expect(wrapper.find('.thinking-avatar').exists()).toBe(true)
  })

  it('renders completed tool calls through the upstream MessageItem transcript after the run finishes', () => {
    chatStoreMock.isRunActive = false
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'run terminal', timestamp: Date.now() },
      {
        id: 't1',
        role: 'tool',
        content: '',
        toolName: 'terminal',
        toolPreview: 'printf TOOL_PANEL_OK_DONE',
        toolStatus: 'done',
        timestamp: Date.now(),
      },
      { id: 'a1', role: 'assistant', content: 'done', timestamp: Date.now() },
    ]

    const wrapper = mount(MessageList)

    expect(wrapper.findAll('.message-item').map(node => node.attributes('data-id'))).toEqual(['u1', 't1', 'a1'])
    expect(wrapper.find('.tool-trace-message').exists()).toBe(false)
    expect(wrapper.text()).toContain('terminal')
    expect(wrapper.text()).toContain('printf TOOL_PANEL_OK_DONE')
    expect(wrapper.find('.thinking-video').exists()).toBe(false)
    expect(wrapper.find('.streaming-indicator').exists()).toBe(false)
  })

  it('renders a single live running tool call once in the active panel', () => {
    // Upstream rebaseline moved tool-message dedup into the chat store: the live-update
    // events reuse the existing message with a matching toolCallId
    // (stores/hermes/chat.ts msgs.find(m => m.role === 'tool' && m.toolCallId === ...)),
    // so two separate messages sharing one toolCallId can never coexist in
    // chatStore.messages. The view layer no longer dedups by toolCallId; it renders
    // each distinct store message once. We feed the realistic post-merge single message.
    chatStoreMock.isRunActive = true
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'run terminal', timestamp: Date.now() },
      {
        id: 't-live',
        role: 'tool',
        content: '',
        toolCallId: 'tc-terminal-1',
        toolName: 'terminal',
        toolPreview: 'printf TOOL_PANEL_OK_LIVE',
        toolStatus: 'running',
        timestamp: Date.now(),
      },
    ]

    const wrapper = mount(MessageList)

    expect(wrapper.find('.streaming-indicator').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-item')).toHaveLength(1)
    expect(wrapper.text()).toContain('printf TOOL_PANEL_OK_LIVE')
  })

  it('keeps completed tools in the live upstream panel until the run completes', () => {
    chatStoreMock.isRunActive = true
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'run terminal', timestamp: Date.now() },
      {
        id: 't1',
        role: 'tool',
        content: '',
        toolCallId: 'tc-terminal-1',
        toolName: 'terminal',
        toolPreview: 'printf TOOL_PANEL_OK_DONE',
        toolStatus: 'done',
        timestamp: Date.now(),
      },
      { id: 'a1', role: 'assistant', content: 'STREAMING_RESULT', isStreaming: true, timestamp: Date.now() },
    ]

    const wrapper = mount(MessageList)

    expect(wrapper.findAll('.message-item').map(node => node.attributes('data-id'))).toEqual(['u1', 'a1'])
    expect(wrapper.find('.tool-trace-message').exists()).toBe(false)
    expect(wrapper.find('.streaming-indicator').exists()).toBe(true)
    expect(wrapper.find('.thinking-avatar').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-item')).toHaveLength(1)
    expect(wrapper.text()).toContain('STREAMING_RESULT')
  })

  it('renders repeated broker tool ids once per user turn', () => {
    chatStoreMock.isRunActive = false
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'first terminal', timestamp: Date.now() },
      {
        id: 't1',
        role: 'tool',
        content: '',
        toolCallId: 'broker_tool_reused_terminal',
        toolName: 'terminal',
        toolPreview: 'printf FIRST',
        toolStatus: 'done',
        timestamp: Date.now(),
      },
      { id: 'a1', role: 'assistant', content: 'first done', timestamp: Date.now() },
      { id: 'u2', role: 'user', content: 'second terminal', timestamp: Date.now() },
      {
        id: 't2',
        role: 'tool',
        content: '',
        toolCallId: 'broker_tool_reused_terminal',
        toolName: 'terminal',
        toolPreview: 'printf SECOND',
        toolStatus: 'done',
        timestamp: Date.now(),
      },
      { id: 'a2', role: 'assistant', content: 'second done', timestamp: Date.now() },
    ]

    const wrapper = mount(MessageList)

    expect(wrapper.findAll('.message-item').filter(node => node.attributes('data-role') === 'tool')).toHaveLength(2)
    expect(wrapper.findAll('.tool-call-item')).toHaveLength(0)
    expect(wrapper.text()).toContain('printf FIRST')
    expect(wrapper.text()).toContain('printf SECOND')
  })

  it('keeps prior-turn tool traces visible while hiding only current live tools with reused broker ids', () => {
    chatStoreMock.isRunActive = true
    chatStoreMock.messages = [
      { id: 'u1', role: 'user', content: 'first terminal', timestamp: Date.now() },
      {
        id: 't1',
        role: 'tool',
        content: '',
        toolCallId: 'broker_tool_run_terminal',
        toolName: 'terminal',
        toolPreview: 'printf FIRST',
        toolStatus: 'done',
        timestamp: Date.now(),
      },
      { id: 'a1', role: 'assistant', content: 'first done', timestamp: Date.now() },
      { id: 'u2', role: 'user', content: 'second terminal', timestamp: Date.now() },
      {
        id: 't2',
        role: 'tool',
        content: '',
        toolCallId: 'broker_tool_run_terminal',
        toolName: 'terminal',
        toolPreview: 'printf SECOND',
        toolStatus: 'running',
        timestamp: Date.now(),
      },
    ]

    const wrapper = mount(MessageList)
    const messageIds = wrapper.findAll('.message-item').map(node => node.attributes('data-id'))

    expect(messageIds).toContain('t1')
    expect(messageIds).not.toContain('t2')
    expect(wrapper.text()).toContain('printf FIRST')
    expect(wrapper.find('.streaming-indicator').text()).toContain('printf SECOND')
  })
})
