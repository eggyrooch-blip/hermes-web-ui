import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir, tmpdir } from 'os'
import { ChatRunSocket, mapRunBrokerFrameForChat } from '../../packages/server/src/services/hermes/chat-run-socket'

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

  it('binds Feishu OAuth socket runs to an owned selected profile when requested', async () => {
    vi.resetModules()
    const dir = mkdtempSync(join(tmpdir(), 'chat-run-owned-profile-'))
    const dbPath = join(dir, 'multitenancy.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE multitenancy_routing (
          user_id TEXT PRIMARY KEY NOT NULL,
          profile_name TEXT NOT NULL,
          open_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          owner_open_id TEXT,
          provenance TEXT DEFAULT 'sync'
        );
      `)
      db.prepare('INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id, provenance) VALUES (?, ?, ?, ?, ?, ?)').run(
        'group:alpha',
        'feishu_group_alpha',
        '',
        1,
        'ou_test',
        'group',
      )
    } finally {
      db.close()
    }

    vi.stubEnv('HERMES_AUTH_MODE', 'feishu-oauth-dev')
    vi.stubEnv('FEISHU_SESSION_SECRET', 'socket-secret')
    vi.stubEnv('HERMES_MULTITENANCY_DB', dbPath)

    const { ChatRunSocket: OAuthChatRunSocket } = await import('../../packages/server/src/services/hermes/chat-run-socket')
    const { createFeishuSessionCookie, FEISHU_SESSION_COOKIE } = await import('../../packages/server/src/services/feishu-oauth')
    const { io, namespace } = createSocketServer()
    const chatRun = new OAuthChatRunSocket(io as any, {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(),
      getApiKey: vi.fn(),
    })
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
        query: { profile: 'feishu_group_alpha' },
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
    await runHandler({ input: 'hello selected profile' })

    expect(handleRun).toHaveBeenCalledWith(socket, { input: 'hello selected profile' }, 'feishu_group_alpha')
    await rm(dir, { recursive: true, force: true })
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
    vi.stubEnv('HERMES_RUN_BROKER_URL', 'http://127.0.0.1:8766')
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
    ;(chatRun as any).sessionMap.set('session-broker', {
      messages: [
        {
          id: 1,
          session_id: 'session-broker',
          role: 'user',
          content: '查一下明天北京天气',
          timestamp: 1,
        },
        {
          id: 2,
          session_id: 'session-broker',
          role: 'assistant',
          content: '北京明天最低温 18°C。',
          timestamp: 2,
        },
      ],
      isWorking: false,
      events: [],
      queue: [],
      profile: 'sunke',
    })
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
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8766/api/run-broker/runs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer broker-secret',
        'X-Hermes-Owner-Open-Id': 'ou_webui_user',
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
    expect(body.messages).toEqual([
      { role: 'user', content: '查一下明天北京天气' },
      { role: 'assistant', content: '北京明天最低温 18°C。' },
      { role: 'user', content: 'hello broker' },
    ])
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

  it('persists a visible assistant error when the broker run fails before streaming', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_WEBUI_RUN_BROKER', '1')
    vi.stubEnv('HERMES_RUN_BROKER_URL', 'http://127.0.0.1:8766')
    const { ChatRunSocket: BrokerChatRunSocket } = await import('../../packages/server/src/services/hermes/chat-run-socket')
    const { getSessionDetail } = await import('../../packages/server/src/db/hermes/session-store')

    const { io, room } = createSocketServer()
    const sessionId = `session-broker-fail-${Date.now()}`
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => {
        throw new Error('profile apiserver should not be used')
      }),
      getApiKey: vi.fn(() => null),
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('owner credential denied', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    })))

    const chatRun = new BrokerChatRunSocket(io as any, gatewayManager)
    const socket = {
      data: { user: { openid: 'ou_webui_user' } },
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (chatRun as any).handleRun(socket, {
      input: [
        { type: 'text', text: '页面效果还是错的呢？你看看？' },
        { type: 'image', name: 'page.png', path: 'uploads/page.png', media_type: 'image/png' },
      ],
      session_id: sessionId,
    }, 'baiguannan')

    const state = (chatRun as any).sessionMap.get(sessionId)
    const assistantError = state.messages.find((message: any) => (
      message.role === 'assistant' && message.finish_reason === 'error'
    ))

    expect(assistantError).toEqual(expect.objectContaining({
      session_id: sessionId,
      content: expect.stringContaining('Run broker 503'),
    }))
    expect(getSessionDetail(sessionId)?.messages).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({
        role: 'assistant',
        finish_reason: 'error',
        content: expect.stringContaining('Run broker 503'),
      }),
    ])
    expect(room.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      session_id: sessionId,
      error: expect.stringContaining('Run broker 503'),
    }))
  })

  it('persists a visible assistant error when the broker stream emits run.failed before content', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_WEBUI_RUN_BROKER', '1')
    vi.stubEnv('HERMES_RUN_BROKER_URL', 'http://127.0.0.1:8766')
    const { ChatRunSocket: BrokerChatRunSocket } = await import('../../packages/server/src/services/hermes/chat-run-socket')
    const { getSessionDetail } = await import('../../packages/server/src/db/hermes/session-store')

    const { io, room } = createSocketServer()
    const sessionId = `session-broker-stream-fail-${Date.now()}`
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => {
        throw new Error('profile apiserver should not be used')
      }),
      getApiKey: vi.fn(() => null),
    }
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"kind":"error","run_id":"run-fail","error":"owner credential denied"}\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })))

    const chatRun = new BrokerChatRunSocket(io as any, gatewayManager)
    const socket = {
      data: { user: { openid: 'ou_webui_user' } },
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (chatRun as any).handleRun(socket, {
      input: [
        { type: 'text', text: '页面效果还是错的呢？你看看？' },
        { type: 'image', name: 'page.png', path: 'uploads/page.png', media_type: 'image/png' },
      ],
      session_id: sessionId,
    }, 'baiguannan')

    expect(getSessionDetail(sessionId)?.messages).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({
        role: 'assistant',
        finish_reason: 'error',
        content: expect.stringContaining('owner credential denied'),
      }),
    ])
    expect(room.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      session_id: sessionId,
      error: 'owner credential denied',
    }))
  })

  it('does not add a generic failure message after broker content already streamed', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_WEBUI_RUN_BROKER', '1')
    vi.stubEnv('HERMES_RUN_BROKER_URL', 'http://127.0.0.1:8766')
    const { ChatRunSocket: BrokerChatRunSocket } = await import('../../packages/server/src/services/hermes/chat-run-socket')
    const { getSessionDetail } = await import('../../packages/server/src/db/hermes/session-store')

    const { io } = createSocketServer()
    const sessionId = `session-broker-partial-fail-${Date.now()}`
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => {
        throw new Error('profile apiserver should not be used')
      }),
      getApiKey: vi.fn(() => null),
    }
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"kind":"content","text":"我先看一下页面。","run_id":"run-partial"}\n\n'))
        controller.enqueue(encoder.encode('data: {"kind":"error","run_id":"run-partial","error":"tool runtime failed"}\n\n'))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })))

    const chatRun = new BrokerChatRunSocket(io as any, gatewayManager)
    const socket = {
      data: { user: { openid: 'ou_webui_user' } },
      connected: true,
      emit: vi.fn(),
      join: vi.fn(),
    }

    await (chatRun as any).handleRun(socket, {
      input: '页面效果还是错的呢？你看看？',
      session_id: sessionId,
    }, 'baiguannan')

    const assistantMessages = getSessionDetail(sessionId)?.messages.filter(message => message.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages?.[0]).toEqual(expect.objectContaining({
      content: '我先看一下页面。',
    }))
    expect(assistantMessages?.[0].content).not.toContain('运行失败')
  })

  it('maps broker thinking frames to reasoning and preserves tool metadata', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'thinking',
      run_id: 'run-1',
      text: 'I should inspect the file first.',
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'reasoning.delta',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: expect.objectContaining({
        event: 'reasoning.delta',
        delta: 'I should inspect the file first.',
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'thinking',
      run_id: 'run-1',
      text: '正在连接模型和工具运行环境...',
    })).toEqual({ type: 'ignore' })

    expect(mapRunBrokerFrameForChat({
      kind: 'tool_started',
      run_id: 'run-1',
      name: 'lark_cli',
      payload: {
        tool_call_id: 'call-1',
        args: { cmd: 'docx create' },
        preview: 'docx create',
      },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'call-1',
        name: 'lark_cli',
        arguments: '{"cmd":"docx create"}',
        preview: 'docx create',
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'tool_started',
      run_id: 'run-1',
      name: 'terminal',
      payload: {
        preview: "/bin/sh -lc 'printf STREAM_FIXED_OK'",
      },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'tool.started',
      payload: expect.objectContaining({
        arguments: JSON.stringify({ cmd: "/bin/sh -lc 'printf STREAM_FIXED_OK'" }),
        preview: "/bin/sh -lc 'printf STREAM_FIXED_OK'",
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'tool_completed',
      run_id: 'run-1',
      name: 'lark_cli',
      payload: {
        tool_call_id: 'call-1',
        output: 'created doc',
        duration: 1.25,
        is_error: false,
      },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'tool.completed',
      payload: expect.objectContaining({
        tool_call_id: 'call-1',
        name: 'lark_cli',
        output: 'created doc',
        duration: 1.25,
        is_error: false,
      }),
    }))
  })

  it('synthesizes stable broker tool ids when frames omit tool_call_id', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_WEBUI_RUN_BROKER', '1')
    vi.stubEnv('HERMES_RUN_BROKER_URL', 'http://127.0.0.1:8766')
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
        controller.enqueue(encoder.encode('data: {"kind":"tool_started","run_id":"run-no-id","name":"terminal","payload":{"preview":"generating arguments"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"kind":"tool_started","run_id":"run-no-id","name":"terminal","payload":{"arguments":{"cmd":"printf TOOL_PANEL_OK_DONE"},"preview":"printf TOOL_PANEL_OK_DONE"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"kind":"tool_completed","run_id":"run-no-id","name":"terminal","payload":{"output":"TOOL_PANEL_OK_DONE","is_error":false}}\n\n'))
        controller.enqueue(encoder.encode('data: {"kind":"content","text":"done","payload":{"run_id":"run-no-id"}}\n\n'))
        controller.enqueue(encoder.encode('data: {"kind":"done","payload":{"run_id":"run-no-id"}}\n\n'))
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
      input: 'run terminal',
      session_id: 'session-no-id',
    }, 'sunke')

    const started = room.emit.mock.calls.find(([event]) => event === 'tool.started')?.[1]
    const completed = room.emit.mock.calls.find(([event]) => event === 'tool.completed')?.[1]
    expect(started?.tool_call_id).toMatch(/^broker_tool_run-no-id_terminal/)
    expect(completed?.tool_call_id).toBe(started.tool_call_id)

    const state = (chatRun as any).sessionMap.get('session-no-id')
    const assistantTool = state.messages.find((m: any) => m.role === 'assistant' && m.tool_calls?.length)
    const toolResult = state.messages.find((m: any) => m.role === 'tool')
    expect(assistantTool.tool_calls[0].id).toBe(started.tool_call_id)
    expect(assistantTool.tool_calls[0].function.arguments).toBe('{"cmd":"printf TOOL_PANEL_OK_DONE"}')
    expect(toolResult.tool_call_id).toBe(started.tool_call_id)
    expect(toolResult.tool_name).toBe('terminal')
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

  it('extracts uploaded xlsx content before forwarding a run upstream', async () => {
    const profile = 'vitest-xlsx-profile'
    const profileDir = resolve(homedir(), '.hermes', 'profiles', profile)
    const uploadDir = join(profileDir, 'workspace', 'uploads')
    await mkdir(uploadDir, { recursive: true })
    const xlsxBase64 = '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'
    await writeFile(join(uploadDir, 'sheet.xlsx'), Buffer.from(xlsxBase64, 'base64'))

    try {
      const { io } = createSocketServer()
      const gatewayManager = {
        detectStatus: vi.fn().mockResolvedValue({ profile, running: true, url: 'http://127.0.0.1:8654' }),
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
      const socket = { connected: true, emit: vi.fn(), join: vi.fn() }

      await (chatRun as any).handleRun(socket, {
        input: [
          { type: 'text', text: 'Read this sheet.' },
          { type: 'file', name: 'sheet.xlsx', path: 'uploads/sheet.xlsx', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        ],
      }, profile)

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body.input).toContain('HERMES_FILE_E2E_20260514_2230')
      expect(body.input).toContain('42')
      expect(body.input).not.toBe('[File: sheet.xlsx]')
    } finally {
      await rm(profileDir, { recursive: true, force: true })
    }
  })

  it('publishes API Server assistant MEDIA paths before completion reaches the client', async () => {
    const profile = 'vitest-media-profile'
    const profileDir = resolve(homedir(), '.hermes', 'profiles', profile)
    const source = join(profileDir, 'home', 'particle_animation.gif')
    await mkdir(join(profileDir, 'home'), { recursive: true })
    await writeFile(source, Buffer.from('GIF89a'))

    try {
      const { io, room } = createSocketServer()
      const gatewayManager = {
        detectStatus: vi.fn().mockResolvedValue({ profile, running: true, url: 'http://127.0.0.1:8654' }),
        startApiOnly: vi.fn(),
        getUpstream: vi.fn(() => 'http://127.0.0.1:8654'),
        getApiKey: vi.fn(() => null),
      }
      const encoder = new TextEncoder()
      const finalText = `生成完成！\n\nMEDIA:${source}\n\nDone`
      const fetchMock = vi.fn(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"run-media","status":"in_progress"}}\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: finalText })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'run-media',
              output: [{ type: 'message', content: [{ type: 'output_text', text: finalText }] }],
            },
          })}\n\n`))
          controller.close()
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))
      vi.stubGlobal('fetch', fetchMock)

      const chatRun = new ChatRunSocket(io as any, gatewayManager)
      const socket = { connected: true, emit: vi.fn(), join: vi.fn() }

      await (chatRun as any).handleRun(socket, {
        input: 'generate gif',
        session_id: 'session-media',
      }, profile)

      const completed = room.emit.mock.calls.find(([event]) => event === 'run.completed')?.[1]
      expect(completed.parsed_content).toContain('MEDIA:/workspace/Downloads/particle_animation.gif')
      expect(completed.parsed_content).not.toContain(profileDir)
      expect(existsSync(join(profileDir, 'workspace', 'Downloads', 'particle_animation.gif'))).toBe(true)
      const state = (chatRun as any).sessionMap.get('session-media')
      const assistant = state.messages.find((message: any) => message.role === 'assistant')
      expect(assistant.content).toContain('MEDIA:/workspace/Downloads/particle_animation.gif')
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

  it('tags queue-length updates with the dequeued queue id only when starting a queued run', () => {
    const { io, room } = createSocketServer()
    const gatewayManager = {
      detectStatus: vi.fn(),
      startApiOnly: vi.fn(),
      getUpstream: vi.fn(() => 'http://127.0.0.1:8654'),
      getApiKey: vi.fn(() => null),
    }
    const chatRun = new ChatRunSocket(io as any, gatewayManager)
    const handleRun = vi.spyOn(chatRun as any, 'handleRun').mockResolvedValue(undefined)
    ;(chatRun as any).sessionMap.set('queued-session', {
      messages: [],
      isWorking: false,
      events: [],
      queue: [
        {
          queue_id: 'queued-message-1',
          input: 'queued body',
          model: 'gpt-5.4',
          provider: 'openai',
          instructions: 'be brief',
          profile: 'sunke',
        },
      ],
      profile: 'sunke',
    })
    const socket = { connected: true, emit: vi.fn(), join: vi.fn() }

    const dequeued = (chatRun as any).dequeueNextQueuedRun(socket, 'queued-session')

    expect(dequeued).toBe(true)
    expect(room.emit).toHaveBeenCalledWith('run.queued', {
      event: 'run.queued',
      session_id: 'queued-session',
      queue_length: 0,
      dequeued_queue_id: 'queued-message-1',
    })
    expect(handleRun).toHaveBeenCalledWith(socket, {
      input: 'queued body',
      session_id: 'queued-session',
      model: 'gpt-5.4',
      provider: 'openai',
      instructions: 'be brief',
    }, 'sunke', true)
  })
})
