import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sockets: [] as any[],
  nextConnected: true,
  nextActive: true,
}))
const profileState = vi.hoisted(() => ({ activeProfileName: 'default' }))

vi.mock('socket.io-client', () => {
  function createSocket() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>()

    const addListener = (event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }

    const removeListener = (event: string, handler: (...args: any[]) => void) => {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return
      for (const candidate of [...eventListeners]) {
        if (candidate === handler || (candidate as any).__original === handler) {
          eventListeners.delete(candidate)
        }
      }
    }

    const socket: any = {
      connected: socketState.nextConnected,
      active: socketState.nextActive,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        addListener(event, handler)
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const wrapped = (...args: any[]) => {
          removeListener(event, wrapped)
          handler(...args)
        }
        ;(wrapped as any).__original = handler
        addListener(event, wrapped)
        return socket
      }),
      off: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeAllListeners: vi.fn(() => {
        listeners.clear()
        return socket
      }),
      emit: vi.fn(),
      disconnect: vi.fn(() => {
        socket.connected = false
        socket.active = false
      }),
      __listenerCount: (event: string) => listeners.get(event)?.size || 0,
      __trigger: (event: string, ...args: any[]) => {
        if (event === 'connect') {
          socket.connected = true
          socket.active = true
        }
        if (event === 'disconnect') {
          socket.connected = false
          socket.active = args[0] === 'ping timeout' || args[0] === 'transport close' || args[0] === 'transport error'
        }
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      },
    }

    return socket
  }

  return {
    io: vi.fn((url?: string, options?: any) => {
      const socket = createSocket()
      socket.__url = url
      socket.__options = options
      socketState.sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profileState,
}))

vi.mock('../../packages/client/src/api/client', () => ({
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => '',
}))

