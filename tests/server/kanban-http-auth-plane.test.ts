import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Real HTTP acceptance for the Kanban API: a real Koa app, the REAL auth chain
// (trustedFeishuAuth / requireUserJwt + enforcePlaneAccess) and the REAL router
// and controller. Only two things are faked, and neither is on the code path
// under test: the hermes CLI bridge (so no `hermes kanban` is spawned) and the
// run-broker, which is a separate Python service and is stood up here as a real
// local HTTP stub so the controller's own fetch, URL building and header
// forwarding all run for real.
//
// This exists because a controller called in-process proves nothing about which
// requests a real user can actually make: requireOpenId and enforcePlaneAccess
// both sit in front of it.

const OPENID = 'ou_probe'
const PROFILE = 'probe_profile'
const TRUSTED_SECRET = 'kanban-http-acceptance-secret'
const JWT_SECRET = 'kanban-http-acceptance-jwt'

const cli = vi.hoisted(() => ({
  normalizeBoardSlug: vi.fn((board?: string | null) => {
    const value = board?.trim() || 'default'
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid kanban board slug')
    return value
  }),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  completeTasks: vi.fn(),
  blockTask: vi.fn(),
  unblockTasks: vi.fn(),
  assignTask: vi.fn(),
  bulkUpdateTasks: vi.fn(),
  getStats: vi.fn(),
  getAssignees: vi.fn(),
  getCapabilities: vi.fn(),
  listBoards: vi.fn(),
  addComment: vi.fn(),
  getTaskLog: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-kanban', () => cli)

const mockEnsureWebUser = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/services/compat-user', () => ({
  ensureWebUserForFeishu: mockEnsureWebUser,
}))

const usersStore = vi.hoisted(() => ({
  findUserById: vi.fn(),
  listUserProfiles: vi.fn(() => [] as Array<{ profile_name: string }>),
  touchUserLogin: vi.fn(),
  userCanAccessProfile: vi.fn(() => true),
}))
vi.mock('../../packages/server/src/db/hermes/users-store', () => usersStore)

const originalEnv = process.env

function createRoutingDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-http-'))
  const dbPath = join(dir, 'multitenancy.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        user_id TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        open_id TEXT NOT NULL,
        owner_open_id TEXT,
        provenance TEXT,
        kind TEXT,
        active INTEGER NOT NULL DEFAULT 1
      )
    `)
    db.prepare(`
      INSERT INTO multitenancy_routing (user_id, profile_name, open_id, owner_open_id, provenance, kind, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`user-${OPENID}`, PROFILE, OPENID, OPENID, 'sync', 'user', 1)
  } finally {
    db.close()
  }
  return { dir, dbPath }
}

interface BrokerCall { method: string; url: string; ownerHeader: string | undefined; authorization: string | undefined; body: string }

