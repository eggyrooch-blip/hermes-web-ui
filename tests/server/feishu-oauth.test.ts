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

// NOTE: The "Feishu OAuth controller" describe block was removed during the
// upstream rebaseline. The fork-only Feishu OAuth web-login controller
// (feishuLogin/feishuCallback), the per-profile gateway wake path
// (wakeBoundProfileGateway + gateway-manager — deleted, broker-only now),
// the UAT broker proxy (feishuUatStatus/feishuUatStart) and the
// logout/uat/skill-credential route registrations no longer exist in
// controllers/auth.ts or routes/auth.ts. The surviving session-cookie
// helpers above (services/feishu-oauth) remain tested and passing.
