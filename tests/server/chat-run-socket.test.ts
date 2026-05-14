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
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('binds Feishu OAuth socket runs to the signed session profile', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_AUTH_MODE', 'feishu-oauth-dev')
    vi.stubEnv('FEISHU_SESSION_SECRET', 'socket-secret')

    const { ChatRunSocket: OAuthChatRunSocket } = await import('../../packages/server/src/services/hermes/chat-run-socket')
    const { createFeishuSessionCookie, FEISHU_SESSION_COOKIE } = await import('../../packages/server/src/services/feishu-oauth')
    const { io, namespace } = createSocketServer()
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => 'http://127.0.0.1:8651'),
      getApiKey: vi.fn(() => null),
    }
    const chatRun = new OAuthChatRunSocket(io as any, gatewayManager)
    const handleRun = vi.spyOn(chatRun as any, 'handleRun').mockResolvedValue(undefined)

    chatRun.init()
    const middleware = namespace.use.mock.calls[0][0]
    const onConnection = namespace.on.mock.calls.find(([event]) => event === 'connection')?.[1]
    const cookie = createFeishuSessionCookie({
      openid: 'ou_test',
      profile: 'feishu_ou_bound',
      secret: 'socket-secret',
    })
    const socket = {
      data: {},
      handshake: {
        auth: {},
        query: { profile: 'default' },
        headers: { cookie: `${FEISHU_SESSION_COOKIE}=${cookie}` },
      },
      on: vi.fn(),
      emit: vi.fn(),
      join: vi.fn(),
      connected: true,
    }

    await new Promise<void>((resolvePromise, reject) => {
      middleware(socket, (err?: Error) => err ? reject(err) : resolvePromise())
    })
    onConnection(socket)
    const runHandler = socket.on.mock.calls.find(([event]) => event === 'run')?.[1]
    await runHandler({ input: 'hello' })

    expect(handleRun).toHaveBeenCalledWith(socket, { input: 'hello' }, 'feishu_ou_bound')
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

  it('uses Hermes-native response chaining instead of local conversation_history', async () => {
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
      session_id: 'session-native',
      model: 'gpt-5.4',
    }, 'g41a5b5g')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toEqual(expect.objectContaining({
      input: 'hello',
      conversation: 'webui:session-native',
      store: true,
      stream: true,
    }))
    expect(body).not.toHaveProperty('conversation_history')
  })

  it('submits WebUI socket runs to the broker when the broker flag is enabled', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_WEBUI_RUN_BROKER', '1')
    vi.stubEnv('HERMES_RUN_BROKER_URL', 'http://127.0.0.1:8652')
    vi.stubEnv('HERMES_RUN_BROKER_KEY', 'broker-secret')
    const { ChatRunSocket: BrokerChatRunSocket } = await import('../../packages/server/src/services/hermes/chat-run-socket')

    const { io, room } = createSocketServer()
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => {
        throw new Error('profile apiserver should not be used')
      }),
      getApiKey: vi.fn(() => null),
    }
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"kind":"content","text":"broker hello","payload":{"run_id":"run_webui_1"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"kind":"done","payload":{"run_id":"run_webui_1","usage":{"input_tokens":1,"output_tokens":2}}}\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const chatRun = new BrokerChatRunSocket(io as any, gatewayManager)
    const socket = {
      data: { user: { openid: 'ou_webui_user' } },
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (chatRun as any).handleRun(socket, {
      input: 'hello broker',
      session_id: 'session-broker',
      model: 'gpt-5.4',
      provider: 'openai',
    }, 'sunke')

    expect(gatewayManager.getUpstream).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8652/api/run-broker/runs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer broker-secret',
      }),
    }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toEqual(expect.objectContaining({
      channel: 'webui',
      profile_name: 'sunke',
      user_key: 'ou_webui_user',
      content: 'hello broker',
      session_id: 'session-broker',
      delivery_mode: 'socket',
      credential_subject: 'ou_webui_user',
      requires_host_tools: true,
    }))
    expect(body.metadata).toEqual(expect.objectContaining({
      model: 'gpt-5.4',
      provider: 'openai',
      conversation: 'webui:session-broker',
    }))
    expect(room.emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      session_id: 'session-broker',
      delta: 'broker hello',
    }))
    expect(room.emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      session_id: 'session-broker',
      run_id: 'run_webui_1',
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