function startStubBroker(): Promise<{ url: string; calls: BrokerCall[]; close: () => Promise<void> }> {
  const calls: BrokerCall[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      calls.push({
        method: req.method || '',
        url: req.url || '',
        ownerHeader: req.headers['x-hermes-owner-open-id'] as string | undefined,
        authorization: req.headers.authorization as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ from: 'stub-broker', path: req.url }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

async function startApp(env: Record<string, string>) {
  vi.resetModules()
  process.env = { ...originalEnv, ...env }

  const Koa = (await import('koa')).default
  const { bodyParser } = await import('@koa/bodyparser')
  const { trustedFeishuAuth, enforcePlaneAccess } = await import('../../packages/server/src/services/request-context')
  const { requireUserJwt, resolveUserProfile } = await import('../../packages/server/src/middleware/user-auth')
  const { kanbanRoutes } = await import('../../packages/server/src/routes/hermes/kanban')
  const { config } = await import('../../packages/server/src/config')

  const app = new Koa()
  app.use(bodyParser({ encoding: 'utf-8' }))
  // Exactly the fork's fork in index.ts: a Feishu auth mode gets the plane gate.
  const chain = config.authMode === 'trusted-feishu'
    ? [trustedFeishuAuth, enforcePlaneAccess]
    : [requireUserJwt, resolveUserProfile]
  chain.forEach(middleware => app.use(middleware as any))
  app.use(kanbanRoutes.routes())

  const server: Server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    webPlane: config.webPlane,
    close: () => new Promise<void>(done => server.close(() => done())),
  }
}

async function signedFeishuHeaders(): Promise<Record<string, string>> {
  const { signTrustedFeishuHeader } = await import('../../packages/server/src/services/request-context')
  const timestamp = String(Math.floor(Date.now() / 1000))
  return {
    'X-Feishu-OpenID': OPENID,
    'X-Hermes-Auth-Timestamp': timestamp,
    'X-Hermes-Auth-Signature': signTrustedFeishuHeader(OPENID, timestamp, TRUSTED_SECRET),
    'Content-Type': 'application/json',
  }
}

describe('kanban HTTP acceptance through the real auth chain', () => {
  let db = { dir: '', dbPath: '' }
  let broker: Awaited<ReturnType<typeof startStubBroker>>
  const running: Array<() => Promise<void>> = []

  beforeEach(async () => {
    vi.clearAllMocks()
    db = createRoutingDb()
    broker = await startStubBroker()
    mockEnsureWebUser.mockReturnValue({ id: 7, username: 'probe', role: 'user', profiles: [PROFILE] })
    usersStore.listUserProfiles.mockReturnValue([{ profile_name: PROFILE }])
  })

  afterEach(async () => {
    process.env = originalEnv
    for (const close of running.splice(0)) await close()
    await broker.close()
    if (db.dir) rmSync(db.dir, { recursive: true, force: true })
  })

  afterAll(() => { process.env = originalEnv })

  function chatPlaneEnv() {
    return {
      HERMES_AUTH_MODE: 'trusted-feishu',
      HERMES_TRUSTED_HEADER_SECRET: TRUSTED_SECRET,
      HERMES_WEB_PLANE: 'both',
      HERMES_WEBUI_RUN_BROKER: '1',
      HERMES_RUN_BROKER_URL: broker.url,
      HERMES_RUN_BROKER_KEY: 'broker-key',
      HERMES_MULTITENANCY_DB: db.dbPath,
      AUTH_JWT_SECRET: JWT_SECRET,
    }
  }

  async function chatPlaneApp() {
    const app = await startApp(chatPlaneEnv())
    running.push(app.close)
    return app
  }

  it('rejects an unauthenticated kanban request before any handler runs', async () => {
    const app = await chatPlaneApp()

    const res = await fetch(`${app.base}/api/hermes/kanban?board=default`)

    expect(res.status).toBe(401)
    expect(cli.listTasks).not.toHaveBeenCalled()
    expect(broker.calls).toHaveLength(0)
  })

  it('rejects forged trusted-feishu headers', async () => {
    const app = await chatPlaneApp()
    const timestamp = String(Math.floor(Date.now() / 1000))

    const res = await fetch(`${app.base}/api/hermes/kanban?board=default`, {
      headers: {
        'X-Feishu-OpenID': OPENID,
        'X-Hermes-Auth-Timestamp': timestamp,
        'X-Hermes-Auth-Signature': 'deadbeef',
      },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid trusted Feishu auth signature' })
    expect(cli.listTasks).not.toHaveBeenCalled()
  })

  // The structural fact the SPEC records: a Feishu auth mode IS the chat plane
  // (config.ts getEffectiveWebPlane), regardless of HERMES_WEB_PLANE.
  it('forces the chat plane from the auth mode even when HERMES_WEB_PLANE says both', async () => {
    const app = await chatPlaneApp()
    expect(app.webPlane).toBe('chat')
  })

  it('serves list, create and stats from the run-broker, not the local CLI', async () => {
    const app = await chatPlaneApp()
    const headers = await signedFeishuHeaders()

    const list = await fetch(`${app.base}/api/hermes/kanban?board=default`, { headers })
    const stats = await fetch(`${app.base}/api/hermes/kanban/stats?board=default`, { headers })
    const create = await fetch(`${app.base}/api/hermes/kanban?board=default`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'From the board' }),
    })

    expect([list.status, stats.status, create.status]).toEqual([200, 200, 200])
    expect(broker.calls.map(call => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'GET /api/run-broker/kanban/tasks',
      'GET /api/run-broker/kanban/stats',
      'POST /api/run-broker/kanban/tasks',
    ])
    expect(broker.calls[0].ownerHeader).toBe(OPENID)
    expect(broker.calls[0].authorization).toBe('Bearer broker-key')
    expect(cli.listTasks).not.toHaveBeenCalled()
    expect(cli.getStats).not.toHaveBeenCalled()
    expect(cli.createTask).not.toHaveBeenCalled()
  })

  // The other half of the same structural fact, and the one the earlier report
  // got wrong: the status writes have no broker branch at all.
  it('serves complete, block and unblock from the local CLI bridge in the chat plane', async () => {
    const app = await chatPlaneApp()
    const headers = await signedFeishuHeaders()
    const owned = {
      task: { id: 't_1', status: 'ready', assignee: PROFILE, created_by: PROFILE, tenant: OPENID },
      runs: [], comments: [], events: [],
    }
    cli.getTask.mockResolvedValue(owned)
    cli.completeTasks.mockResolvedValue(undefined)
    cli.blockTask.mockResolvedValue(undefined)
    cli.unblockTasks.mockResolvedValue(undefined)

    const complete = await fetch(`${app.base}/api/hermes/kanban/complete?board=default`, {
      method: 'POST', headers, body: JSON.stringify({ task_ids: ['t_1'] }),
    })
    const block = await fetch(`${app.base}/api/hermes/kanban/t_1/block?board=default`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'moved on the board' }),
    })
    const unblock = await fetch(`${app.base}/api/hermes/kanban/unblock?board=default`, {
      method: 'POST', headers, body: JSON.stringify({ task_ids: ['t_1'] }),
    })

    expect([complete.status, block.status, unblock.status]).toEqual([200, 200, 200])
    expect(cli.completeTasks).toHaveBeenCalledWith(['t_1'], undefined, { board: 'default', operatorOverride: true })
    expect(cli.blockTask).toHaveBeenCalledWith('t_1', 'moved on the board', { board: 'default' })
    expect(cli.unblockTasks).toHaveBeenCalledWith(['t_1'], { board: 'default' })
    // None of the three reached the broker.
    expect(broker.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  })

  // This is why the board must not drag through /tasks/bulk.
  it('403s the bulk endpoint in the chat plane before the controller sees it', async () => {
    const app = await chatPlaneApp()
    const headers = await signedFeishuHeaders()

    const res = await fetch(`${app.base}/api/hermes/kanban/tasks/bulk?board=default`, {
      method: 'POST', headers, body: JSON.stringify({ ids: ['t_1'], status: 'done' }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'This endpoint is not available in chat plane' })
    expect(cli.bulkUpdateTasks).not.toHaveBeenCalled()
  })

  it('403s the comment endpoint in the chat plane, so a drag cannot rely on it', async () => {
    const app = await chatPlaneApp()
    const headers = await signedFeishuHeaders()

    const res = await fetch(`${app.base}/api/hermes/kanban/t_1/comments?board=default`, {
      method: 'POST', headers, body: JSON.stringify({ body: 'hi' }),
    })

    expect(res.status).toBe(403)
    expect(cli.addComment).not.toHaveBeenCalled()
  })

  it('keeps every status write a chat-plane drag needs on the allowlist', async () => {
    const app = await chatPlaneApp()
    const headers = await signedFeishuHeaders()
    cli.getTask.mockResolvedValue({
      task: { id: 't_1', status: 'ready', assignee: PROFILE, created_by: PROFILE, tenant: OPENID },
      runs: [], comments: [], events: [],
    })
    cli.completeTasks.mockResolvedValue(undefined)
    cli.blockTask.mockResolvedValue(undefined)
    cli.unblockTasks.mockResolvedValue(undefined)

    const routes: Array<[string, unknown]> = [
      ['/api/hermes/kanban/complete', { task_ids: ['t_1'] }],
      ['/api/hermes/kanban/unblock', { task_ids: ['t_1'] }],
      ['/api/hermes/kanban/t_1/block', { reason: 'moved on the board' }],
    ]
    for (const [path, body] of routes) {
      const res = await fetch(`${app.base}${path}?board=default`, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      expect(res.status, path).not.toBe(403)
      expect(res.status, path).toBe(200)
    }
  })

  it('still refuses a status write on a task the caller does not own', async () => {
    const app = await chatPlaneApp()
    const headers = await signedFeishuHeaders()
    cli.getTask.mockResolvedValue({
      task: { id: 't_other', status: 'ready', assignee: 'someone_else', created_by: 'someone_else', tenant: 'ou_other' },
      runs: [], comments: [], events: [],
    })

    const res = await fetch(`${app.base}/api/hermes/kanban/complete?board=default`, {
      method: 'POST', headers, body: JSON.stringify({ task_ids: ['t_other'] }),
    })

    expect(res.status).toBe(403)
    expect(cli.completeTasks).not.toHaveBeenCalled()
  })

  it('401s a valid token-mode JWT because that auth mode carries no Feishu openid', async () => {
    const app = await startApp({
      HERMES_AUTH_MODE: 'token',
      HERMES_WEB_PLANE: 'both',
      HERMES_WEBUI_RUN_BROKER: '0',
      HERMES_MULTITENANCY_DB: db.dbPath,
      AUTH_JWT_SECRET: JWT_SECRET,
    })
    running.push(app.close)
    expect(app.webPlane).toBe('both')

    const { signUserJwt } = await import('../../packages/server/src/middleware/user-auth')
    usersStore.findUserById.mockReturnValue({ id: 7, username: 'probe', role: 'user', status: 'active' })
    const token = signUserJwt({ id: 7, username: 'probe', role: 'user' } as any, JWT_SECRET)

    const res = await fetch(`${app.base}/api/hermes/kanban?board=default`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    // The JWT itself is accepted — findUserById ran — but ctx.state.user has no
    // openid, and every kanban controller starts with requireOpenId.
    expect(usersStore.findUserById).toHaveBeenCalledWith('7')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(cli.listTasks).not.toHaveBeenCalled()
  })
})
