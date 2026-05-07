// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const switchModelMock = vi.hoisted(() => vi.fn())
const startRunViaSocketMock = vi.hoisted(() => vi.fn(() => ({ abort: vi.fn() })))

vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => ''),
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    selectedModel: 'default-model',
    selectedProvider: 'default-provider',
    switchModel: switchModelMock,
  }),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: startRunViaSocketMock,
  resumeSession: vi.fn((_sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ messages: [], isWorking: false, events: [] })
    return { disconnect: vi.fn() }
  }),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => null),
}))

import { useChatStore } from '@/stores/hermes/chat'

function setActiveTestSession(store: ReturnType<typeof useChatStore>) {
  store.activeSession = {
    id: 'session-1',
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store user-mode model selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    isUserModeMock.mockReturnValue(false)
  })

  it('keeps compact model changes session-local in chat plane user mode', async () => {
    isUserModeMock.mockReturnValue(true)
    const store = useChatStore()
    setActiveTestSession(store)

    await store.switchSessionModel('gpt-5.4', 'openai')

    expect(store.activeSession?.model).toBe('gpt-5.4')
    expect(store.activeSession?.provider).toBe('openai')
    expect(switchModelMock).not.toHaveBeenCalled()
  })

  it('keeps updating the default model outside chat plane user mode', async () => {
    const store = useChatStore()
    setActiveTestSession(store)

    await store.switchSessionModel('gpt-5.4', 'openai')

    expect(switchModelMock).toHaveBeenCalledWith('gpt-5.4', 'openai')
  })

  it('includes the session provider in chat run payloads', async () => {
    const store = useChatStore()
    store.newChat()
    store.activeSession!.model = 'gpt-5.4'
    store.activeSession!.provider = 'openai'

    await store.sendMessage('hello')

    expect(startRunViaSocketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        provider: 'openai',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
    )
  })

  it('stores tool completed output on the visible tool message', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('run a terminal command')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool: 'terminal',
      preview: 'pip install matplotlib numpy Pillow -q',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      output: 'TypeError: FigureCanvasAgg.print_jpg() got an unexpected keyword argument',
      duration: 3.9,
    })

    const toolMessage = store.activeSession!.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolStatus: 'done',
      toolResult: 'TypeError: FigureCanvasAgg.print_jpg() got an unexpected keyword argument',
      toolDuration: 3.9,
    })
  })

  it('surfaces empty final output after tool activity as an error', async () => {
    const store = useChatStore()
    store.newChat()

    await store.sendMessage('use a tool and then fail')

    const onEvent = startRunViaSocketMock.mock.calls[0][1]
    onEvent({
      event: 'tool.started',
      session_id: store.activeSession!.id,
      tool: 'execute_code',
      preview: 'install dependencies',
    })
    onEvent({
      event: 'tool.completed',
      session_id: store.activeSession!.id,
      output: 'Deps installed',
      duration: 3.2,
    })
    onEvent({
      event: 'run.completed',
      session_id: store.activeSession!.id,
      output: '',
    })

    const systemMessage = store.activeSession!.messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('no final output after tool activity')
  })
})
