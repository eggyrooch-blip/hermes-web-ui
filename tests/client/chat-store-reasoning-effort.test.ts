// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
}))

const sessionsApi = vi.hoisted(() => ({
  setSessionReasoningEffort: vi.fn(async () => true),
  fetchSessions: vi.fn(async () => [] as any[]),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  // Answer for a different session id so switchSession's resume takes its
  // "not my payload" branch and resolves at once. Without this every test that
  // triggers a session switch waits out the real 15s resume timeout.
  resumeSession: vi.fn((_sessionId: string, cb: (data: any) => void) => {
    queueMicrotask(() => cb({ session_id: '__not-this-session__' }))
  }),
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondAuthorization: vi.fn(),
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
}))

vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: sessionsApi.fetchSessions,
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChanges: vi.fn(),
  setSessionArchived: vi.fn(),
  setSessionExpert: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionReasoningEffort: sessionsApi.setSessionReasoningEffort,
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

/**
 * Hold every in-flight session GET open until the test releases it.
 * fetchRuntimeSessions fires TWO fetchSessions concurrently (local + global
 * agent), so a single captured resolver would leave one promise hanging.
 */
function holdSessionList() {
  const resolvers: Array<(rows: any[]) => void> = []
  sessionsApi.fetchSessions.mockImplementation(() => new Promise<any[]>((resolve) => {
    resolvers.push(resolve)
  }))
  return {
    release(rows: any[]) {
      // Only the plain listing carries rows; the global-agent listing is empty.
      resolvers.forEach((resolve, index) => resolve(index === 0 ? rows : []))
    },
  }
}

/** A row shaped like GET /api/hermes/sessions returns it. */
function serverRow(id: string, reasoningEffort: string) {
  return {
    id,
    source: 'cli',
    model: '',
    title: id,
    started_at: 1,
    ended_at: null,
    last_active: 1,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    reasoning_effort: reasoningEffort,
  }
}

