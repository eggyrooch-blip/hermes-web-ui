import { createHash, randomBytes } from 'crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

const configMock = vi.hoisted(() => ({
  authMode: 'feishu-oauth-dev',
  webPlane: 'chat',
  runBrokerUrl: '',
  runBrokerKey: 'broker-key',
  corsOrigins: '',
  requiredProfile: '',
  chatPlaneAllowSettings: false,
}))

vi.mock('../../packages/server/src/config', () => ({ config: configMock }))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
// Session cookie `hermes_feishu_session=<openid>` stands for a verified Feishu session.
vi.mock('../../packages/server/src/services/feishu-oauth', () => ({
  extractFeishuSessionFromCookieHeader: (header: string | string[] | undefined) => {
    const raw = Array.isArray(header) ? header.join(';') : header || ''
    const match = raw.match(/hermes_feishu_session=([^;]+)/)
    return match?.[1]
  },
  getFeishuSessionSecret: () => 'secret',
  parseFeishuSessionCookie: (cookie: string | undefined) => {
    if (cookie === 'ou_alice') return { openid: 'ou_alice', profile: 'alice', role: 'user' }
    if (cookie === 'ou_bob') return { openid: 'ou_bob', profile: 'bob', role: 'user' }
    return null
  },
}))
vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  ownerOwnsProfile: (openid: string, profile: string) => openid === 'ou_alice' && profile === 'alice_work',
  resolveOwnedProfileAgentId: (openid: string, profile: string) =>
    openid === 'ou_alice' && profile === 'alice_work' ? 'agent-alice-work' : null,
}))

interface BrokerCall {
  path: string
  headers: IncomingHttpHeaders
  body: any
}

interface MockBroker {
  url: string
  calls: BrokerCall[]
  wsConnections: Array<{ socket: WebSocket; headers: IncomingHttpHeaders; url: string; received: Buffer[]; closed: Promise<number> }>
  restStatus: Record<string, { status: number; body: unknown }>
  /** Hold every broker WS upgrade this long before accepting it. */
  upgradeDelay: { ms: number }
  upgradeAttempts: { count: number }
  close: () => Promise<void>
}

const VIEWER_ID = 'viewer-abc_123'
const viewerHash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12)

async function startMockBroker(): Promise<MockBroker> {
  const calls: BrokerCall[] = []
  const wsConnections: MockBroker['wsConnections'] = []
  const restStatus: MockBroker['restStatus'] = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const path = req.url || ''
      calls.push({ path, headers: req.headers, body: raw ? JSON.parse(raw) : null })
      const override = restStatus[path]
      res.setHeader('Content-Type', 'application/json')
      if (override) {
        res.statusCode = override.status
        res.end(JSON.stringify(override.body))
        return
      }
      if (path.endsWith('/observe') || path.endsWith('/ensure')) {
        res.end(JSON.stringify({
          enabled: true,
          running: true,
          viewer_id: VIEWER_ID,
          lease: { holder: 'human', viewer_id: null, viewer_hash: viewerHash(VIEWER_ID), epoch: 3 },
        }))
        return
      }
      if (path.endsWith('/lease/acquire')) {
        res.end(JSON.stringify({ lease: { holder: 'human', viewer_id: null, viewer_hash: viewerHash(String(JSON.parse(raw).viewer_id)), epoch: 4 } }))
        return
      }
      res.end(JSON.stringify({ lease: { holder: 'agent', viewer_id: null, viewer_hash: null, epoch: 5 } }))
    })
  })
  const upgradeDelay = { ms: 0 }
  const upgradeAttempts = { count: 0 }
  const wss = new WebSocketServer({
    server,
    path: '/api/run-broker/desktop/ws',
    verifyClient: (_info, done) => {
      upgradeAttempts.count += 1
      if (upgradeDelay.ms) setTimeout(() => done(true), upgradeDelay.ms)
      else done(true)
    },
  })
  wss.on('connection', (socket, req) => {
    const received: Buffer[] = []
    const closed = new Promise<number>(resolveClosed => socket.on('close', code => resolveClosed(code)))
    socket.on('message', data => received.push(Buffer.from(data as Buffer)))
    wsConnections.push({ socket, headers: req.headers, url: req.url || '', received, closed })
    socket.send(Buffer.from('RFB 003.008\n'))
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    wsConnections,
    restStatus,
    upgradeDelay,
    upgradeAttempts,
    close: () => new Promise(resolveClose => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.close(() => resolveClose())
    }),
  }
}

