import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sockets: [] as any[],
}))

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
      connected: true,
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
      }),
      __listenerCount: (event: string) => listeners.get(event)?.size || 0,
      __trigger: (event: string, ...args: any[]) => {
        if (event === 'connect') socket.connected = true
        if (event === 'disconnect') socket.connected = false
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      },
    }

    return socket
  }

  return {
    io: vi.fn(() => {
      const socket = createSocket()
      socketState.sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('../../packages/client/src/api/client', () => ({
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => '',
}))

describe('chat-run socket reconnect handling', () => {
  beforeEach(() => {
    vi.resetModules()
    socketState.sockets = []
  })

  it('keeps transient mobile disconnects alive and resumes after reconnect', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onReconnectResume = vi.fn()

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
    expect(onReconnectResume).toHaveBeenCalledWith(resumed)

    socket.__trigger('message.delta', { event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onEvent).toHaveBeenCalledWith({ event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onDone).not.toHaveBeenCalled()
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