function makeSession(id = 'session-1'): Session {
  return {
    id,
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * The choice lives on the session row, not in browser storage: the same
 * session opened on another device must come back at the same depth. These
 * tests pin the store half of that contract — optimistic UI, one serialized
 * write per session, rollback to the last server-confirmed value on failure.
 */
describe('chat store per-session reasoning effort', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sessionsApi.setSessionReasoningEffort.mockImplementation(async () => true)
    sessionsApi.fetchSessions.mockImplementation(async () => [])
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('applies the chosen effort optimistically and writes it to the server', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('s1')]

    const write = store.setSessionReasoningEffort('s1', 'low')

    // Optimistic: visible before the request resolves.
    expect(store.sessions[0].reasoningEffort).toBe('low')
    await expect(write).resolves.toBe(true)
    expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledWith('s1', 'low')
  })

  it('clears the override by writing an empty string', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('s2')]
    await store.setSessionReasoningEffort('s2', 'high')

    await store.setSessionReasoningEffort('s2', '')

    expect(store.sessions[0].reasoningEffort).toBeUndefined()
    expect(sessionsApi.setSessionReasoningEffort).toHaveBeenLastCalledWith('s2', '')
  })

  it('keeps each session independent', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a'), makeSession('b')]

    await Promise.all([
      store.setSessionReasoningEffort('a', 'minimal'),
      store.setSessionReasoningEffort('b', 'high'),
    ])

    expect(store.sessions.find(s => s.id === 'a')?.reasoningEffort).toBe('minimal')
    expect(store.sessions.find(s => s.id === 'b')?.reasoningEffort).toBe('high')
  })

  it('writes nothing for a session it does not know', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('only-one')]

    await expect(store.setSessionReasoningEffort('missing', 'high')).resolves.toBe(false)
    expect(store.sessions[0].reasoningEffort).toBeUndefined()
    expect(sessionsApi.setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('never stores the choice in localStorage', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('no-ls')]

    await store.setSessionReasoningEffort('no-ls', 'xhigh')

    expect(localStorage.length).toBe(0)
  })

  // A drag crosses every stop it passes, so the writes must not race: the stop
  // the user released on has to be the one the server ends up holding.
  it('serializes rapid changes so the last one wins', async () => {
    const order: string[] = []
    sessionsApi.setSessionReasoningEffort.mockImplementation(async (_id: string, effort: string) => {
      order.push(effort)
      return true
    })
    const store = useChatStore()
    store.sessions = [makeSession('drag')]

    const writes = [
      store.setSessionReasoningEffort('drag', 'low'),
      store.setSessionReasoningEffort('drag', 'medium'),
      store.setSessionReasoningEffort('drag', 'max'),
    ]
    await Promise.all(writes)

    expect(order).toEqual(['low', 'medium', 'max'])
    expect(store.sessions[0].reasoningEffort).toBe('max')
  })

  it('rolls back to the last confirmed value when the write fails', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('rollback')]
    await store.setSessionReasoningEffort('rollback', 'medium')

    sessionsApi.setSessionReasoningEffort.mockImplementation(async () => false)
    await expect(store.setSessionReasoningEffort('rollback', 'max')).resolves.toBe(false)

    expect(store.sessions[0].reasoningEffort).toBe('medium')
  })

  // REVIEW rowless-first-turn#p1: a brand-new chat has no server row, so the
  // POST would 404 and the rollback would snap the slider back to Default. The
  // pick is kept locally and rides the first run request instead.
  it('keeps the pick locally and skips the POST while the session has no server row', async () => {
    const store = useChatStore()
    const local = makeSession('brand-new')
    local.localCreated = true
    store.sessions = [local]

    await expect(store.setSessionReasoningEffort('brand-new', 'high')).resolves.toBe(true)

    expect(store.sessions[0].reasoningEffort).toBe('high')
    expect(sessionsApi.setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('starts POSTing once the first run has created the row', async () => {
    const store = useChatStore()
    const local = makeSession('now-real')
    local.localCreated = true
    store.sessions = [local]
    await store.setSessionReasoningEffort('now-real', 'high')

    // What sendMessage does after the first dispatch.
    store.sessions[0].localCreated = false
    await store.setSessionReasoningEffort('now-real', 'low')

    expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledTimes(1)
    expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledWith('now-real', 'low')
    expect(store.sessions[0].reasoningEffort).toBe('low')
  })

  // REVIEW repeated-value-stale-rollback#p1: high → low → high, with the FIRST
  // high failing. Value equality cannot tell the two `high`s apart, so the
  // stale failure used to roll the successful one back to medium.
  it('does not let a failed write roll back a later write of the same value', async () => {
    const results = [false, true, true]
    let call = 0
    sessionsApi.setSessionReasoningEffort.mockImplementation(async () => results[call++] ?? true)
    const store = useChatStore()
    const session = makeSession('repeat')
    session.reasoningEffort = 'medium'
    store.sessions = [session]

    const writes = [
      store.setSessionReasoningEffort('repeat', 'high'),
      store.setSessionReasoningEffort('repeat', 'low'),
      store.setSessionReasoningEffort('repeat', 'high'),
    ]
    await Promise.all(writes)

    expect(store.sessions[0].reasoningEffort).toBe('high')
  })

  it('short-circuits a repeated pick of the value already showing', async () => {
    const store = useChatStore()
    const session = makeSession('same')
    store.sessions = [session]
    await store.setSessionReasoningEffort('same', 'high')
    sessionsApi.setSessionReasoningEffort.mockClear()

    await expect(store.setSessionReasoningEffort('same', 'high')).resolves.toBe(true)

    expect(sessionsApi.setSessionReasoningEffort).not.toHaveBeenCalled()
    expect(store.sessions[0].reasoningEffort).toBe('high')
  })

  // REVIEW stale-response-overwrites-selection#p1: a list GET issued BEFORE the
  // pick can land after the POST already finished. Checking "is a write
  // pending" at response time saw none and overwrote the saved choice, so the
  // next message went out at the old depth.
  it('refreshSessionListOnly ignores a list response older than the pick', async () => {
    const store = useChatStore()
    const session = makeSession('stale-refresh')
    session.reasoningEffort = 'medium'
    store.sessions = [session]

    const pending = holdSessionList()

    // The GET goes out first, carrying the pre-pick value.
    const refresh = store.refreshSessionListOnly()
    await Promise.resolve()

    // The user picks high and the POST completes while the GET is still open.
    await store.setSessionReasoningEffort('stale-refresh', 'high')

    pending.release([serverRow('stale-refresh', 'medium')])
    await refresh

    expect(store.sessions.find(s => s.id === 'stale-refresh')?.reasoningEffort).toBe('high')
  })

  it('loadSessions carries a pick made while its request was in flight', async () => {
    const store = useChatStore()
    const session = makeSession('stale-load')
    session.reasoningEffort = 'medium'
    store.sessions = [session]

    const pending = holdSessionList()

    const load = store.loadSessions()
    await Promise.resolve()
    await store.setSessionReasoningEffort('stale-load', 'high')

    pending.release([serverRow('stale-load', 'medium')])
    await load

    expect(store.sessions.find(s => s.id === 'stale-load')?.reasoningEffort).toBe('high')
  })

  it('accepts the server value when no pick raced the request', async () => {
    const store = useChatStore()
    const session = makeSession('no-race')
    store.sessions = [session]
    sessionsApi.fetchSessions.mockImplementation(async () => [serverRow('no-race', 'xhigh')])

    await store.refreshSessionListOnly()

    expect(store.sessions.find(s => s.id === 'no-race')?.reasoningEffort).toBe('xhigh')
  })

  it('does not roll back over a newer pending choice', async () => {
    let failFirst = true
    sessionsApi.setSessionReasoningEffort.mockImplementation(async () => {
      const ok = !failFirst
      failFirst = false
      return ok
    })
    const store = useChatStore()
    store.sessions = [makeSession('newer')]

    const first = store.setSessionReasoningEffort('newer', 'low')
    const second = store.setSessionReasoningEffort('newer', 'high')
    await Promise.all([first, second])

    expect(store.sessions[0].reasoningEffort).toBe('high')
  })
})
