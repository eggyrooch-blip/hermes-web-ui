// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: vi.fn(),
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
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
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(),
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

function makeSession(id = 'session-1'): Session {
  return {
    id,
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// 推理强度 IS a per-session choice the client makes (sunke 2026-08-21). The
// server does not carry it on the session row, so the store owns three things:
// the per-session field, localStorage persistence keyed by session id, and
// putting it on the run payload — omitted entirely when unset, so a session that
// never touched the control sends the byte-identical request it always did.
const REASONING_LS_PREFIX = 'hermes:reasoning_effort:'

describe('chat store per-session reasoning effort', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    localStorage.clear()
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  })

  it('exposes the per-session effort setter', () => {
    const store = useChatStore()
    expect(typeof (store as Record<string, unknown>).setSessionReasoningEffort).toBe('function')
  })

  it('omits reasoning_effort when the session never set one', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('hello')

    const body = chatApi.startRunViaSocket.mock.calls[0][0]
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('sends the chosen effort on the run payload', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    store.setSessionReasoningEffort(session.id, 'high')
    await store.sendMessage('hello')

    const body = chatApi.startRunViaSocket.mock.calls[0][0]
    expect(body.reasoning_effort).toBe('high')
  })

  it('persists the choice and hydrates it back onto a fresh session row', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    store.setSessionReasoningEffort(session.id, 'medium')
    expect(localStorage.getItem(REASONING_LS_PREFIX + session.id)).toBe('medium')

    // A reload replaces the row with a server-mapped one carrying no effort;
    // the stored value must come back on it, or the choice reads as lost.
    store.sessions = [makeSession()]
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((store.sessions[0] as Record<string, unknown>).reasoningEffort).toBe('medium')
  })

  it('clears the stored value when the choice goes back to default', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    store.setSessionReasoningEffort(session.id, 'low')
    store.setSessionReasoningEffort(session.id, '')

    expect(localStorage.getItem(REASONING_LS_PREFIX + session.id)).toBeNull()
    await store.sendMessage('hello')
    const body = chatApi.startRunViaSocket.mock.calls[0][0]
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('never sends an effort for a coding-agent session', async () => {
    const store = useChatStore()
    const session = { ...makeSession(), source: 'coding_agent' } as Session
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    store.setSessionReasoningEffort(session.id, 'high')
    await store.sendMessage('hello')

    const body = chatApi.startRunViaSocket.mock.calls[0][0]
    expect(body.reasoning_effort).toBeUndefined()
  })
})
