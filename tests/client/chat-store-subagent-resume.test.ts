// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
}))

const sessionsApi = vi.hoisted(() => ({
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onAuthResolved: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  getActiveExpertId: () => null,
  setActiveExpertId: () => {},
  hasApiKey: () => false,
  canAccessProtectedRoutes: () => true,
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessionMessagesPage: sessionsApi.fetchSessionMessagesPage,
  fetchSessions: sessionsApi.fetchSessions,
  fetchWorkspaceRunChanges: vi.fn(() => Promise.resolve([])),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now() }
}

/** Exactly the payload shape the server replays for a subagent card. */
function subagentPayload(event: string, extra: Record<string, unknown> = {}) {
  return {
    event,
    run_id: 'resp_run_1',
    response_id: 'resp_run_1',
    session_id: 'session-1',
    subagent_id: 'sa-0',
    task_index: 0,
    task_count: 2,
    goal: 'summarise',
    ...extra,
  }
}

function delegateCards(store: ReturnType<typeof useChatStore>) {
  const session = store.sessions.find(item => item.id === 'session-1')
  return (session?.messages || []).filter(message => message.role === 'tool' && message.toolName === 'delegate_task')
}

describe('subagent cards survive a resume', () => {
  let pinia: Pinia

  beforeEach(() => {
    vi.resetAllMocks()
    pinia = createPinia()
    setActivePinia(pinia)
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue(null)
    sessionsApi.fetchSessions.mockResolvedValue([])
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.registerSessionHandlers.mockImplementation(() => vi.fn())
  })

  afterEach(() => {
    disposePinia(pinia)
  })

  // Failure mode 1: the run finished, the tab reloads. The card is never
  // persisted as a message, so it can only come back from the replayed events.
  it('rebuilds a finished delegate_task card from the replayed resume events', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      void onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: false,
        events: [
          {
            event: 'subagent.complete',
            data: subagentPayload('subagent.complete', {
              status: 'completed',
              summary: 'summarised 3 files',
              duration_seconds: 9,
              duration: 9,
            }),
          },
        ],
      })
      return {} as any
    })

    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')

    const cards = delegateCards(store)
    expect(cards).toHaveLength(1)
    expect(cards[0].toolCallId).toBe('subagent:resp_run_1:sa-0')
    expect(cards[0].toolStatus).toBe('done')
    expect(cards[0].toolPreview).toContain('completed')
    expect(cards[0].toolPreview).toContain('summarised 3 files')
    expect(JSON.parse(String(cards[0].toolResult))).toEqual(expect.objectContaining({
      status: 'completed',
      summary: 'summarised 3 files',
    }))
  })

  // Failure mode 2: the socket drops mid-run and the subagent completes while
  // it is down. The reconnect path ignores subagent entries in the resumed
  // array, so the server re-emits them onto the registered socket listener.
  it('settles a card left running when the re-emitted completion arrives on reconnect', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      void onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: true,
        events: [{ event: 'subagent.start', data: subagentPayload('subagent.start') }],
      })
      return {} as any
    })

    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')

    const running = delegateCards(store)
    expect(running).toHaveLength(1)
    expect(running[0].toolStatus).toBe('running')

    // The server's post-`resumed` re-emit lands on the listener registered for
    // the still-working session — the only channel that reaches this path.
    const handlers = chatApi.registerSessionHandlers.mock.calls.find(call => call[0] === 'session-1')?.[1]
    expect(handlers?.onSubagentEvent).toBeTypeOf('function')
    handlers.onSubagentEvent(subagentPayload('subagent.complete', {
      status: 'completed',
      summary: 'done while offline',
      duration_seconds: 4,
      duration: 4,
    }))

    const settled = delegateCards(store)
    expect(settled).toHaveLength(1)
    expect(settled[0].toolCallId).toBe('subagent:resp_run_1:sa-0')
    expect(settled[0].toolStatus).toBe('done')
    expect(settled[0].toolPreview).toContain('done while offline')
  })
  it.each(['completed', 'interrupted'])('keeps %s terminal after a late live tool frame', async (status) => {
    chatApi.resumeSession.mockImplementation((sessionId, onResumed) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {}
    })
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    const handlers = chatApi.registerSessionHandlers.mock.calls.find(call => call[0] === 'session-1')![1]
    handlers.onSubagentEvent(subagentPayload('subagent.complete', { status, summary: 'final result' }))
    const result = delegateCards(store)[0].toolResult
    expect(delegateCards(store)[0].toolStatus).toBe(status === 'completed' ? 'done' : 'error')
    handlers.onSubagentEvent(subagentPayload('subagent.tool', { tool: 'terminal', text: 'late' }))
    expect(delegateCards(store)).toHaveLength(1)
    expect(delegateCards(store)[0].toolStatus).toBe(status === 'completed' ? 'done' : 'error')
    expect(delegateCards(store)[0].toolResult).toBe(result)
  })

  it.each(['summary_truncated', 'text_truncated'])('marks %s in RESULT and restores the original message position', async (flag) => {
    chatApi.resumeSession.mockImplementation((sessionId, onResumed) => {
      onResumed({
        session_id: sessionId, isWorking: false,
        messages: [
          { id: 1, role: 'user', content: 'question', timestamp: 1 },
          { id: 2, role: 'assistant', content: 'answer', timestamp: 3 },
        ],
        events: [{ event: 'subagent.complete', data: subagentPayload('subagent.complete', {
          status: 'completed', summary: 'partial', [flag]: true, created_at: 2000,
        }) }],
      })
      return {}
    })
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    expect(delegateCards(store)[0].toolResult).toContain('... (truncated)')
    expect(delegateCards(store)[0].timestamp).toBe(2000)
    expect(store.sessions[0].messages.map(message => message.role)).toEqual(['user', 'tool', 'assistant'])
  })

})