function fakeCtx(options: { user?: Record<string, unknown> | null; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown }) {
  const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    state: { user: options.user === undefined ? { openid: 'ou_alice', profile: 'alice' } : options.user },
    query: options.query || {},
    get: (name: string) => headers[name.toLowerCase()] || '',
    request: { body: options.body || {} },
    status: 200,
    body: undefined as any,
  } as any
}

describe('desktop screen REST passthrough', () => {
  let broker: MockBroker

  beforeEach(async () => {
    vi.resetModules()
    broker = await startMockBroker()
    configMock.runBrokerUrl = broker.url
  })

  afterEach(async () => {
    await broker.close()
  })

  it('observes as the session owner and reports whether this viewer holds the lease', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ query: { profile: 'alice' }, body: { open_id: 'ou_mallory' } })

    await ctrl.observe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ enabled: true, running: true, viewer_id: VIEWER_ID, you_hold: true })
    expect(broker.calls).toHaveLength(1)
    expect(broker.calls[0].path).toBe('/api/run-broker/desktop/observe')
    expect(broker.calls[0].headers.authorization).toBe('Bearer broker-key')
    expect(broker.calls[0].headers['x-hermes-owner-open-id']).toBe('ou_alice')
    expect(broker.calls[0].headers['x-hermes-agent-id']).toBeUndefined()
    expect(broker.calls[0].body).toEqual({})
  })

  it('addresses an owned non-default profile through its agent id', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ headers: { 'X-Hermes-Profile': 'alice_work' } })

    await ctrl.observe(ctx)

    expect(ctx.status).toBe(200)
    expect(broker.calls[0].headers['x-hermes-agent-id']).toBe('agent-alice-work')
  })

  it('refuses a profile the session does not own without calling the broker', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ query: { profile: 'bob' } })

    await ctrl.observe(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'desktop_forbidden' })
    expect(broker.calls).toHaveLength(0)
  })

  it('refuses an agent id that is neither owned nor shared with the session', async () => {
    broker.restStatus['/api/run-broker/agents/shared'] = { status: 200, body: { agents: [] } }
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ query: { profile: 'bob', agent_id: 'agent-bob' }, body: { viewer_id: VIEWER_ID } })

    await ctrl.acquireLease(ctx)

    expect(ctx.status).toBe(403)
    expect(broker.calls.map(call => call.path)).toEqual(['/api/run-broker/agents/shared'])
    expect(broker.calls[0].headers['x-hermes-owner-open-id']).toBe('ou_alice')
  })

  it('refuses requests without a verified session identity', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ user: null })

    await ctrl.observe(ctx)

    expect(ctx.status).toBe(403)
    expect(broker.calls).toHaveLength(0)
  })

  it('maps a profile without a desktop to enabled:false instead of an auth error', async () => {
    broker.restStatus['/api/run-broker/desktop/observe'] = { status: 403, body: { error: 'desktop_disabled' } }
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({})

    await ctrl.observe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ enabled: false, running: false, you_hold: false })
  })

  it('maps any broker 403 on observe/ensure (owner-only shared agent) to enabled:false', async () => {
    const forbidden = { status: 403, body: { error: 'forbidden', message: "desktop of profile 'alice' is owner-only" } }
    broker.restStatus['/api/run-broker/desktop/observe'] = forbidden
    broker.restStatus['/api/run-broker/desktop/ensure'] = forbidden
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')

    const observed = fakeCtx({})
    await ctrl.observe(observed)
    const ensured = fakeCtx({})
    await ctrl.ensure(ensured)

    expect(observed.status).toBe(200)
    expect(observed.body).toMatchObject({ enabled: false, you_hold: false })
    expect(ensured.status).toBe(200)
    expect(ensured.body).toMatchObject({ enabled: false, you_hold: false })
  })

  it('never forwards the lease holder viewer id even if the broker sends one', async () => {
    broker.restStatus['/api/run-broker/desktop/lease/acquire'] = {
      status: 200,
      body: { lease: { holder: 'human', viewer_id: VIEWER_ID, viewer_hash: viewerHash(VIEWER_ID), epoch: 9 } },
    }
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ body: { viewer_id: VIEWER_ID } })

    await ctrl.acquireLease(ctx)

    expect(ctx.body.lease).toEqual({ holder: 'human', viewer_id: null, viewer_hash: viewerHash(VIEWER_ID), epoch: 9 })
    expect(ctx.body.you_hold).toBe(true)
  })

  it('passes a broker 503 desktop_not_running on acquire through to the page', async () => {
    broker.restStatus['/api/run-broker/desktop/lease/acquire'] = { status: 503, body: { error: 'desktop_not_running' } }
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ body: { viewer_id: VIEWER_ID } })

    await ctrl.acquireLease(ctx)

    expect(ctx.status).toBe(503)
    expect(ctx.body).toEqual({ error: 'desktop_not_running' })
  })

  it('forwards only viewer_id on lease acquire and passes other broker rejections through', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const acquire = fakeCtx({ body: { viewer_id: VIEWER_ID, open_id: 'ou_bob', profile: 'bob' } })

    await ctrl.acquireLease(acquire)

    expect(acquire.body).toMatchObject({ lease: { holder: 'human' }, you_hold: true })
    expect(broker.calls[0].body).toEqual({ viewer_id: VIEWER_ID })

    broker.restStatus['/api/run-broker/desktop/lease/release'] = { status: 403, body: { error: 'viewer_not_owned' } }
    const release = fakeCtx({ body: { viewer_id: 'someone-else' } })
    await ctrl.releaseLease(release)
    expect(release.status).toBe(403)
    expect(release.body).toEqual({ error: 'viewer_not_owned' })
  })

  it('lets ensure keep a well-formed viewer id and drops a malformed one', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    await ctrl.ensure(fakeCtx({ body: { viewer_id: VIEWER_ID, open_id: 'ou_bob' } }))
    await ctrl.ensure(fakeCtx({ body: { viewer_id: '../x' } }))
    expect(broker.calls.map(call => call.body)).toEqual([{ viewer_id: VIEWER_ID }, {}])
  })

  it('passes the broker 429 too_many_viewers through for the page to explain', async () => {
    broker.restStatus['/api/run-broker/desktop/observe'] = { status: 429, body: { error: 'too_many_viewers', message: 'too many viewers' } }
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({})
    await ctrl.observe(ctx)
    expect(ctx.status).toBe(429)
    expect(ctx.body).toEqual({ error: 'too_many_viewers', message: 'too many viewers' })
  })

  it('rejects a lease call without a well-formed viewer_id', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/desktop-screen')
    const ctx = fakeCtx({ body: { viewer_id: '../../etc' } })

    await ctrl.acquireLease(ctx)

    expect(ctx.status).toBe(400)
    expect(broker.calls).toHaveLength(0)
  })

  it('lets the desktop POST endpoints through the chat-plane gate and nothing else under it', async () => {
    const { enforcePlaneAccess } = await import('../../packages/server/src/services/request-context')
    const gate = async (method: string, path: string) => {
      const ctx = { method, path, status: 200, body: undefined as any }
      const next = vi.fn(async () => undefined)
      await enforcePlaneAccess(ctx as any, next)
      return next.mock.calls.length === 1
    }

    expect(await gate('POST', '/api/hermes/desktop/observe')).toBe(true)
    expect(await gate('POST', '/api/hermes/desktop/ensure')).toBe(true)
    expect(await gate('POST', '/api/hermes/desktop/lease/acquire')).toBe(true)
    expect(await gate('POST', '/API/HERMES/DESKTOP/LEASE/RELEASE')).toBe(true)
    expect(await gate('GET', '/api/hermes/desktop/observe')).toBe(false)
    expect(await gate('POST', '/api/hermes/desktop/lease/steal')).toBe(false)
  })
})

