import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Koa with `app.proxy = true` resolves ctx.ip from X-Forwarded-For. These mock
// contexts mirror that: `ctx.ip` is whatever the client put in XFF, while
// `ctx.req.socket.remoteAddress` is the real TCP peer.
function makeCtx(opts: {
  socket: string
  xff?: string
  body?: Record<string, unknown>
  user?: { id: number } | null
}) {
  const headers: Record<string, string> = {}
  if (opts.xff) headers['x-forwarded-for'] = opts.xff
  const ip = opts.xff ? opts.xff.split(',')[0].trim() : opts.socket
  return {
    request: { body: opts.body ?? {}, ip },
    headers,
    query: {},
    ip,
    state: opts.user ? { user: opts.user } : {},
    status: 200,
    body: null as any,
    get: vi.fn((name: string) => headers[name.toLowerCase()] || ''),
    set: vi.fn(),
    req: { socket: { remoteAddress: opts.socket } },
  } as any
}

describe('first-login hardening and proxy trust', () => {
  let db: any = null
  let home = ''

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    home = mkdtempSync(join(tmpdir(), 'hermes-first-login-'))
    vi.stubEnv('HERMES_WEB_UI_HOME', home)
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    vi.stubEnv('HERMES_BOOTSTRAP_ALLOW_REMOTE', '')
    vi.stubEnv('HERMES_DESKTOP', '')

    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.unstubAllEnvs()
    vi.resetModules()
    rmSync(home, { recursive: true, force: true })
  })

  async function load() {
    return {
      ctrl: await import('../../packages/server/src/controllers/auth'),
      users: await import('../../packages/server/src/db/hermes/users-store'),
      auth: await import('../../packages/server/src/middleware/user-auth'),
      limiter: await import('../../packages/server/src/services/login-limiter'),
    }
  }

  const defaultCreds = { username: 'admin', password: '123456' }

  describe('empty user store bootstrap', () => {
    it('rejects default-credential bootstrap from a non-loopback socket', async () => {
      const { ctrl, users } = await load()
      const ctx = makeCtx({ socket: '10.0.0.9', body: defaultCreds })

      await ctrl.login(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Invalid username or password' })
      expect(users.countUsers()).toBe(0)
    })

    it('rejects remote bootstrap even when X-Forwarded-For claims loopback', async () => {
      const { ctrl, users } = await load()
      const ctx = makeCtx({ socket: '10.0.0.9', xff: '127.0.0.1', body: defaultCreds })

      await ctrl.login(ctx)

      expect(ctx.status).toBe(401)
      expect(users.countUsers()).toBe(0)
    })

    it('counts a rejected remote bootstrap as a password failure for the socket ip', async () => {
      const { ctrl, limiter } = await load()
      for (let i = 0; i < 10; i++) {
        await ctrl.login(makeCtx({ socket: '10.0.0.9', body: defaultCreds }))
      }
      expect(limiter.getLockedIps().map(entry => entry.ip)).toContain('10.0.0.9')
    })

    it('logs one operator hint per remote ip when bootstrap is refused', async () => {
      const { ctrl } = await load()
      const { logger } = await import('../../packages/server/src/services/logger')
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
      const bootstrapWarns = () => warn.mock.calls.filter(call =>
        String(call[1] ?? call[0]).includes('HERMES_BOOTSTRAP_ALLOW_REMOTE'))

      const first = makeCtx({ socket: '172.17.0.1', body: defaultCreds })
      await ctrl.login(first)
      expect(first.status).toBe(401)
      expect(bootstrapWarns()).toHaveLength(1)
      expect(bootstrapWarns()[0][0]).toMatchObject({ remoteAddress: '172.17.0.1' })

      const second = makeCtx({ socket: '172.17.0.1', body: defaultCreds })
      await ctrl.login(second)
      expect(second.status).toBe(401)
      expect(bootstrapWarns()).toHaveLength(1)

      await ctrl.login(makeCtx({ socket: '172.17.0.2', body: defaultCreds }))
      expect(bootstrapWarns()).toHaveLength(2)
      expect(bootstrapWarns()[1][0]).toMatchObject({ remoteAddress: '172.17.0.2' })
    })

    it('does not log the bootstrap hint for a loopback first login', async () => {
      const { ctrl } = await load()
      const { logger } = await import('../../packages/server/src/services/logger')
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any)

      await ctrl.login(makeCtx({ socket: '127.0.0.1', body: defaultCreds }))

      expect(warn.mock.calls.some(call => String(call[1] ?? call[0]).includes('HERMES_BOOTSTRAP_ALLOW_REMOTE'))).toBe(false)
    })

    it('bootstraps super_admin from a loopback socket', async () => {
      const { ctrl, users } = await load()
      const ctx = makeCtx({ socket: '127.0.0.1', body: defaultCreds })

      await ctrl.login(ctx)

      expect(ctx.status).toBe(200)
      expect(typeof ctx.body?.token).toBe('string')
      expect(users.countUsers()).toBe(1)
      expect(users.findUserByUsername('admin')?.role).toBe('super_admin')
    })

    it('treats an IPv4-mapped loopback socket as loopback', async () => {
      const { ctrl, users } = await load()
      const ctx = makeCtx({ socket: '::ffff:127.0.0.1', body: defaultCreds })

      await ctrl.login(ctx)

      expect(ctx.status).toBe(200)
      expect(users.countUsers()).toBe(1)
    })

    it('allows remote bootstrap when HERMES_BOOTSTRAP_ALLOW_REMOTE=1', async () => {
      vi.stubEnv('HERMES_BOOTSTRAP_ALLOW_REMOTE', '1')
      const { ctrl, users } = await load()
      const ctx = makeCtx({ socket: '10.0.0.9', body: defaultCreds })

      await ctrl.login(ctx)

      expect(ctx.status).toBe(200)
      expect(users.findUserByUsername('admin')?.role).toBe('super_admin')
    })
  })

  describe('requiresCredentialChange is server-authoritative', () => {
    async function me(ctrl: any, userId: number) {
      const ctx = makeCtx({ socket: '127.0.0.1', user: { id: userId } })
      await ctrl.currentUser(ctx)
      expect(ctx.status).toBe(200)
      return ctx.body.user.requiresCredentialChange
    }

    it('is true while the default password is in use and false after change', async () => {
      const { ctrl, users } = await load()
      await ctrl.login(makeCtx({ socket: '127.0.0.1', body: defaultCreds }))
      const admin = users.findUserByUsername('admin')!

      expect(await me(ctrl, admin.id)).toBe(true)

      const change = makeCtx({
        socket: '127.0.0.1',
        user: { id: admin.id },
        body: { currentPassword: '123456', newPassword: 'n3w-strong-pass' },
      })
      await ctrl.changePassword(change)
      expect(change.body).toEqual({ success: true })

      expect(await me(ctrl, admin.id)).toBe(false)
    })

    it('does not depend on HERMES_DESKTOP', async () => {
      vi.stubEnv('HERMES_DESKTOP', 'true')
      const { ctrl, users } = await load()
      await ctrl.login(makeCtx({ socket: '127.0.0.1', body: defaultCreds }))
      const admin = users.findUserByUsername('admin')!

      expect(await me(ctrl, admin.id)).toBe(true)

      users.updateUserPassword(admin.id, 'n3w-strong-pass')
      expect(await me(ctrl, admin.id)).toBe(false)
    })
  })

  describe('login limiter ip extraction', () => {
    it('locks a direct client after 10 failures even when XFF rotates every attempt', async () => {
      const { ctrl, users } = await load()
      users.createUser({ username: 'ops', password: 'secret123', role: 'admin', profiles: ['default'] } as any)

      const statuses: number[] = []
      for (let i = 1; i <= 11; i++) {
        const ctx = makeCtx({
          socket: '10.0.0.9',
          xff: `198.51.100.${i}`,
          body: { username: 'ops', password: 'wrong' },
        })
        await ctrl.login(ctx)
        statuses.push(ctx.status)
      }

      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
      expect(statuses[10]).toBe(429)
    })

    it('ignores XFF when the socket is not loopback', async () => {
      const { limiter } = await load()
      expect(limiter.extractIp(makeCtx({ socket: '10.0.0.9', xff: '203.0.113.5' }))).toBe('10.0.0.9')
      expect(limiter.extractIp(makeCtx({ socket: '::ffff:10.0.0.9', xff: '127.0.0.1' }))).toBe('10.0.0.9')
    })

    it('uses the forwarded client ip when the socket is a loopback proxy', async () => {
      const { ctrl, users, limiter } = await load()
      expect(limiter.extractIp(makeCtx({ socket: '127.0.0.1', xff: '203.0.113.5' }))).toBe('203.0.113.5')

      users.createUser({ username: 'ops', password: 'secret123', role: 'admin', profiles: ['default'] } as any)
      for (let i = 0; i < 10; i++) {
        await ctrl.login(makeCtx({ socket: '127.0.0.1', xff: '203.0.113.5', body: { username: 'ops', password: 'wrong' } }))
      }
      const locked = makeCtx({ socket: '127.0.0.1', xff: '203.0.113.5', body: { username: 'ops', password: 'secret123' } })
      await ctrl.login(locked)
      expect(locked.status).toBe(429)

      const other = makeCtx({ socket: '127.0.0.1', xff: '203.0.113.6', body: { username: 'ops', password: 'secret123' } })
      await ctrl.login(other)
      expect(other.status).toBe(200)
    })

    it('returns unknown when neither socket nor ctx ip is available', async () => {
      const { limiter } = await load()
      const ctx = makeCtx({ socket: '' })
      ctx.ip = ''
      ctx.request.ip = ''
      ctx.req.socket.remoteAddress = undefined
      expect(limiter.extractIp(ctx)).toBe('unknown')
    })
  })

  describe('isLoopbackRequest', () => {
    it('is false for a remote socket with a forged loopback XFF', async () => {
      const { auth } = await load()
      expect(auth.isLoopbackRequest(makeCtx({ socket: '10.0.0.9', xff: '127.0.0.1' }))).toBe(false)
    })

    it('is true for loopback sockets', async () => {
      const { auth } = await load()
      expect(auth.isLoopbackRequest(makeCtx({ socket: '127.0.0.1' }))).toBe(true)
      expect(auth.isLoopbackRequest(makeCtx({ socket: '::1' }))).toBe(true)
      expect(auth.isLoopbackRequest(makeCtx({ socket: '::ffff:127.0.0.1', xff: '203.0.113.5' }))).toBe(true)
    })
  })
})
