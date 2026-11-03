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

  it('preserves canonical Feishu principal fields in the signed session cookie', async () => {
    const {
      createFeishuSessionCookie,
      parseFeishuSessionCookie,
    } = await import('../../packages/server/src/services/feishu-oauth')

    const cookie = createFeishuSessionCookie({
      openid: 'ou_test',
      userId: 'u_test',
      tenantKey: 'tenant_a',
      appId: 'cli_test',
      email: 'user@example.test',
      profile: 'researcher',
      secret: 'session-secret',
      now: 1_700_000_000,
      maxAgeSeconds: 3600,
    })

    expect(parseFeishuSessionCookie(cookie, {
      secret: 'session-secret',
      now: 1_700_000_100,
    })).toMatchObject({
      openid: 'ou_test',
      userId: 'u_test',
      tenantKey: 'tenant_a',
      appId: 'cli_test',
      email: 'user@example.test',
    })
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

  it('builds the Feishu authorize URL with app id, redirect uri, state, and broker scope', async () => {
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_REDIRECT_URI = 'http://localhost:8648/api/auth/feishu/callback'

    const { buildFeishuAuthorizeUrl } = await import('../../packages/server/src/services/feishu-oauth')

    const url = new URL(buildFeishuAuthorizeUrl('state-token', 'im:message offline_access'))
    expect(url.origin + url.pathname).toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize')
    expect(url.searchParams.get('client_id')).toBe('cli_test')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8648/api/auth/feishu/callback')
    expect(url.searchParams.get('state')).toBe('state-token')
    expect(url.searchParams.get('scope')).toBe('im:message offline_access')
  })

  it('fills missing profile metadata from Feishu user_info after exchanging code', async () => {
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'app-secret'
    process.env.FEISHU_API_BASE_URL = 'https://feishu.test'
    vi.resetModules()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'user-token',
        refresh_token: 'refresh-token',
        expires_in: 7200,
        refresh_token_expires_in: 2592000,
        scope: 'im:message offline_access',
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
      refreshToken: 'refresh-token',
      expiresIn: 7200,
      refreshTokenExpiresIn: 2592000,
      scope: 'im:message offline_access',
      name: 'User Info Name',
      avatarUrl: 'https://example.com/avatar.png',
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://feishu.test/open-apis/authen/v1/user_info',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer user-token' }),
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://accounts.feishu.cn/oauth/v3/token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('fetches Feishu user_info when token data lacks canonical principal fields', async () => {
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'app-secret'
    process.env.FEISHU_API_BASE_URL = 'https://feishu.test'
    vi.resetModules()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        access_token: 'user-token',
        expires_in: 7200,
        scope: 'auth:user.id:read',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: {
          open_id: 'ou_test',
          user_id: 'u_test',
          union_id: 'on_test',
          tenant_key: 'tenant_a',
          enterprise_email: 'user@example.test',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const { exchangeFeishuCode } = await import('../../packages/server/src/services/feishu-oauth')

    await expect(exchangeFeishuCode('oauth-code')).resolves.toMatchObject({
      openid: 'ou_test',
      userId: 'u_test',
      unionId: 'on_test',
      tenantKey: 'tenant_a',
      appId: 'cli_test',
      email: 'user@example.test',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the v3 token cannot be live-bound to a Feishu user', async () => {
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'app-secret'
    process.env.FEISHU_API_BASE_URL = 'https://feishu.test'
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        access_token: 'user-token',
        expires_in: 7200,
        scope: 'auth:user.id:read',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })))
    const { exchangeFeishuCode } = await import('../../packages/server/src/services/feishu-oauth')

    await expect(exchangeFeishuCode('oauth-code')).rejects.toThrow('verify Feishu OAuth user')
  })
})

