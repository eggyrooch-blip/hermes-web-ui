import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { ChatRunSocket } from '../../packages/server/src/services/hermes/chat-run-socket'

function createSocketServer() {
  const room = { emit: vi.fn() }
  const namespace = {
    use: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    to: vi.fn(() => room),
    emit: vi.fn(),
  }
  const io = {
    of: vi.fn(() => namespace),
  }
  return { io, namespace, room }
}

describe('ChatRunSocket gateway lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts a stopped request profile gateway before creating a run', async () => {
    const { io } = createSocketServer()
    const gatewayManager = {
      detectStatus: vi.fn()
        .mockResolvedValueOnce({
        profile: 'g41a5b5g',
        running: false,
        url: 'http://127.0.0.1:8654',
        })
        .mockResolvedValueOnce({
          profile: 'g41a5b5g',
          running: true,
          url: 'http://127.0.0.1:8654',
        }),
      startApiOnly: vi.fn().mockResolvedValue({
        profile: 'g41a5b5g',
        running: true,
        url: 'http://127.0.0.1:8654',
      }),
      getUpstream: vi.fn(() => 'http://127.0.0.1:8654'),
      getApiKey: vi.fn(() => null),
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed')
    }))

    const chatRun = new ChatRunSocket(io as any, gatewayManager)
    const socket = {
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (chatRun as any).handleRun(socket, { input: 'hello' }, 'g41a5b5g')

    expect(gatewayManager.detectStatus).toHaveBeenCalledWith('g41a5b5g')
    expect(gatewayManager.startApiOnly).toHaveBeenCalledWith('g41a5b5g')
    expect(gatewayManager.getUpstream).toHaveBeenCalledWith('g41a5b5g')
  })

  it('forwards provider with the selected model to the upstream run request', async () => {
    const { io } = createSocketServer()
    const gatewayManager = {
      detectStatus: vi.fn().mockResolvedValue({
        profile: 'g41a5b5g',
        running: true,
        url: 'http://127.0.0.1:8654',
      }),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => 'http://127.0.0.1:8654'),
      getApiKey: vi.fn(() => null),
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const chatRun = new ChatRunSocket(io as any, gatewayManager)
    const socket = {
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (chatRun as any).handleRun(socket, {
      input: 'hello',
      session_id: 'session-1',
      model: 'gpt-5.4',
      provider: 'openai',
    }, 'g41a5b5g')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toEqual(expect.objectContaining({
      model: 'gpt-5.4',
      provider: 'openai',
    }))
  })

  it('inlines uploaded markdown file content before forwarding a run upstream', async () => {
    const profile = 'vitest-file-profile'
    const profileDir = resolve(homedir(), '.hermes', 'profiles', profile)
    const uploadDir = join(profileDir, 'workspace', 'uploads')
    await mkdir(uploadDir, { recursive: true })
    await writeFile(join(uploadDir, 'note.md'), '# Uploaded Note\n\nThis text should reach Hermes.\n')

    try {
      const { io } = createSocketServer()
      const gatewayManager = {
        detectStatus: vi.fn().mockResolvedValue({
          profile,
          running: true,
          url: 'http://127.0.0.1:8654',
        }),
        startApiOnly: vi.fn(),
        getUpstream: vi.fn(() => 'http://127.0.0.1:8654'),
        getApiKey: vi.fn(() => null),
      }
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      vi.stubGlobal('fetch', fetchMock)

      const chatRun = new ChatRunSocket(io as any, gatewayManager)
      const socket = {
        connected: true,
        emit: vi.fn(),
        join: vi.fn(),
      }

      await (chatRun as any).handleRun(socket, {
        input: [
          { type: 'text', text: '讲一讲' },
          { type: 'file', name: 'note.md', path: 'uploads/note.md', media_type: 'text/markdown' },
        ],
      }, profile)

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body.input).toContain('讲一讲')
      expect(body.input).toContain('# Uploaded Note')
      expect(body.input).toContain('This text should reach Hermes.')
      expect(body.input).not.toContain('[File: uploads/note.md]')
    } finally {
      await rm(profileDir, { recursive: true, force: true })
    }
  })

  it('retries Hermes state sync after a completed local chat run', () => {
    const { io } = createSocketServer()
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => 'http://127.0.0.1:8654'),
      getApiKey: vi.fn(() => null),
    }
    const chatRun = new ChatRunSocket(io as any, gatewayManager)
    const syncFromHermes = vi.fn(async () => true)
    ;(chatRun as any).syncFromHermes = syncFromHermes
    ;(chatRun as any).sessionMap.set('local-session', {
      messages: [],
      isWorking: true,
      events: [],
      profile: 'g41a5b5g',
    })
    ;(chatRun as any).hermesSessionIds.set('local-session', 'eph-delayed')

    const socket = {
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    ;(chatRun as any).markCompleted(socket, 'local-session', {
      event: 'run.completed',
      run_id: 'run-1',
    })

    expect(syncFromHermes).toHaveBeenCalledWith(
      socket,
      'local-session',
      'eph-delayed',
      'g41a5b5g',
      { maxAttempts: 10, delayMs: 500 },
    )
  })
})