describe('desktop screen WebSocket bridge', () => {
  let broker: MockBroker
  let webui: Server
  let webuiPort: number

  beforeEach(async () => {
    vi.resetModules()
    broker = await startMockBroker()
    configMock.runBrokerUrl = broker.url
    const { setupDesktopScreenWebSocket } = await import('../../packages/server/src/routes/hermes/desktop-screen')
    webui = createServer((_req, res) => { res.statusCode = 404; res.end() })
    setupDesktopScreenWebSocket(webui)
    await new Promise<void>(resolveListen => webui.listen(0, '127.0.0.1', resolveListen))
    webuiPort = (webui.address() as AddressInfo).port
  })

  afterEach(async () => {
    webui.closeAllConnections()
    await new Promise<void>(resolveClose => webui.close(() => resolveClose()))
    await broker.close()
  })

  function dial(options: { cookie?: string; origin?: string | null; query?: string }) {
    const headers: Record<string, string> = {}
    if (options.cookie) headers.Cookie = `hermes_feishu_session=${options.cookie}`
    if (options.origin !== null) headers.Origin = options.origin ?? `http://127.0.0.1:${webuiPort}`
    return new WebSocket(`ws://127.0.0.1:${webuiPort}/api/hermes/desktop/ws?${options.query ?? `viewer_id=${VIEWER_ID}`}`, { headers })
  }

  function rejectedStatus(ws: WebSocket): Promise<number> {
    return new Promise((resolveStatus, rejectStatus) => {
      ws.once('unexpected-response', (_req, res) => resolveStatus(res.statusCode || 0))
      ws.once('open', () => rejectStatus(new Error('upgrade unexpectedly succeeded')))
      ws.once('error', () => undefined)
    })
  }

  function firstMessage(ws: WebSocket): Promise<Buffer> {
    return new Promise(resolveMessage => ws.once('message', data => resolveMessage(Buffer.from(data as Buffer))))
  }

  function closeCode(ws: WebSocket): Promise<number> {
    return new Promise(resolveClose => ws.once('close', code => resolveClose(code)))
  }

  it('bridges RFB bytes both ways as the cookie owner and mirrors the broker close code', async () => {
    const ws = dial({ cookie: 'ou_alice' })
    const greeting = await firstMessage(ws)
    expect(greeting.toString()).toBe('RFB 003.008\n')

    const upstream = broker.wsConnections[0]
    expect(upstream.headers['x-hermes-owner-open-id']).toBe('ou_alice')
    expect(upstream.headers.authorization).toBe('Bearer broker-key')
    expect(upstream.url).toBe(`/api/run-broker/desktop/ws?viewer_id=${VIEWER_ID}`)

    // A KeyEvent (type 4) from the browser reaches the broker byte for byte.
    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61])
    ws.send(keyEvent)
    await vi.waitFor(() => expect(upstream.received).toHaveLength(1))
    expect(upstream.received[0].equals(keyEvent)).toBe(true)

    const closed = closeCode(ws)
    upstream.socket.close(4000, 'control-taken')
    expect(await closed).toBe(4000)
  })

  it('passes a browser 1000 close to the broker so the lease is released', async () => {
    const ws = dial({ cookie: 'ou_alice' })
    await firstMessage(ws)
    ws.close(1000)
    expect(await broker.wsConnections[0].closed).toBe(1000)
  })

  it('forwards the agent id for an owned non-default profile', async () => {
    const ws = dial({ cookie: 'ou_alice', query: `viewer_id=${VIEWER_ID}&profile=alice_work` })
    await firstMessage(ws)
    expect(broker.wsConnections[0].headers['x-hermes-agent-id']).toBe('agent-alice-work')
    ws.close(1000)
  })

  it('refuses a foreign Origin before touching the broker', async () => {
    expect(await rejectedStatus(dial({ cookie: 'ou_alice', origin: 'https://evil.example' }))).toBe(403)
    expect(broker.wsConnections).toHaveLength(0)
  })

  it('accepts a missing Origin like kanban-events (the vite dev proxy strips it)', async () => {
    const ws = dial({ cookie: 'ou_alice', origin: null })
    expect((await firstMessage(ws)).toString()).toBe('RFB 003.008\n')
    ws.close(1000)
  })

  it('survives Socket.IO on the same server while the broker handshake takes longer than 1 s', async () => {
    const { Server: SocketIoServer } = await import('socket.io')
    const { SOCKET_IO_UPGRADE_OPTIONS } = await import('../../packages/server/src/security')
    const io = new SocketIoServer(webui, { ...SOCKET_IO_UPGRADE_OPTIONS })
    try {
      broker.upgradeDelay.ms = 1500
      const ws = dial({ cookie: 'ou_alice' })
      expect((await firstMessage(ws)).toString()).toBe('RFB 003.008\n')
      expect(ws.readyState).toBe(WebSocket.OPEN)
      ws.close(1000)
    } finally {
      io.close()
    }
  }, 10_000)

  it('stays up when the browser resets its socket during the broker handshake', async () => {
    const { connect } = await import('net')
    broker.upgradeDelay.ms = 500
    const raw = connect(webuiPort, '127.0.0.1')
    raw.on('error', () => undefined)
    await new Promise<void>(resolveConnect => raw.once('connect', () => resolveConnect()))
    raw.write([
      `GET /api/hermes/desktop/ws?viewer_id=${VIEWER_ID} HTTP/1.1`,
      `Host: 127.0.0.1:${webuiPort}`,
      `Origin: http://127.0.0.1:${webuiPort}`,
      'Cookie: hermes_feishu_session=ou_alice',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      '', '',
    ].join('\r\n'))
    await vi.waitFor(() => expect(broker.upgradeAttempts.count).toBe(1))
    raw.resetAndDestroy()

    // The handler abandons the broker leg and the server keeps serving.
    await new Promise(resolveWait => setTimeout(resolveWait, 800))
    broker.upgradeDelay.ms = 0
    const ws = dial({ cookie: 'ou_alice' })
    expect((await firstMessage(ws)).toString()).toBe('RFB 003.008\n')
    ws.close(1000)
  })

  it('drops the browser leg without writing HTTP into it when the live broker stream errors', async () => {
    const ws = dial({ cookie: 'ou_alice' })
    await firstMessage(ws)
    const clientErrors: Error[] = []
    ws.on('error', err => clientErrors.push(err))
    const closed = closeCode(ws)

    // A frame with a reserved opcode makes the bridge's upstream leg error out.
    ;(broker.wsConnections[0].socket as any)._socket.write(Buffer.from([0x83, 0x00]))

    expect(await closed).toBe(1006)
    expect(clientErrors).toEqual([])
  })

  it('refuses a missing session and a profile the session does not own', async () => {
    expect(await rejectedStatus(dial({}))).toBe(401)
    expect(await rejectedStatus(dial({ cookie: 'forged' }))).toBe(401)
    expect(await rejectedStatus(dial({ cookie: 'ou_bob', query: `viewer_id=${VIEWER_ID}&profile=alice` }))).toBe(403)
    expect(broker.wsConnections).toHaveLength(0)
  })

  it('refuses a malformed viewer id and relays a broker handshake rejection', async () => {
    expect(await rejectedStatus(dial({ cookie: 'ou_alice', query: 'viewer_id=a%20b' }))).toBe(400)
    configMock.runBrokerUrl = `${broker.url}/missing-prefix`
    expect(await rejectedStatus(dial({ cookie: 'ou_alice' }))).toBe(400)
    expect(broker.wsConnections).toHaveLength(0)
  })

  it('ignores upgrade paths it does not own', async () => {
    // Stand-in for index.ts's later catch-all: it only sees the socket if the
    // desktop handler left it untouched.
    webui.on('upgrade', (req, socket) => {
      if ((req.url || '').startsWith('/api/hermes/desktop/ws')) return
      socket.end('HTTP/1.1 418 Untouched\r\n\r\n')
    })
    const other = new WebSocket(`ws://127.0.0.1:${webuiPort}/api/hermes/kanban/events`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(await rejectedStatus(other)).toBe(418)
    expect(broker.wsConnections).toHaveLength(0)
  })
})