describe('Feishu OAuth controller login/UAT merge', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = {
      ...originalEnv,
      HERMES_AUTH_MODE: 'feishu-oauth-dev',
      FEISHU_APP_ID: 'cli_unique',
      FEISHU_REDIRECT_URI: 'http://localhost:8648/api/auth/feishu/callback',
      FEISHU_SESSION_SECRET: 'session-secret',
      HERMES_RUN_BROKER_URL: 'http://broker.test',
      HERMES_RUN_BROKER_KEY: 'master-key',
    }
  })

  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/feishu-oauth')
    vi.doUnmock('../../packages/server/src/services/gateway-bootstrap')
    vi.unstubAllGlobals()
    process.env = originalEnv
  })

  it('requests the broker scope before redirecting to Feishu', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      scope: 'im:message',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { feishuLogin } = await import('../../packages/server/src/controllers/auth')
    const cookiesSet = vi.fn()
    const ctx: any = {
      origin: 'http://localhost:8648',
      protocol: 'http',
      secure: false,
      search: '',
      get: () => '',
      cookies: { set: cookiesSet },
      redirect: vi.fn(),
      status: 200,
      body: null,
    }

    await feishuLogin(ctx)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://broker.test/api/run-broker/internal/feishu/oauth-scope',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer master-key' }),
      }),
    )
    const authorizeUrl = new URL(ctx.redirect.mock.calls[0][0])
    expect(authorizeUrl.searchParams.get('scope')).toBe('im:message offline_access')
    expect(cookiesSet).toHaveBeenCalled()
  })

  async function loadCallback(importStatus: number, refreshToken: string | undefined = 'refresh-secret', scopeDegraded = false) {
    vi.doMock('../../packages/server/src/services/feishu-oauth', () => ({
      FEISHU_SESSION_COOKIE: 'hermes_feishu_session',
      FEISHU_STATE_COOKIE: 'hermes_feishu_state',
      FEISHU_SCOPE_DEGRADED_COOKIE: 'hermes_feishu_scope_degraded',
      buildFeishuAuthorizeUrl: vi.fn(),
      createFeishuState: vi.fn(() => 'signed-state'),
      verifyFeishuState: vi.fn(() => true),
      cookieSecure: vi.fn(() => false),
      setFeishuCookie: vi.fn((ctx: any, name: string, value: string) => ctx.cookies.set(name, value, {})),
      exchangeFeishuCode: vi.fn(async () => ({
        openid: 'ou_owner',
        appId: 'cli_unique',
        accessToken: 'access-secret',
        refreshToken,
        expiresIn: 7200,
        refreshTokenExpiresIn: 2592000,
        scope: 'im:message offline_access',
      })),
      createBoundFeishuSession: vi.fn(() => ({
        user: { openid: 'ou_owner', profile: 'profile-owner', role: 'user' },
        cookie: 'signed-session',
      })),
    }))
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => null,
    }))
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(importStatus === 200 ? { ok: true } : { error: 'bounded' }),
      { status: importStatus, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const { feishuCallback } = await import('../../packages/server/src/controllers/auth')
    const cookiesSet = vi.fn()
    const ctx: any = {
      query: { code: 'oauth-code', state: 'signed-state' },
      protocol: 'http',
      secure: false,
      get: () => '',
      cookies: {
        get: (name: string) => name === 'hermes_feishu_scope_degraded'
          ? (scopeDegraded ? '1' : '')
          : 'signed-state',
        set: cookiesSet,
      },
      redirect: vi.fn(),
      status: 200,
      body: null,
    }
    await feishuCallback(ctx)
    return { ctx, cookiesSet, fetchMock }
  }

  it('imports the OAuth UAT server-side before the normal login redirect', async () => {
    const { ctx, cookiesSet, fetchMock } = await loadCallback(200)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://broker.test/api/run-broker/internal/feishu/uat/import',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer master-key',
          'X-Hermes-Owner-Open-Id': 'ou_owner',
        }),
      }),
    )
    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(request).toEqual({
      profile_name: 'profile-owner',
      token: {
        app_id: 'cli_unique',
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 7200,
        refresh_token_expires_in: 2592000,
        scope: 'im:message offline_access',
      },
    })
    expect(cookiesSet).toHaveBeenCalledWith('hermes_feishu_session', 'signed-session', {})
    expect(ctx.redirect).toHaveBeenCalledWith('/#/hermes/chat')
    expect(JSON.stringify({ body: ctx.body, redirect: ctx.redirect.mock.calls })).not.toContain('access-secret')
    expect(JSON.stringify({ body: ctx.body, redirect: ctx.redirect.mock.calls })).not.toContain('refresh-secret')
  })

  it('still logs in but redirects to Connectors when only UAT import fails', async () => {
    const { ctx, cookiesSet } = await loadCallback(503)

    expect(cookiesSet).toHaveBeenCalledWith('hermes_feishu_session', 'signed-session', {})
    expect(ctx.redirect).toHaveBeenCalledWith('/#/hermes/connectors?lark_auth=required')
    expect(ctx.status).not.toBe(502)
  })

  it('uses the configured WebUI origin for the import warning', async () => {
    process.env.FEISHU_CALLBACK_REDIRECT = 'https://ui.example.test/#/hermes/chat'
    const { ctx } = await loadCallback(503)

    expect(ctx.redirect).toHaveBeenCalledWith('https://ui.example.test/#/hermes/connectors?lark_auth=required')
  })

  it('still redirects to Feishu when the broker scope lookup fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('broker down'))
    vi.stubGlobal('fetch', fetchMock)
    const { feishuLogin } = await import('../../packages/server/src/controllers/auth')
    const cookiesSet = vi.fn()
    const ctx: any = {
      origin: 'http://localhost:8648',
      protocol: 'http',
      secure: false,
      search: '',
      get: () => '',
      cookies: { set: cookiesSet },
      redirect: vi.fn(),
      status: 200,
      body: null,
    }

    await feishuLogin(ctx)

    expect(ctx.status).not.toBe(502)
    const authorizeUrl = new URL(ctx.redirect.mock.calls[0][0])
    expect(authorizeUrl.searchParams.get('scope')).toBe('offline_access')
    expect(cookiesSet).toHaveBeenCalledWith('hermes_feishu_scope_degraded', '1', expect.anything())
  })

  it('never forwards a thrown message into the callback error body', async () => {
    vi.doMock('../../packages/server/src/services/feishu-oauth', () => ({
      FEISHU_SESSION_COOKIE: 'hermes_feishu_session',
      FEISHU_STATE_COOKIE: 'hermes_feishu_state',
      FEISHU_SCOPE_DEGRADED_COOKIE: 'hermes_feishu_scope_degraded',
      buildFeishuAuthorizeUrl: vi.fn(),
      createFeishuState: vi.fn(() => 'signed-state'),
      verifyFeishuState: vi.fn(() => true),
      cookieSecure: vi.fn(() => false),
      setFeishuCookie: vi.fn(),
      exchangeFeishuCode: vi.fn(async () => {
        throw new Error('upstream said: access_token=leaked-secret refresh_token=leaked-refresh')
      }),
      createBoundFeishuSession: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
      getGatewayManagerInstance: () => null,
    }))
    const warn = vi.fn()
    vi.doMock('../../packages/server/src/services/logger', () => ({
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))
    const { feishuCallback } = await import('../../packages/server/src/controllers/auth')
    const ctx: any = {
      query: { code: 'oauth-code', state: 'signed-state' },
      protocol: 'http',
      secure: false,
      get: () => '',
      cookies: { get: () => 'signed-state', set: vi.fn() },
      redirect: vi.fn(),
      status: 200,
      body: null,
    }

    await feishuCallback(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ error: 'Feishu OAuth failed' })
    // The guard covers logs too — neither surface may carry the thrown message.
    const surfaces = JSON.stringify({ body: ctx.body, logs: warn.mock.calls })
    expect(surfaces).not.toContain('leaked-secret')
    expect(surfaces).not.toContain('leaked-refresh')
    expect(warn).toHaveBeenCalled()
  })

  it('skips the UAT import and warns when login ran on a degraded scope', async () => {
    const { ctx, cookiesSet, fetchMock } = await loadCallback(200, 'refresh-secret', true)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(cookiesSet).toHaveBeenCalledWith('hermes_feishu_session', 'signed-session', {})
    expect(ctx.redirect).toHaveBeenCalledWith('/#/hermes/connectors?lark_auth=required')
    expect(ctx.status).not.toBe(502)
  })

  it('shows the import warning without calling the broker when refresh_token is missing', async () => {
    const { ctx, fetchMock } = await loadCallback(200, '')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ctx.redirect).toHaveBeenCalledWith('/#/hermes/connectors?lark_auth=required')
  })
})

// NOTE: The "Feishu OAuth controller" describe block was removed during the
// upstream rebaseline. The fork-only Feishu OAuth web-login controller
// (feishuLogin/feishuCallback), the per-profile gateway wake path
// (wakeBoundProfileGateway + gateway-manager — deleted, broker-only now),
// the UAT broker proxy (feishuUatStatus/feishuUatStart) and the
// logout/uat/skill-credential route registrations no longer exist in
// controllers/auth.ts or routes/auth.ts. The surviving session-cookie
// helpers above (services/feishu-oauth) remain tested and passing.
