// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'

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

import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Session-switch scroll races: a slower load for a session the user already
 * left must never drive the transcript that is on screen now. MessageList keys
 * its initial-scroll pass off `isLoadingMessages`, so a stale finish leaking
 * through shows the wrong session's scroll position.
 */
describe('session switch scroll races', () => {
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

  it('keeps message loading scoped to the active session during rapid switches', async () => {
    const callbacks = new Map<string, (data: any) => void>()
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      callbacks.set(sessionId, onResumed)
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('session-1'), makeSession('session-2')]

    const firstSwitch = store.switchSession('session-1')
    const secondSwitch = store.switchSession('session-2')
    expect(store.activeSessionId).toBe('session-2')
    expect(store.isLoadingMessages).toBe(true)

    // session-1 finishes late; it is no longer on screen, so the loading flag
    // for session-2 must survive.
    callbacks.get('session-1')?.({
      session_id: 'session-1',
      messages: [],
      isWorking: false,
      events: [],
    })
    await firstSwitch
    expect(store.isLoadingMessages).toBe(true)

    callbacks.get('session-2')?.({
      session_id: 'session-2',
      messages: [],
      isWorking: false,
      events: [],
    })
    await secondSwitch
    expect(store.isLoadingMessages).toBe(false)
  })

  it('lands on the last session after three rapid switches', async () => {
    const callbacks = new Map<string, (data: any) => void>()
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      callbacks.set(sessionId, onResumed)
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('session-1'), makeSession('session-2'), makeSession('session-3')]

    const a = store.switchSession('session-1')
    const b = store.switchSession('session-2')
    const c = store.switchSession('session-3')

    // Resolve out of order: the middle one first, the newest last.
    callbacks.get('session-2')?.({
      session_id: 'session-2',
      messages: [{ id: 'm2', role: 'user', content: 'two', timestamp: 2 }],
      isWorking: false,
      events: [],
    })
    await b
    callbacks.get('session-1')?.({
      session_id: 'session-1',
      messages: [{ id: 'm1', role: 'user', content: 'one', timestamp: 1 }],
      isWorking: false,
      events: [],
    })
    await a
    callbacks.get('session-3')?.({
      session_id: 'session-3',
      messages: [{ id: 'm3', role: 'user', content: 'three', timestamp: 3 }],
      isWorking: false,
      events: [],
    })
    await c

    expect(store.activeSessionId).toBe('session-3')
    expect(store.activeSession?.id).toBe('session-3')
    expect(store.activeSession?.messages).toEqual([
      expect.objectContaining({ id: 'm3', content: 'three' }),
    ])
    expect(store.isLoadingMessages).toBe(false)
  })
})