describe('chat-run socket reconnect handling', () => {
  beforeEach(() => {
    vi.resetModules()
    socketState.sockets = []
    socketState.nextConnected = true
    socketState.nextActive = true
    profileState.activeProfileName = 'default'
  })

  it('keeps transient mobile disconnects alive and resumes after reconnect', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onReconnectResume = vi.fn(() => true)

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      onError,
      undefined,
      { onReconnectResume },
    )

    const socket = socketState.sockets[0]
    expect(socket.emit).toHaveBeenCalledWith('run', expect.objectContaining({ session_id: 'session-1' }))

    socket.__trigger('disconnect', 'ping timeout')
    expect(onError).not.toHaveBeenCalled()

    socket.__trigger('connect_error', new Error('temporary reconnect failure'))
    expect(onError).not.toHaveBeenCalled()

    socket.__trigger('connect')
    expect(socket.emit).toHaveBeenCalledWith('resume', { session_id: 'session-1', profile: 'default' })

    const resumed = { session_id: 'session-1', messages: [], isWorking: true, events: [] }
    socket.__trigger('resumed', resumed)
    await vi.waitFor(() => expect(onReconnectResume).toHaveBeenCalledWith(resumed))

    socket.__trigger('message.delta', { event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onEvent).toHaveBeenCalledWith({ event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('fails a reconnecting run when Socket.IO will not retry the connect error', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onError = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      vi.fn(),
      vi.fn(),
      onError,
    )

    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'transport close')
    socket.active = false
    socket.__trigger('connect_error', new Error('fatal reconnect failure'))

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'fatal reconnect failure' }))
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
  })

  it('fails an attached owner when its initial inactive socket cannot reconnect', async () => {
    socketState.nextConnected = false
    socketState.nextActive = false
    const { registerSessionHandlers } = await import('../../packages/client/src/api/hermes/chat')
    const onError = vi.fn()

    registerSessionHandlers('attached-session', { onMessageDelta: vi.fn() } as any, {
      profile: 'default',
      onReconnectResume: vi.fn(() => true),
      onDone: vi.fn(),
      onError,
    })
    const socket = socketState.sockets[0]
    socket.__trigger('connect_error', new Error('initial connection rejected'))

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'initial connection rejected' }))
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
  })

  it('reuses the reconnecting socket when another resume is requested while offline', async () => {
    const { resumeSession, startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const runEvent = vi.fn()
    const reconnectResume = vi.fn(() => true)
    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      runEvent,
      vi.fn(),
      vi.fn(),
      undefined,
      { onReconnectResume: reconnectResume },
    )
    const socket = socketState.sockets[0]

    socket.__trigger('disconnect', 'ping timeout')
    const explicitResume = vi.fn(() => true)
    resumeSession('session-1', explicitResume, 'default')

    expect(socketState.sockets).toHaveLength(1)
    expect(socket.disconnect).not.toHaveBeenCalled()

    socket.__trigger('connect')
    const resumed = { session_id: 'session-1', messages: [], isWorking: true, events: [] }
    socket.__trigger('resumed', resumed)
    await vi.waitFor(() => expect(reconnectResume).toHaveBeenCalledWith(resumed))
    await vi.waitFor(() => expect(explicitResume).toHaveBeenCalledWith(resumed))

    const delta = { event: 'message.delta', session_id: 'session-1', delta: 'still owned' }
    socket.__trigger('message.delta', delta)
    expect(runEvent).toHaveBeenCalledWith(delta)
  })

  it('resumes an attached owner registered after the socket already disconnected', async () => {
    const { connectChatRun, registerSessionHandlers } = await import('../../packages/client/src/api/hermes/chat')
    const socket = connectChatRun('default') as any
    socket.__trigger('disconnect', 'ping timeout')
    const onError = vi.fn()

    registerSessionHandlers('attached-session', { onMessageDelta: vi.fn() } as any, {
      profile: 'default',
      onReconnectResume: vi.fn(() => true),
      onDone: vi.fn(),
      onError,
    })

    expect(socketState.sockets).toHaveLength(1)
    socket.__trigger('connect_error', new Error('temporary reconnect failure'))
    expect(onError).not.toHaveBeenCalled()
    socket.__trigger('connect')
    expect(socket.emit).toHaveBeenCalledWith('resume', {
      session_id: 'attached-session',
      profile: 'default',
    })
  })

  it('retires an idle reconnect owner before the next run for that session', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const firstEvent = vi.fn()
    const firstDone = vi.fn()
    const firstError = vi.fn()
    const onReconnectResume = vi.fn(() => true)

    startRunViaSocket(
      { session_id: 'session-1', queue_id: 'owner-1', input: 'first', profile: 'default', source: 'cli' },
      firstEvent,
      firstDone,
      firstError,
      undefined,
      { onReconnectResume },
    )
    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'ping timeout')
    socket.__trigger('connect')
    const resumed = {
      session_id: 'session-1',
      messages: [],
      isWorking: false,
      queueLength: 0,
      events: [{
        id: 'terminal-1',
        event: 'run.failed',
        data: { event: 'run.failed', session_id: 'session-1', error: 'offline failure' },
      }],
    }
    socket.__trigger('resumed', resumed)

    await vi.waitFor(() => expect(onReconnectResume).toHaveBeenCalledWith(resumed))
    await vi.waitFor(() => expect(firstDone).toHaveBeenCalledOnce())
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-1',
      event_ids: ['terminal-1'],
    })
    expect(firstError).not.toHaveBeenCalled()
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
    expect(socket.__listenerCount('resumed')).toBe(0)

    const secondEvent = vi.fn()
    const secondDone = vi.fn()
    startRunViaSocket(
      { session_id: 'session-1', queue_id: 'owner-2', input: 'second', profile: 'default', source: 'cli' },
      secondEvent,
      secondDone,
      vi.fn(),
    )
    socket.__trigger('run.rejected', {
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: 'owner-2',
      error: 'rejected',
    })

    expect(secondEvent).toHaveBeenCalledWith(expect.objectContaining({ queue_id: 'owner-2' }))
    expect(secondDone).toHaveBeenCalledOnce()
    expect(firstDone).toHaveBeenCalledOnce()
  })

  it('does not let a stale reconnect callback retire a replacement owner', async () => {
    const { startRunViaSocket, unregisterSessionHandlers } = await import('../../packages/client/src/api/hermes/chat')
    let releaseResume!: () => void
    const resumeGate = new Promise<void>(resolve => { releaseResume = resolve })
    const firstDone = vi.fn()
    const firstResume = vi.fn(async () => {
      await resumeGate
      return ['old-terminal']
    })

    startRunViaSocket(
      { session_id: 'session-1', queue_id: 'owner-1', input: 'first', profile: 'default', source: 'cli' },
      vi.fn(),
      firstDone,
      vi.fn(),
      undefined,
      { onReconnectResume: firstResume },
    )
    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'ping timeout')
    socket.__trigger('connect')
    socket.__trigger('resumed', {
      session_id: 'session-1',
      messages: [],
      isWorking: false,
      queueLength: 0,
      events: [{
        id: 'old-terminal',
        event: 'run.failed',
        data: { event: 'run.failed', session_id: 'session-1', error: 'old failure' },
      }],
    })
    await vi.waitFor(() => expect(firstResume).toHaveBeenCalledOnce())

    unregisterSessionHandlers('session-1')
    const replacementEvent = vi.fn()
    const replacementDone = vi.fn()
    startRunViaSocket(
      { session_id: 'session-1', queue_id: 'owner-2', input: 'replacement', profile: 'default', source: 'cli' },
      replacementEvent,
      replacementDone,
      vi.fn(),
    )
    releaseResume()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(firstDone).not.toHaveBeenCalled()
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: 'session-1',
      delta: 'replacement output',
    })
    expect(replacementEvent).toHaveBeenCalledWith(expect.objectContaining({ delta: 'replacement output' }))
    expect(replacementDone).not.toHaveBeenCalled()
  })

  it('retires old session owners when the socket profile changes', async () => {
    const { connectChatRun, startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const profileAEvent = vi.fn()
    const profileAError = vi.fn()
    startRunViaSocket(
      { session_id: 'shared-session', queue_id: 'profile-a', input: 'first', profile: 'profile-a', source: 'cli' },
      profileAEvent,
      vi.fn(),
      profileAError,
    )
    const profileASocket = socketState.sockets[0]

    connectChatRun('profile-b')
    const profileBSocket = socketState.sockets[1]
    const profileBEvent = vi.fn()
    startRunViaSocket(
      { session_id: 'shared-session', queue_id: 'profile-b', input: 'second', profile: 'profile-b', source: 'cli' },
      profileBEvent,
      vi.fn(),
      vi.fn(),
    )

    expect(profileASocket.disconnect).toHaveBeenCalledOnce()
    expect(profileAError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Chat connection changed before the run finished',
    }))
    profileASocket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: 'shared-session',
      delta: 'stale profile output',
    })
    profileBSocket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: 'shared-session',
      delta: 'current profile output',
    })
    expect(profileAEvent).not.toHaveBeenCalled()
    expect(profileBEvent).toHaveBeenCalledWith(expect.objectContaining({ delta: 'current profile output' }))
  })

  it('retires the old owner when an implicit active profile change makes the socket stale', async () => {
    profileState.activeProfileName = 'profile-a'
    const { connectChatRun, startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const profileAError = vi.fn()
    startRunViaSocket(
      { session_id: 'shared-session', queue_id: 'profile-a', input: 'first', profile: 'profile-a', source: 'cli' },
      vi.fn(),
      vi.fn(),
      profileAError,
    )
    const profileASocket = socketState.sockets[0]

    profileState.activeProfileName = 'profile-b'
    const profileBSocket = connectChatRun() as any

    expect(profileBSocket).not.toBe(profileASocket)
    expect(profileASocket.disconnect).toHaveBeenCalledOnce()
    expect(profileAError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Chat connection changed before the run finished',
    }))
    expect(profileBSocket.__options.query).toEqual({ profile: 'profile-b' })
  })

  it('does not acknowledge a live terminal event until its handler succeeds', async () => {
    const {
      connectChatRun,
      registerSessionHandlers,
      resumeSession,
      unregisterSessionHandlers,
    } = await import('../../packages/client/src/api/hermes/chat')
    const socket = connectChatRun('default') as any
    registerSessionHandlers('session-1', {
      onRunFailed: () => { throw new Error('store apply failed') },
    } as any)

    expect(() => socket.__trigger('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      resume_event_id: 'terminal-retry',
      error: 'durable failure',
    })).toThrow('store apply failed')
    expect(socket.emit).not.toHaveBeenCalledWith('resume.events.ack', expect.objectContaining({
      event_ids: ['terminal-retry'],
    }))

    unregisterSessionHandlers('session-1')
    const replay = vi.fn(() => ['terminal-retry'])
    resumeSession('session-1', replay, 'default')
    socket.__trigger('resumed', {
      session_id: 'session-1',
      messages: [],
      isWorking: false,
      events: [{
        id: 'terminal-retry',
        event: 'run.failed',
        data: { event: 'run.failed', session_id: 'session-1', error: 'durable failure' },
      }],
    })

    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(expect.objectContaining({
      events: [expect.objectContaining({ id: 'terminal-retry' })],
    })))
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-1',
      event_ids: ['terminal-retry'],
    }))
  })

  it('keeps concurrent reconnect resumes scoped until each session responds', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const resumedA = vi.fn()
    const resumedB = vi.fn()
    startRunViaSocket(
      { session_id: 'session-a', input: 'a', profile: 'default', source: 'cli' },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      undefined,
      { onReconnectResume: resumedA },
    )
    startRunViaSocket(
      { session_id: 'session-b', input: 'b', profile: 'default', source: 'cli' },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      undefined,
      { onReconnectResume: resumedB },
    )

    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'ping timeout')
    socket.__trigger('connect')
    const payloadA = { session_id: 'session-a', messages: [], isWorking: true, events: [] }
    const payloadB = { session_id: 'session-b', messages: [], isWorking: true, events: [] }
    socket.__trigger('resumed', payloadA)
    socket.__trigger('resumed', payloadB)

    await vi.waitFor(() => expect(resumedA).toHaveBeenCalledOnce())
    expect(resumedA).toHaveBeenCalledWith(payloadA)
    await vi.waitFor(() => expect(resumedB).toHaveBeenCalledOnce())
    expect(resumedB).toHaveBeenCalledWith(payloadB)
  })

  it('keeps concurrent resume callbacks scoped to their requested session', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/hermes/chat')
    const onSessionA = vi.fn()
    const onSessionB = vi.fn()

    resumeSession('session-a', onSessionA, 'default')
    resumeSession('session-b', onSessionB, 'default')

    const socket = socketState.sockets[0]
    const resumedB = { session_id: 'session-b', messages: [], isWorking: false, events: [] }
    socket.__trigger('resumed', resumedB)

    expect(onSessionA).not.toHaveBeenCalled()
    expect(onSessionB).toHaveBeenCalledWith(resumedB)
    expect(socket.__listenerCount('resumed')).toBe(1)

    const resumedA = { session_id: 'session-a', messages: [], isWorking: false, events: [] }
    socket.__trigger('resumed', resumedA)

    expect(onSessionA).toHaveBeenCalledWith(resumedA)
    expect(socket.__listenerCount('resumed')).toBe(0)
  })

  it('resumes an attached run after each transient reconnect and retires it when idle', async () => {
    const { registerSessionHandlers } = await import('../../packages/client/src/api/hermes/chat')
    const onReconnectResume = vi.fn((data: any) => data.events.map((event: any) => event.id))
    const onDone = vi.fn()
    const onError = vi.fn()

    registerSessionHandlers('attached-session', { onMessageDelta: vi.fn() } as any, {
      profile: 'default',
      onReconnectResume,
      onDone,
      onError,
    })
    const socket = socketState.sockets[0]

    socket.__trigger('disconnect', 'ping timeout')
    socket.__trigger('connect')
    socket.__trigger('resumed', {
      session_id: 'attached-session',
      messages: [],
      isWorking: true,
      events: [{
        id: 'attached-terminal',
        event: 'run.failed',
        data: { event: 'run.failed', session_id: 'attached-session', error: 'previous run failed' },
      }],
    })

    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'attached-session',
      event_ids: ['attached-terminal'],
    }))
    expect(onDone).not.toHaveBeenCalled()

    socket.__trigger('disconnect', 'transport close')
    socket.__trigger('connect')
    socket.__trigger('resumed', {
      session_id: 'attached-session',
      messages: [],
      isWorking: false,
      queueLength: 0,
      events: [],
    })

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(onError).not.toHaveBeenCalled()
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
    expect(socket.__listenerCount('resumed')).toBe(0)
  })

  it('releases resume event reservations only after the owning callback settles', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/hermes/chat')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = vi.fn(async () => {
      await gate
      return ['shared-event']
    })
    const second = vi.fn(() => true)
    const payload = {
      session_id: 'session-a',
      messages: [],
      isWorking: false,
      events: [{ id: 'shared-event', event: 'run.failed', data: { event: 'run.failed' } }],
    }

    resumeSession('session-a', first, 'default')
    const socket = socketState.sockets[0]
    socket.__trigger('resumed', payload)
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())

    resumeSession('session-a', second, 'default')
    socket.__trigger('resumed', payload)
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(expect.objectContaining({ events: [] })))
    expect(socket.emit).not.toHaveBeenCalledWith('resume.events.ack', expect.objectContaining({
      event_ids: ['shared-event'],
    }))

    release()
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['shared-event'],
    }))
  })

  it('acknowledges only the exact resume event ids returned by the callback', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/hermes/chat')
    const socketPayload = {
      session_id: 'session-a',
      messages: [],
      isWorking: false,
      events: [
        { id: 'known-event', event: 'run.failed', data: { event: 'run.failed' } },
        { id: 'unknown-event', event: 'future.event', data: { event: 'future.event' } },
      ],
    }

    resumeSession('session-a', () => ['known-event'], 'default')
    const socket = socketState.sockets[0]
    socket.__trigger('resumed', socketPayload)
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['known-event'],
    }))
    expect(socket.emit).not.toHaveBeenCalledWith('resume.events.ack', expect.objectContaining({
      event_ids: expect.arrayContaining(['unknown-event']),
    }))

    const replay = vi.fn(() => [])
    resumeSession('session-a', replay, 'default')
    socket.__trigger('resumed', socketPayload)
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(expect.objectContaining({
      events: [expect.objectContaining({ id: 'unknown-event' })],
    })))
  })

  it('acknowledges pending resume events only after the callback consumes them', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/hermes/chat')
    resumeSession('session-a', () => false, 'default')
    resumeSession('session-b', () => true, 'default')
    const socket = socketState.sockets[0]

    socket.__trigger('resumed', {
      session_id: 'session-a',
      messages: [],
      isWorking: false,
      events: [{ id: 'event-a', event: 'run.failed', data: { event: 'run.failed' } }],
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(socket.emit).not.toHaveBeenCalledWith('resume.events.ack', expect.objectContaining({
      event_ids: ['event-a'],
    }))

    socket.__trigger('resumed', {
      session_id: 'session-b',
      messages: [],
      isWorking: false,
      events: [{ id: 'event-b', event: 'run.failed', data: { event: 'run.failed' } }],
    })
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-b',
      event_ids: ['event-b'],
    }))

    socket.emit.mockClear()
    const onDuplicate = vi.fn(() => true)
    resumeSession('session-b', onDuplicate, 'default')
    socket.__trigger('resumed', {
      session_id: 'session-b',
      messages: [],
      isWorking: false,
      events: [{ id: 'event-b', event: 'run.failed', data: { event: 'run.failed' } }],
    })

    await vi.waitFor(() => expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({
      events: [],
    })))
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-b',
      event_ids: ['event-b'],
    })
  })

  it('filters a resume replay after consuming the same stable live event id', async () => {
    const { resumeSession, startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    startRunViaSocket(
      { session_id: 'session-a', input: 'hello', profile: 'default', source: 'cli' },
      onEvent,
      vi.fn(),
      vi.fn(),
    )
    const socket = socketState.sockets[0]
    socket.__trigger('run.failed', {
      event: 'run.failed',
      session_id: 'session-a',
      error: 'same failure',
      resume_event_id: 'stable-terminal-id',
    })
    expect(onEvent).toHaveBeenCalledOnce()
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['stable-terminal-id'],
    })

    const replay = vi.fn(() => [])
    resumeSession('session-a', replay, 'default')
    socket.__trigger('resumed', {
      session_id: 'session-a',
      messages: [],
      isWorking: false,
      events: [{
        id: 'stable-terminal-id',
        event: 'run.failed',
        data: { event: 'run.failed', session_id: 'session-a', error: 'same failure' },
      }],
    })
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(expect.objectContaining({ events: [] })))
  })

  it('acknowledges a stable live reattach failure only after the session handler applies it', async () => {
    const { connectChatRun, registerSessionHandlers } = await import('../../packages/client/src/api/hermes/chat')
    const onAgentEvent = vi.fn()
    const socket = connectChatRun('default') as any
    registerSessionHandlers('session-a', { onAgentEvent } as any)

    const failure = {
      event: 'run.reattach_failed',
      session_id: 'session-a',
      run_id: 'parked-run',
      terminal: true,
      error: 'Broker unavailable',
      resume_event_id: 'stable-reattach-id',
    }
    socket.__trigger('run.reattach_failed', failure)

    expect(onAgentEvent).toHaveBeenCalledWith(failure)
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['stable-reattach-id'],
    })
  })

  it('applies and acknowledges a stable live auth card only once', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    startRunViaSocket(
      { session_id: 'session-a', input: 'needs auth', profile: 'default', source: 'cli' },
      onEvent,
      vi.fn(),
      vi.fn(),
    )
    const socket = socketState.sockets[0]
    const authRequired = {
      event: 'auth.required',
      session_id: 'session-a',
      run_id: 'parked-run',
      connector_id: 'connector-1',
      resume_event_id: 'stable-auth-id',
    }

    socket.__trigger('auth.required', authRequired)
    socket.__trigger('auth.required', authRequired)

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(authRequired)
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['stable-auth-id'],
    })
  })

  it('applies and acknowledges a stable live auth resolution only once', async () => {
    const { connectChatRun, onAuthResolved } = await import('../../packages/client/src/api/hermes/chat')
    const onResolved = vi.fn()
    onAuthResolved(onResolved)
    const socket = connectChatRun('default') as any
    const resolved = {
      event: 'auth.resolved',
      session_id: 'session-a',
      run_id: 'parked-run',
      session_row_id: 11,
      session_incarnation: 22,
      resume_event_id: 'stable-auth-resolved-id',
    }

    socket.__trigger('auth.resolved', resolved)
    socket.__trigger('auth.resolved', resolved)

    expect(onResolved).toHaveBeenCalledOnce()
    expect(onResolved).toHaveBeenCalledWith(resolved)
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['stable-auth-resolved-id'],
    })
  })

  it('acknowledges successful terminal session commands live and after resume', async () => {
    const { resumeSession, startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    startRunViaSocket(
      { session_id: 'session-a', input: '/goal status', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      vi.fn(),
    )
    const socket = socketState.sockets[0]
    const liveCommand = {
      event: 'session.command',
      session_id: 'session-a',
      command: 'goal',
      action: 'status',
      terminal: true,
      message: 'Goal is active',
      resume_event_id: 'terminal-command-live',
    }

    socket.__trigger('session.command', liveCommand)
    socket.__trigger('session.command', liveCommand)

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(liveCommand)
    expect(onDone).toHaveBeenCalledOnce()
    expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-a',
      event_ids: ['terminal-command-live'],
    })

    const onResumed = vi.fn(() => ['terminal-command-resumed'])
    resumeSession('session-b', onResumed, 'default')
    socket.__trigger('resumed', {
      session_id: 'session-b',
      messages: [],
      isWorking: false,
      events: [{
        id: 'terminal-command-resumed',
        event: 'session.command',
        data: {
          event: 'session.command',
          session_id: 'session-b',
          command: 'goal',
          action: 'status',
          terminal: true,
          message: 'Goal is active',
        },
      }],
    })

    await vi.waitFor(() => expect(onResumed).toHaveBeenCalledWith(expect.objectContaining({
      events: [expect.objectContaining({ id: 'terminal-command-resumed', event: 'session.command' })],
    })))
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('resume.events.ack', {
      session_id: 'session-b',
      event_ids: ['terminal-command-resumed'],
    }))
  })

  it('keeps fatal disconnects fatal and removes per-run listeners', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onError = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      vi.fn(),
      vi.fn(),
      onError,
    )

    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'io server disconnect')

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toBe('Socket disconnected: io server disconnect')
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
  })

  it('does not attach extra reconnect listeners when the session already has handlers', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const body = { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' as const }

    startRunViaSocket(body, vi.fn(), vi.fn(), vi.fn())
    const socket = socketState.sockets[0]
    expect(socket.__listenerCount('connect')).toBe(1)
    expect(socket.__listenerCount('disconnect')).toBe(1)

    startRunViaSocket(body, vi.fn(), vi.fn(), vi.fn())
    expect(socket.__listenerCount('connect')).toBe(1)
    expect(socket.__listenerCount('disconnect')).toBe(1)
    expect(socket.emit).toHaveBeenCalledWith('run', body)
  })

  it('unregisters the old owner before recreating the same session id', async () => {
    const { startRunViaSocket, unregisterSessionHandlers } = await import('../../packages/client/src/api/hermes/chat')
    const firstEvent = vi.fn()
    startRunViaSocket(
      { session_id: 'session-1', input: 'first', profile: 'default', source: 'cli' },
      firstEvent,
      vi.fn(),
      vi.fn(),
    )
    const socket = socketState.sockets[0]

    unregisterSessionHandlers('session-1')
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)

    const secondEvent = vi.fn()
    startRunViaSocket(
      { session_id: 'session-1', input: 'second', profile: 'default', source: 'cli' },
      secondEvent,
      vi.fn(),
      vi.fn(),
    )
    const delta = { event: 'message.delta', session_id: 'session-1', delta: 'new owner only' }
    socket.__trigger('message.delta', delta)

    expect(firstEvent).not.toHaveBeenCalled()
    expect(secondEvent).toHaveBeenCalledWith(delta)
  })

  it('settles and removes the owning handler when the first request is rejected', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const body = {
      session_id: 'session-1',
      input: 'hello',
      queue_id: 'owner-request',
      profile: 'default',
      source: 'cli' as const,
    }

    startRunViaSocket(body, onEvent, onDone, vi.fn())
    const socket = socketState.sockets[0]
    const rejected = {
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: 'owner-request',
      error: 'identity failed',
    }
    socket.__trigger('run.rejected', rejected)

    expect(onEvent).toHaveBeenCalledWith(rejected)
    expect(onDone).toHaveBeenCalledOnce()
    expect(socket.__listenerCount('connect')).toBe(0)
    socket.__trigger('message.delta', { event: 'message.delta', session_id: 'session-1', delta: 'stale' })
    expect(onEvent).toHaveBeenCalledTimes(1)

    startRunViaSocket({ ...body, queue_id: 'retry' }, vi.fn(), vi.fn(), vi.fn())
    expect(socket.__listenerCount('connect')).toBe(1)
  })

  it('keeps the owning handler alive when only an active sibling follow-up is rejected', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const owner = {
      session_id: 'session-1',
      input: 'owner',
      queue_id: 'owner-request',
      profile: 'default',
      source: 'cli' as const,
    }

    startRunViaSocket(owner, onEvent, onDone, vi.fn())
    startRunViaSocket({ ...owner, input: 'follow-up', queue_id: 'follow-up' }, vi.fn(), vi.fn(), vi.fn())
    const socket = socketState.sockets[0]
    const rejected = {
      event: 'run.rejected',
      session_id: 'session-1',
      queue_id: 'follow-up',
      error: 'identity failed',
    }
    socket.__trigger('run.rejected', rejected)

    expect(onEvent).toHaveBeenCalledWith(rejected)
    expect(onDone).not.toHaveBeenCalled()
    expect(socket.__listenerCount('connect')).toBe(1)
    const delta = { event: 'message.delta', session_id: 'session-1', delta: 'owner continues' }
    socket.__trigger('message.delta', delta)
    expect(onEvent).toHaveBeenCalledWith(delta)
  })

  it('keeps handlers through a nonterminal goal continuation command', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'goal run', queue_id: 'owner', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      vi.fn(),
    )
    const socket = socketState.sockets[0]
    socket.__trigger('session.command', {
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'continue',
      terminal: false,
      started: true,
    })
    expect(onDone).not.toHaveBeenCalled()

    const delta = { event: 'message.delta', session_id: 'session-1', delta: 'continuation output' }
    socket.__trigger('message.delta', delta)
    expect(onEvent).toHaveBeenCalledWith(delta)
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: 'session-1',
      queue_remaining: 0,
    })
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('keeps handlers until the concrete failure following abort cleanup is delivered', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'abort', queue_id: 'owner', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      vi.fn(),
    )
    const socket = socketState.sockets[0]
    const completed = {
      event: 'abort.completed',
      session_id: 'session-1',
      queue_length: 0,
      failure_pending: true,
    }
    socket.__trigger('abort.completed', completed)

    expect(onEvent).toHaveBeenCalledWith(completed)
    expect(onDone).not.toHaveBeenCalled()
    const failed = {
      event: 'run.failed',
      session_id: 'session-1',
      queue_remaining: 0,
      error: 'Run finalization failed: stats failed',
    }
    socket.__trigger('run.failed', failed)
    expect(onEvent).toHaveBeenCalledWith(failed)
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('fans session.command events to run-local and global handlers', async () => {
    const { onSessionCommand, startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onGlobalCommand = vi.fn()
    const offGlobalCommand = onSessionCommand(onGlobalCommand)

    startRunViaSocket(
      { session_id: 'session-1', input: '/goal status', profile: 'default', source: 'cli' },
      onEvent,
      vi.fn(),
      vi.fn(),
    )

    const socket = socketState.sockets[0]
    const event = {
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'status',
      message: 'Goal (active, 0/20 turns): write site',
    }

    socket.__trigger('session.command', event)

    expect(onEvent).toHaveBeenCalledWith(event)
    expect(onGlobalCommand).toHaveBeenCalledWith(event)

    offGlobalCommand()
    socket.__trigger('session.command', { ...event, message: 'next status' })
    expect(onGlobalCommand).toHaveBeenCalledTimes(1)
  })

  it('forwards workspace diff completed events to the run handler', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'change files', profile: 'default', source: 'cli' },
      onEvent,
      vi.fn(),
      vi.fn(),
    )

    const socket = socketState.sockets[0]
    const event = {
      event: 'workspace.diff.completed',
      session_id: 'session-1',
      change_id: 'change-1',
      run_id: 'run-1',
      files_changed: 1,
      additions: 2,
      deletions: 1,
      files: [{ id: 7, path: 'src/app.ts', additions: 2, deletions: 1 }],
    }

    socket.__trigger('workspace.diff.completed', event)

    expect(onEvent).toHaveBeenCalledWith(event)
  })
})
