// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  respondAuthorization: vi.fn(),
  socketEmit: vi.fn(),
}))

const sessionsApi = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  respondAuthorization: chatApi.respondAuthorization,
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
  deleteSession: sessionsApi.deleteSession,
  fetchSessionMessagesPage: sessionsApi.fetchSessionMessagesPage,
  fetchSessions: sessionsApi.fetchSessions,
  setSessionModel: sessionsApi.setSessionModel,
  fetchWorkspaceRunChanges: vi.fn(() => Promise.resolve([])),
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
import { formatAuthorizationRemaining } from '@/utils/hermes/authorization-countdown'
import type { RunEvent } from '@/api/hermes/chat'

const REQUIRED = {
  event: 'authorization.required',
  session_id: 'session-1',
  run_id: 'run-1',
  authorization_id: 'auth-1',
  service: 'lark-cli',
  scopes: ['im:message'],
  expires_at: 1780000000,
  state: 'pending',
} as unknown as RunEvent

describe('inline authorization countdown formatter', () => {
  // Live-stack regression: the broker's expires_at is epoch seconds but is not
  // guaranteed to be an integer, and the raw float tail reached the screen as
  // `剩余 8m 33.942726850509644s`.
  it('renders whole seconds when the deadline is fractional', () => {
    const now = 1_780_000_000
    expect(formatAuthorizationRemaining(now + 573.942726850509644, now)).toBe('9m 33s')
    expect(formatAuthorizationRemaining(now + 33.942726850509644, now)).toBe('33s')
    expect(formatAuthorizationRemaining(now + 60.9, now)).toBe('1m 00s')
    expect(formatAuthorizationRemaining(now + 604.2, now)).toBe('10m 04s')
  })

  it('never renders a fractional tail for any sub-second offset', () => {
    const now = 1_780_000_000
    for (const fraction of [0.001, 0.25, 0.5, 0.749, 0.999]) {
      const text = formatAuthorizationRemaining(now + 125 + fraction, now)
      expect(text).toBe('2m 05s')
      expect(text).not.toContain('.')
    }
  })

  it('clamps a past deadline to zero instead of going negative', () => {
    const now = 1_780_000_000
    expect(formatAuthorizationRemaining(now - 1, now)).toBe('0s')
    expect(formatAuthorizationRemaining(now - 4321.87, now)).toBe('0s')
    expect(formatAuthorizationRemaining(now, now)).toBe('0s')
  })

  it('renders nothing rather than NaN when there is no usable deadline', () => {
    const now = 1_780_000_000
    for (const bad of [undefined, null, 0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const text = formatAuthorizationRemaining(bad as number | undefined | null, now)
      expect(text).toBe('')
      expect(text).not.toContain('NaN')
    }
    expect(formatAuthorizationRemaining(now + 90, Number.NaN)).not.toContain('NaN')
  })
})

function makeSession(id = 'session-1'): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function bootStore() {
  const store = useChatStore()
  const session = makeSession()
  store.sessions = [session]
  store.activeSessionId = 'session-1'
  store.activeSession = session
  return store
}

describe('chat store — inline authorization card', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue(null)
    sessionsApi.fetchSessions.mockResolvedValue([])
    sessionsApi.setSessionModel.mockResolvedValue({ ok: true, familySwitchNotice: false })
  })

  it('sets the pending card, keyed by authorization_id, and resolves it in place rather than deleting it', () => {
    const store = bootStore()

    store.setPendingAuthorization(REQUIRED)
    expect(store.activePendingAuthorization).toEqual({
      sessionId: 'session-1',
      authorizationId: 'auth-1',
      service: 'lark-cli',
      scopes: ['im:message'],
      expiresAt: 1780000000,
      state: 'pending',
      verificationUri: undefined,
      submitting: false,
      error: undefined,
      serverTerminal: false,
    })

    // A resolution for a DIFFERENT request must not touch this card.
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-9', state: 'success',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'pending', serverTerminal: false,
    }))

    // A real success must still SHOW 已授权 — the card stays, marked
    // server-resolved, instead of vanishing (codex finding
    // terminal-state-discarded).
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'success',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'success', serverTerminal: true,
    }))
  })

  it('keeps a resolved card in place with its terminal state and reason, and a later `authorization.required` replay for the same id cannot revert it', () => {
    const store = bootStore()

    store.setPendingAuthorization(REQUIRED)
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'success',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'success', serverTerminal: true,
    }))

    store.setPendingAuthorization({ ...REQUIRED, authorization_id: 'auth-2' } as unknown as RunEvent)
    store.clearPendingAuthorization({
      event: 'authorization.resolved',
      session_id: 'session-1',
      authorization_id: 'auth-2',
      state: 'failed',
      reason: 'scope_denied',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-2', state: 'failed', serverTerminal: true, error: 'scope_denied',
    }))

    // A later replay of the SAME id (F5 resume, reconnect dedup) must not
    // revert the terminal state the server already confirmed.
    store.setPendingAuthorization({ ...REQUIRED, authorization_id: 'auth-2' } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-2', state: 'failed', serverTerminal: true,
    }))
  })

  it('stores the broker verification URL and a terminal failure without clearing the card', () => {
    const store = bootStore()
    store.setPendingAuthorization(REQUIRED)

    store.applyAuthorizationUrl({
      event: 'authorization.url',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      verification_uri: 'https://broker.invalid/device/AB12',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      verificationUri: 'https://broker.invalid/device/AB12',
      state: 'authorizing',
      submitting: false,
    }))

    store.applyAuthorizationFailure({
      event: 'authorization.failed',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      error: 'Run broker authorization 404',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      state: 'failed',
      error: 'Run broker authorization 404',
    }))
  })

  it('resolves the card in place — never deletes it — on a terminal cancelled or expired resolution', () => {
    const store = bootStore()

    store.setPendingAuthorization(REQUIRED)
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'cancelled',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'cancelled', serverTerminal: true,
    }))

    // A fresh authorization_id gets its own fresh 'pending' card.
    store.setPendingAuthorization({ ...REQUIRED, authorization_id: 'auth-2' } as unknown as RunEvent)
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-2', state: 'expired',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-2', state: 'expired', serverTerminal: true,
    }))
  })

  it('delivers the card through the switchSession resume replay (F5 path)', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: false,
        events: [{ id: 'evt-1', event: 'authorization.required', data: { ...REQUIRED, session_id: undefined } }],
      })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession()]

    await store.switchSession('session-1')

    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      authorizationId: 'auth-1',
      state: 'pending',
    }))
  })

  it('delivers the card through the live run stream', async () => {
    const store = bootStore()
    await store.sendMessage('open my lark drive')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' } as RunEvent)
    onEvent(REQUIRED)

    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({ authorizationId: 'auth-1' }))

    onEvent({
      event: 'authorization.url',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      verification_uri: 'https://broker.invalid/device/AB12',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization?.verificationUri).toBe('https://broker.invalid/device/AB12')

    onEvent({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'success',
    } as unknown as RunEvent)
    // The card stays, terminal, instead of disappearing.
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'success', serverTerminal: true,
    }))
  })

  it('delivers the card through the in-run reconnect replay', async () => {
    const store = bootStore()
    await store.sendMessage('open my lark drive')

    const options = chatApi.startRunViaSocket.mock.calls[0][5] as {
      onReconnectResume: (data: any) => unknown
    }
    expect(options?.onReconnectResume).toBeTypeOf('function')

    await options.onReconnectResume({
      session_id: 'session-1',
      messages: [],
      isWorking: true,
      events: [{ id: 'evt-1', event: 'authorization.required', data: { ...REQUIRED, session_id: undefined } }],
    })

    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({ authorizationId: 'auth-1' }))
  })

  // Regression for codex finding authorization-replay-ignored:
  // `applyAttachedReconnectResume` — the reconnect path for an ALREADY-OPEN
  // (attached, server-working) session — used to silently drop every
  // authorization.* event in its replay loop, so reconnecting after
  // disconnecting before the card arrived left no card at all.
  it('replays authorization.required and authorization.resolved through the attached-session reconnect snapshot', async () => {
    let capturedOptions: { onReconnectResume: (data: any) => unknown } | undefined
    chatApi.registerSessionHandlers.mockImplementation((_sid: string, _handlers: any, options: any) => {
      capturedOptions = options
      return vi.fn()
    })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession()]

    await store.switchSession('session-1')
    expect(capturedOptions?.onReconnectResume).toBeTypeOf('function')

    await capturedOptions!.onReconnectResume({
      session_id: 'session-1',
      messages: [],
      isWorking: true,
      events: [{ id: 'evt-1', event: 'authorization.required', data: { ...REQUIRED, session_id: undefined } }],
    })
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'pending',
    }))

    await capturedOptions!.onReconnectResume({
      session_id: 'session-1',
      messages: [],
      isWorking: true,
      events: [{
        id: 'evt-2',
        data: { event: 'authorization.resolved', session_id: undefined, authorization_id: 'auth-1', state: 'success' },
      }],
    })
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'success', serverTerminal: true,
    }))
  })

  it('delivers the card through the resumed server-working run handlers', async () => {
    let captured: any
    chatApi.registerSessionHandlers.mockImplementation((_sid: string, handlers: any) => {
      captured = handlers
      return vi.fn()
    })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession()]

    await store.switchSession('session-1')
    expect(captured?.onAuthorizationRequired).toBeTypeOf('function')

    captured.onAuthorizationRequired(REQUIRED)
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({ authorizationId: 'auth-1' }))

    captured.onAuthorizationFailed({
      event: 'authorization.failed',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      error: 'Run broker authorization 409',
    })
    expect(store.activePendingAuthorization?.state).toBe('failed')
    // Local-only failure (authorization.failed) — the server has not spoken
    // yet, so this is not `serverTerminal`.
    expect(store.activePendingAuthorization?.serverTerminal).toBeFalsy()

    captured.onAuthorizationResolved({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'failed',
    })
    // The server's own resolution keeps the card, now marked serverTerminal,
    // with the reason from the earlier local failure preserved.
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1',
      state: 'failed',
      serverTerminal: true,
      error: 'Run broker authorization 409',
    }))
  })

  it('emits the right socket payload for each action', () => {
    const store = bootStore()
    store.setPendingAuthorization(REQUIRED)

    store.respondToAuthorization('authorize')
    expect(chatApi.respondAuthorization).toHaveBeenLastCalledWith('session-1', 'auth-1', 'authorize', 'chat-run')
    expect(store.activePendingAuthorization?.submitting).toBe(true)

    // A second authorize while the first is in flight must not double-fire.
    store.respondToAuthorization('authorize')
    expect(chatApi.respondAuthorization).toHaveBeenCalledTimes(1)

    store.respondToAuthorization('confirm')
    expect(chatApi.respondAuthorization).toHaveBeenLastCalledWith('session-1', 'auth-1', 'confirm', 'chat-run')

    store.respondToAuthorization('cancel')
    expect(chatApi.respondAuthorization).toHaveBeenLastCalledWith('session-1', 'auth-1', 'cancel', 'chat-run')
    expect(store.activePendingAuthorization?.state).toBe('cancelled')
  })

  it('never emits credential.replay from the authorization path', () => {
    const store = bootStore()
    store.setPendingAuthorization(REQUIRED)

    store.respondToAuthorization('authorize')
    store.applyAuthorizationUrl({
      event: 'authorization.url',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      verification_uri: 'https://broker.invalid/device/AB12',
    } as unknown as RunEvent)
    store.respondToAuthorization('confirm')
    store.respondToAuthorization('cancel')
    store.clearPendingAuthorization({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'cancelled',
    } as unknown as RunEvent)

    const emittedEvents = chatApi.socketEmit.mock.calls.map(call => call[0])
    expect(emittedEvents).not.toContain('credential.replay')
    // The reauth card is a different feature entirely — this path must not touch it.
    expect(store.activePendingReauth).toBeNull()
  })

  it('drops the card when the session interactions are cleared by an abort', async () => {
    const store = bootStore()
    await store.sendMessage('open my lark drive')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void

    onEvent({ event: 'run.started', session_id: 'session-1' } as RunEvent)
    onEvent(REQUIRED)
    expect(store.pendingAuthorizations.size).toBe(1)

    onEvent({ event: 'abort.completed', session_id: 'session-1', synced: true } as unknown as RunEvent)
    expect(store.pendingAuthorizations.size).toBe(0)
    expect(store.activePendingAuthorization).toBeNull()
  })

  it('cancels a pending authorization on the broker before aborting the run', async () => {
    const store = bootStore()
    const abort = vi.fn()
    chatApi.startRunViaSocket.mockReturnValue({ abort })
    await store.sendMessage('open my lark drive')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void

    onEvent({ event: 'run.started', session_id: 'session-1' } as RunEvent)
    onEvent(REQUIRED)
    expect(store.activePendingAuthorization?.authorizationId).toBe('auth-1')

    let cancelOrder = -1
    let abortOrder = -1
    let order = 0
    chatApi.respondAuthorization.mockImplementation(() => { cancelOrder = order++ })
    abort.mockImplementation(() => { abortOrder = order++ })

    store.stopStreaming()

    expect(chatApi.respondAuthorization).toHaveBeenCalledTimes(1)
    expect(chatApi.respondAuthorization).toHaveBeenLastCalledWith('session-1', 'auth-1', 'cancel', 'chat-run')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(cancelOrder).toBeGreaterThanOrEqual(0)
    expect(abortOrder).toBeGreaterThan(cancelOrder)

    // The card is not optimistically dropped here — it waits for the
    // server's `authorization.resolved` echo, same as everywhere else.
    expect(store.pendingAuthorizations.get('session-1')?.authorizationId).toBe('auth-1')

    onEvent({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'cancelled',
    } as unknown as RunEvent)
    // The echo resolves the card in place instead of deleting it.
    expect(store.activePendingAuthorization).toEqual(expect.objectContaining({
      authorizationId: 'auth-1', state: 'cancelled', serverTerminal: true,
    }))
  })

  it('emits no cancel on stop when there is no pending authorization card', async () => {
    const store = bootStore()
    const abort = vi.fn()
    chatApi.startRunViaSocket.mockReturnValue({ abort })
    await store.sendMessage('open my lark drive')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' } as RunEvent)

    expect(store.activePendingAuthorization).toBeNull()
    store.stopStreaming()

    expect(chatApi.respondAuthorization).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  // Regression for codex finding authorization-not-invalidated: a LOCAL-only
  // terminal state (authorization.failed — the broker answered 404/409, or
  // the handshake blew up) must NOT skip the server cancel on Stop. The
  // broker's own pending entry may still be live, and a later provider
  // callback could still authorize and resume it. The cancel route is
  // idempotent, so sending it here is always safe.
  it('still cancels on stop when the local terminal state came only from authorization.failed, not a server resolution', async () => {
    const store = bootStore()
    const abort = vi.fn()
    chatApi.startRunViaSocket.mockReturnValue({ abort })
    await store.sendMessage('open my lark drive')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void

    onEvent({ event: 'run.started', session_id: 'session-1' } as RunEvent)
    onEvent(REQUIRED)
    onEvent({
      event: 'authorization.failed',
      session_id: 'session-1',
      authorization_id: 'auth-1',
      error: 'Run broker authorization 409',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization?.state).toBe('failed')
    expect(store.activePendingAuthorization?.serverTerminal).toBeFalsy()

    store.stopStreaming()

    // Exactly one cancel, still sent before the card is allowed to go away.
    expect(chatApi.respondAuthorization).toHaveBeenCalledTimes(1)
    expect(chatApi.respondAuthorization).toHaveBeenLastCalledWith('session-1', 'auth-1', 'cancel', 'chat-run')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(store.pendingAuthorizations.get('session-1')?.authorizationId).toBe('auth-1')
  })

  it('emits no cancel on stop once the server itself has already resolved the card', async () => {
    const store = bootStore()
    const abort = vi.fn()
    chatApi.startRunViaSocket.mockReturnValue({ abort })
    await store.sendMessage('open my lark drive')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void

    onEvent({ event: 'run.started', session_id: 'session-1' } as RunEvent)
    onEvent(REQUIRED)
    onEvent({
      event: 'authorization.resolved', session_id: 'session-1', authorization_id: 'auth-1', state: 'cancelled',
    } as unknown as RunEvent)
    expect(store.activePendingAuthorization?.serverTerminal).toBe(true)

    store.stopStreaming()

    expect(chatApi.respondAuthorization).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    // Nothing left to wait for — a server-resolved card clears immediately,
    // same as the other pending cards.
    expect(store.pendingAuthorizations.has('session-1')).toBe(false)
  })
})
