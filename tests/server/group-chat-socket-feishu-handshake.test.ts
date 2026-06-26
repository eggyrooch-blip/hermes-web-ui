import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'http'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import type { AddressInfo } from 'net'

// Integration-level SIM for `groupchat-socket-feishu-auth`: boot the REAL
// GroupChatServer on a real HTTP server and prove, over a real Socket.IO
// network handshake, that:
//   1. a validly-signed `hermes_feishu_session` cookie connects (connected=true)
//      — the user-facing path that was broken;
//   2. a handshake with no credentials gets `connect_error: Unauthorized`
//      — the exact symptom Feishu users hit.
//
// The cookie parsing and the authMiddleware wiring are exercised for real; only
// the DB-backed openid→user-store bridge (ensureWebUserForFeishu) is stubbed, so
// the test needs no multitenancy DB. This is the machine half of the Karpathy
// gate; the remaining human half is a real Feishu browser session (httpOnly
// cookie unreadable by automation).

const FEISHU_SECRET = 'feishu-int-secret'

describe('group-chat socket Feishu-cookie handshake (integration)', () => {
  let db: any = null
  let httpServer: HttpServer | null = null
  let chatServer: any = null
  let client: ClientSocket | null = null
  let port = 0

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-jwt-secret')
    vi.stubEnv('FEISHU_SESSION_SECRET', FEISHU_SECRET)

    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    // Stub the DB bridge so we don't need the multitenancy routing DB; the cookie
    // parse + socket wiring under test are still fully real.
    vi.doMock('../../packages/server/src/services/compat-user', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>()
      return {
        ...actual,
        ensureWebUserForFeishu: vi.fn((openid: string) => ({
          id: 101,
          username: `feishu:${openid}`,
          role: 'user',
          profiles: [],
        })),
      }
    })

    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')

    httpServer = createServer()
    chatServer = new GroupChatServer(httpServer)
    await new Promise<void>((res) => httpServer!.listen(0, '127.0.0.1', res))
    port = (httpServer!.address() as AddressInfo).port
  })

  afterEach(() => {
    client?.close()
    chatServer?.getIO?.().close()
    httpServer?.close()
    db?.close()
    client = null
    chatServer = null
    httpServer = null
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.doUnmock('../../packages/server/src/services/compat-user')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  function connect(opts: { cookie?: string }): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      client = ioClient(`http://127.0.0.1:${port}/group-chat`, {
        transports: ['polling', 'websocket'],
        reconnection: false,
        timeout: 4000,
        ...(opts.cookie ? { extraHeaders: { Cookie: opts.cookie } } : {}),
        auth: { userId: 'u-int-1' },
      })
      client.on('connect', () => resolve({ ok: true }))
      client.on('connect_error', (err) => resolve({ ok: false, error: err.message }))
    })
  }

  it('connects a Feishu user authenticated solely by the session cookie', async () => {
    const feishu = await import('../../packages/server/src/services/feishu-oauth')
    const cookieValue = feishu.createFeishuSessionCookie({
      openid: 'ou_integration',
      profile: 'researcher',
      secret: FEISHU_SECRET,
      maxAgeSeconds: 3600,
    })

    const result = await connect({ cookie: `${feishu.FEISHU_SESSION_COOKIE}=${cookieValue}` })

    expect(result).toEqual({ ok: true })
    expect(client?.connected).toBe(true)
  })

  it('rejects a handshake that carries neither token nor Feishu cookie (the bug symptom)', async () => {
    const result = await connect({})

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Unauthorized')
  })

  it('rejects a tampered Feishu session cookie over the real handshake', async () => {
    const feishu = await import('../../packages/server/src/services/feishu-oauth')
    const cookieValue = feishu.createFeishuSessionCookie({
      openid: 'ou_integration',
      profile: 'researcher',
      secret: FEISHU_SECRET,
      maxAgeSeconds: 3600,
    })

    const result = await connect({ cookie: `${feishu.FEISHU_SESSION_COOKIE}=${cookieValue}TAMPER` })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Unauthorized')
  })
})
