import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: loggerMocks,
  bridgeLogger: loggerMocks,
}))

vi.mock('../../packages/server/src/services/compat-user', () => ({
  ensureWebUserForFeishu: vi.fn((openid: string) => ({ id: 1, username: openid, profiles: [] })),
}))

const SECRET = 'session-secret'
const DAY = 24 * 60 * 60
const THIRTY_DAYS = 30 * DAY

const originalEnv = process.env

async function loadModule() {
  return import('../../packages/server/src/services/feishu-oauth')
}

/** Minimal Koa-ish context: only what feishuOAuthAuth actually touches. */
function makeCtx(cookieValue?: string) {
  const setCookies: Array<{ name: string; value: string; opts: any }> = []
  return {
    setCookies,
    path: '/api/auth/me',
    protocol: 'https',
    secure: true,
    headers: { 'user-agent': 'vitest-ua' },
    status: 200,
    body: undefined as unknown,
    state: {} as Record<string, unknown>,
    get: () => '',
    set: () => { },
    cookies: {
      get: () => cookieValue,
      set: (name: string, value: string, opts: any) => { setCookies.push({ name, value, opts }) },
    },
  }
}

describe('Feishu session persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    loggerMocks.warn.mockClear()
    process.env = { ...originalEnv }
    delete process.env.FEISHU_SESSION_MAX_AGE_SECONDS
    process.env.FEISHU_SESSION_SECRET = SECRET
    process.env.HERMES_REQUIRED_PROFILE = ''
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('defaults the session TTL to 30 days', async () => {
    const { config } = await import('../../packages/server/src/config')
    expect(config.feishuSessionMaxAgeSeconds).toBe(THIRTY_DAYS)

    const { createFeishuSessionCookie, parseFeishuSession } = await loadModule()
    const now = 1_700_000_000
    const cookie = createFeishuSessionCookie({ openid: 'ou_a', profile: 'p', secret: SECRET, now })
    expect(parseFeishuSession(cookie, { secret: SECRET, now }).exp).toBe(now + THIRTY_DAYS)
  })

  it('honours FEISHU_SESSION_MAX_AGE_SECONDS overrides', async () => {
    process.env.FEISHU_SESSION_MAX_AGE_SECONDS = '3600'
    const { config } = await import('../../packages/server/src/config')
    expect(config.feishuSessionMaxAgeSeconds).toBe(3600)
  })

  it('round-trips a valid cookie', async () => {
    const { createFeishuSessionCookie, parseFeishuSession } = await loadModule()
    const now = 1_700_000_000
    const cookie = createFeishuSessionCookie({
      openid: 'ou_a',
      profile: 'researcher',
      userId: 'u_a',
      email: 'a@example.test',
      name: '孙可',
      secret: SECRET,
      now,
    })
    const parsed = parseFeishuSession(cookie, { secret: SECRET, now: now + 60 })
    expect(parsed.reason).toBeUndefined()
    expect(parsed.user).toEqual({
      openid: 'ou_a',
      profile: 'researcher',
      role: 'user',
      userId: 'u_a',
      email: 'a@example.test',
      name: '孙可',
    })
  })

  it('classifies rejection reasons', async () => {
    const { createFeishuSessionCookie, parseFeishuSession } = await loadModule()
    const now = 1_700_000_000
    const cookie = createFeishuSessionCookie({
      openid: 'ou_a', profile: 'p', secret: SECRET, now, maxAgeSeconds: 3600,
    })

    expect(parseFeishuSession(undefined, { secret: SECRET, now })).toEqual({ user: null, reason: 'no-cookie' })
    expect(parseFeishuSession('', { secret: SECRET, now })).toEqual({ user: null, reason: 'no-cookie' })
    expect(parseFeishuSession(cookie, { secret: SECRET, now: now + 7200 })).toMatchObject({
      user: null,
      reason: 'expired',
    })
    expect(parseFeishuSession(`${cookie}x`, { secret: SECRET, now })).toEqual({ user: null, reason: 'bad-signature' })
    expect(parseFeishuSession(cookie, { secret: 'other-secret', now })).toEqual({ user: null, reason: 'bad-signature' })
    expect(parseFeishuSession('garbage', { secret: SECRET, now })).toEqual({ user: null, reason: 'bad-signature' })
  })

  it('keeps parseFeishuSessionCookie returning the bare WebUser', async () => {
    const { createFeishuSessionCookie, parseFeishuSessionCookie } = await loadModule()
    const now = 1_700_000_000
    const cookie = createFeishuSessionCookie({ openid: 'ou_a', profile: 'p', secret: SECRET, now })
    expect(parseFeishuSessionCookie(cookie, { secret: SECRET, now })).toEqual({
      openid: 'ou_a', profile: 'p', role: 'user',
    })
    expect(parseFeishuSessionCookie(undefined, { secret: SECRET, now })).toBeNull()
  })

  it('slides the expiry for a cookie older than a day', async () => {
    const m = await loadModule()
    const now = Math.floor(Date.now() / 1000)
    // Signed 2 days ago under the 30-day TTL → 28 days of life left.
    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_a', profile: 'p', name: '孙可', secret: SECRET, now: now - 2 * DAY,
    })
    const ctx = makeCtx(cookie)
    await m.feishuOAuthAuth(ctx as any, async () => { })

    expect(ctx.status).toBe(200)
    const renewal = ctx.setCookies.find(c => c.name === m.FEISHU_SESSION_COOKIE)
    expect(renewal).toBeTruthy()
    expect(renewal!.opts).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      overwrite: true,
      maxAge: THIRTY_DAYS * 1000,
    })
    const reissued = m.parseFeishuSession(renewal!.value, { secret: SECRET, now })
    expect(reissued.user).toMatchObject({ openid: 'ou_a', profile: 'p', name: '孙可' })
    expect(reissued.exp! - (now + THIRTY_DAYS)).toBeLessThanOrEqual(2)
  })

  it('does not re-sign a cookie younger than a day', async () => {
    const m = await loadModule()
    const now = Math.floor(Date.now() / 1000)
    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_a', profile: 'p', secret: SECRET, now: now - 60,
    })
    const ctx = makeCtx(cookie)
    await m.feishuOAuthAuth(ctx as any, async () => { })

    expect(ctx.status).toBe(200)
    expect(ctx.setCookies).toHaveLength(0)
  })

  it('logs the rejection reason on 401', async () => {
    const m = await loadModule()
    const now = Math.floor(Date.now() / 1000)
    const expired = m.createFeishuSessionCookie({
      openid: 'ou_a', profile: 'p', secret: SECRET, now: now - 7200, maxAgeSeconds: 3600,
    })

    for (const [cookie, reason] of [[undefined, 'no-cookie'], [expired, 'expired'], ['x.y', 'bad-signature']] as const) {
      loggerMocks.warn.mockClear()
      const ctx = makeCtx(cookie)
      await m.feishuOAuthAuth(ctx as any, async () => { throw new Error('next must not run') })
      expect(ctx.status).toBe(401)
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        { reason, path: '/api/auth/me', ua: 'vitest-ua' },
        'Feishu session rejected',
      )
    }
  })
})
