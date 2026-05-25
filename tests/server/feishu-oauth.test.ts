import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

describe('Feishu OAuth session helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('round-trips a signed session cookie and rejects tampering', async () => {
    const {
      createFeishuSessionCookie,
      parseFeishuSessionCookie,
    } = await import('../../packages/server/src/services/feishu-oauth')

    const cookie = createFeishuSessionCookie({
      openid: 'ou_test',
      profile: 'researcher',
      name: '张三',
      avatarUrl: 'https://example.com/avatar.png',
      secret: 'session-secret',
      now: 1_700_000_000,
      maxAgeSeconds: 3600,
    })

    expect(parseFeishuSessionCookie(cookie, {
      secret: 'session-secret',
      now: 1_700_000_100,
    })).toEqual({
      openid: 'ou_test',
      profile: 'researcher',
      role: 'user',
      name: '张三',
      avatarUrl: 'https://example.com/avatar.png',
    })

    expect(parseFeishuSessionCookie(`${cookie}x`, {
      secret: 'session-secret',
      now: 1_700_000_100,
    })).toBeNull()
  })

  it('rejects expired session cookies', async () => {
    const {
      createFeishuSessionCookie,
      parseFeishuSessionCookie,
    } = await import('../../packages/server/src/services/feishu-oauth')

    const cookie = createFeishuSessionCookie({
      openid: 'ou_test',
      profile: 'researcher',
      secret: 'session-secret',
      now: 1_700_000_000,
      maxAgeSeconds: 60,
    })

    expect(parseFeishuSessionCookie(cookie, {
      secret: 'session-secret',
      now: 1_700_000_061,
    })).toBeNull()
  })

  it('rejects an authenticated cookie whose profile is not the required canonical profile', async () => {
    process.env.FEISHU_SESSION_SECRET = 'session-secret'
    process.env.HERMES_REQUIRED_PROFILE = 'user_a'
    vi.resetModules()
    const {
      createFeishuSessionCookie,
      feishuOAuthAuth,
    } = await import('../../packages/server/src/services/feishu-oauth')

    const cookie = createFeishuSessionCookie({
      openid: 'ou_test',
      profile: 'feishu_user_a',
      secret: 'session-secret',
      now: Math.floor(Date.now() / 1000),
      maxAgeSeconds: 3600,
    })
    const ctx: any = {
      path: '/api/auth/me',
      state: {},
      cookies: { get: vi.fn().mockReturnValue(cookie) },
      set: vi.fn(),
    }
    const next = vi.fn()

    await feishuOAuthAuth(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('builds the Feishu authorize URL with app id, redirect uri, and state', async () => {
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_REDIRECT_URI = 'http://localhost:8648/api/auth/feishu/callback'

    const { buildFeishuAuthorizeUrl } = await import('../../packages/server/src/services/feishu-oauth')

    const url = new URL(buildFeishuAuthorizeUrl('state-token'))
    expect(url.origin + url.pathname).toBe('https://open.feishu.cn/open-apis/authen/v1/index')
    expect(url.searchParams.get('app_id')).toBe('cli_test')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8648/api/auth/feishu/callback')
    expect(url.searchParams.get('state')).toBe('state-token')
  })

  it('fills missing profile metadata from Feishu user_info after exchanging code', async () => {
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'app-secret'
    process.env.FEISHU_API_BASE_URL = 'https://feishu.test'
    vi.resetModules()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        app_access_token: 'app-token',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: {
          open_id: 'ou_test',
          access_token: 'user-token',
          name: 'Token Name',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: {
          open_id: 'ou_test',
          name: 'User Info Name',
          avatar_url: 'https://example.com/avatar.png',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const { exchangeFeishuCode } = await import('../../packages/server/src/services/feishu-oauth')

    await expect(exchangeFeishuCode('oauth-code')).resolves.toMatchObject({
      openid: 'ou_test',
      accessToken: 'user-token',
      name: 'Token Name',
      avatarUrl: 'https://example.com/avatar.png',
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://feishu.test/open-apis/authen/v1/user_info',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer user-token' }),
      }),
    )
  })
})

describe('Feishu OAuth controller', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env = { ...originalEnv }
    process.env.HERMES_AUTH_MODE = 'feishu-oauth-dev'
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'app-secret'
    process.env.FEISHU_REDIRECT_URI = 'http://localhost:8648/api/auth/feishu/callback'
    process.env.FEISHU_SESSION_SECRET = 'session-secret'
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('redirects login to Feishu and stores a signed state cookie', async () => {
    const { feishuLogin } = await import('../../packages/server/src/controllers/auth')
    const setCookie = vi.fn()
    const redirect = vi.fn()
    const ctx: any = {
      cookies: { set: setCookie },
      redirect,
    }

    await feishuLogin(ctx)

    expect(setCookie).toHaveBeenCalledWith('hermes_feishu_state', expect.any(String), expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
    }))
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('https://open.feishu.cn/open-apis/authen/v1/index'))
  })

  it('canonicalizes Feishu login to the configured redirect origin before setting state', async () => {
    const { feishuLogin } = await import('../../packages/server/src/controllers/auth')
    const setCookie = vi.fn()
    const redirect = vi.fn()
    const ctx: any = {
      origin: 'http://127.0.0.1:8648',
      path: '/api/auth/feishu/login',
      search: '',
      cookies: { set: setCookie },
      get: vi.fn().mockReturnValue(''),
      redirect,
    }

    await feishuLogin(ctx)

    expect(setCookie).not.toHaveBeenCalled()
    expect(redirect).toHaveBeenCalledWith('http://localhost:8648/api/auth/feishu/login')
  })

  it('does not canonicalize proxied Feishu login requests that already match the configured redirect origin', async () => {
    process.env.FEISHU_REDIRECT_URI = 'https://hermes.example.com/api/auth/feishu/callback'
    vi.resetModules()
    const { feishuLogin } = await import('../../packages/server/src/controllers/auth')
    const setCookie = vi.fn()
    const redirect = vi.fn()
    const ctx: any = {
      origin: 'http://127.0.0.1:8648',
      path: '/api/auth/feishu/login',
      search: '',
      protocol: 'http',
      secure: false,
      cookies: { set: setCookie },
      get: vi.fn((name: string) => {
        const headers: Record<string, string> = {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'hermes.example.com',
        }
        return headers[name.toLowerCase()] || ''
      }),
      redirect,
    }

    await feishuLogin(ctx)

    expect(setCookie).toHaveBeenCalledWith('hermes_feishu_state', expect.any(String), expect.objectContaining({
      secure: true,
    }))
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('https://open.feishu.cn/open-apis/authen/v1/index'))
    expect(redirect).not.toHaveBeenCalledWith('https://hermes.example.com/api/auth/feishu/login')
  })

  it('rejects callback when state does not match the state cookie', async () => {
    const { feishuCallback } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      query: { code: 'code', state: 'bad-state' },
      cookies: { get: vi.fn().mockReturnValue('other-state'), set: vi.fn() },
    }

    await feishuCallback(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Invalid Feishu OAuth state' })
  })

  it('returns the authenticated Feishu user context', async () => {
    const { currentUser } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      state: {
        user: {
          id: 'ou_test',
          username: '张三',
          openid: 'ou_test',
          profile: 'researcher',
          role: 'user',
          name: '张三',
          avatarUrl: 'https://example.com/avatar.png',
          profiles: ['researcher', 'feishu_group_alpha'],
        },
      },
    }

    await currentUser(ctx)

    expect(ctx.body).toMatchObject({
      openid: 'ou_test',
      profile: 'researcher',
      role: 'user',
      name: '张三',
      avatarUrl: 'https://example.com/avatar.png',
      user: {
        id: 'ou_test',
        username: '张三',
        openid: 'ou_test',
        profile: 'researcher',
        role: 'user',
        status: 'active',
        profiles: ['researcher', 'feishu_group_alpha'],
        requiresCredentialChange: false,
      },
    })
  })

  it('wakes the bound profile gateway after OAuth login when it is stopped', async () => {
    const gatewayManager = {
      detectStatus: vi.fn().mockResolvedValue({ profile: 'feishu_user_a', running: false }),
      startApiOnly: vi.fn().mockResolvedValue({ profile: 'feishu_user_a', running: true }),
    }
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => gatewayManager,
    }))

    const { wakeBoundProfileGateway } = await import('../../packages/server/src/controllers/auth')

    await wakeBoundProfileGateway('feishu_user_a')

    expect(gatewayManager.detectStatus).toHaveBeenCalledWith('feishu_user_a')
    expect(gatewayManager.startApiOnly).toHaveBeenCalledWith('feishu_user_a')
  })

  it('keeps Feishu logout public so it can always clear the session cookie', async () => {
    const { authPublicRoutes, authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    const hasLogout = (route: any) => route.path === '/api/auth/feishu/logout' && route.methods.includes('POST')

    expect(authPublicRoutes.stack.some(hasLogout)).toBe(true)
    expect(authProtectedRoutes.stack.some(hasLogout)).toBe(false)
  })

  it('proxies Feishu UAT status with the authenticated server-side user identity', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-secret'
    vi.resetModules()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'valid',
      profile_name: 'user_a',
      subject_id: 'ou_user_a',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { feishuUatStatus } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      state: { user: { profile: 'user_a', openid: 'ou_user_a', role: 'user' } },
      query: { profile_name: 'attacker', user_key: 'ou_attacker', required_scopes: 'wiki:wiki:readonly' },
    }

    await feishuUatStatus(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.status).toBe('valid')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://broker.test/api/run-broker/credentials/feishu/uat/status?profile_name=user_a&user_key=ou_user_a&required_scopes=wiki%3Awiki%3Areadonly')
    expect(init.headers.Authorization).toBe('Bearer broker-secret')
  })

  it('starts Feishu UAT auth through the broker without trusting browser identity fields', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-secret'
    vi.resetModules()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'pending',
      session_id: 'sess-1',
      verification_uri: 'https://accounts.feishu.cn/device',
      user_code: 'ABCD-1234',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { feishuUatStart } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      state: { user: { profile: 'user_a', openid: 'ou_user_a', role: 'user' } },
      request: { body: { profile_name: 'attacker', user_key: 'ou_attacker', scope: 'wiki:wiki:readonly' } },
    }

    await feishuUatStart(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.session_id).toBe('sess-1')
    const [_url, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      profile_name: 'user_a',
      user_key: 'ou_user_a',
      scope: 'wiki:wiki:readonly',
    })
  })

  it('keeps Feishu UAT and skill credential routes protected behind WebUI authentication', async () => {
    const { authPublicRoutes, authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    const protectedPaths = new Set(authProtectedRoutes.stack.map((route: any) => route.path))
    const publicPaths = new Set(authPublicRoutes.stack.map((route: any) => route.path))

    expect(protectedPaths.has('/api/auth/feishu/uat/status')).toBe(true)
    expect(protectedPaths.has('/api/auth/feishu/uat/start')).toBe(true)
    expect(protectedPaths.has('/api/auth/feishu/uat/sessions/:sessionId')).toBe(true)
    expect(protectedPaths.has('/api/auth/skill-credentials')).toBe(true)
    expect(protectedPaths.has('/api/auth/skill-credentials/:id/start')).toBe(true)
    expect(protectedPaths.has('/api/auth/skill-credentials/:id/complete')).toBe(true)
    expect(publicPaths.has('/api/auth/feishu/uat/status')).toBe(false)
    expect(publicPaths.has('/api/auth/feishu/uat/start')).toBe(false)
    expect(publicPaths.has('/api/auth/skill-credentials')).toBe(false)
  })
})
