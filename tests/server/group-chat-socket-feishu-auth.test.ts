import { afterEach, describe, expect, it, vi } from 'vitest'

// Regression suite for `groupchat-socket-feishu-auth`: Feishu/server-session
// users (no JS-readable JWT) must be able to authenticate the /group-chat socket
// via their httpOnly `hermes_feishu_session` cookie, while the existing
// localStorage-JWT and agent-socket paths keep working unchanged.
//
// We unit-test the extracted `resolveGroupChatSocketAuth` decision function so
// the branches are covered without standing up a real Socket.IO server. The
// DB-backed bridge (ensureWebUserForFeishu) and JWT validation
// (authenticateUserToken) are mocked; the Feishu cookie itself is signed by the
// real feishu-oauth helpers so the parse path is exercised end to end.

const originalEnv = process.env

vi.mock('../../packages/server/src/services/compat-user', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ensureWebUserForFeishu: vi.fn() }
})

vi.mock('../../packages/server/src/middleware/user-auth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, authenticateUserToken: vi.fn(async () => null) }
})

const SESSION_SECRET = 'test-session-secret'

async function load(extraEnv: Record<string, string> = {}) {
  vi.resetModules()
  process.env = {
    ...originalEnv,
    AUTH_JWT_SECRET: 'test-jwt-secret', // keeps isAuthEnabled() true without getToken()
    FEISHU_SESSION_SECRET: SESSION_SECRET,
    HERMES_REQUIRED_PROFILE: '',
    ...extraEnv,
  }
  const gc = await import('../../packages/server/src/services/hermes/group-chat')
  const agentClients = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')
  const feishu = await import('../../packages/server/src/services/feishu-oauth')
  const compat = await import('../../packages/server/src/services/compat-user')
  const userAuth = await import('../../packages/server/src/middleware/user-auth')
  return {
    resolveGroupChatSocketAuth: gc.resolveGroupChatSocketAuth,
    GROUP_CHAT_AGENT_SOCKET_SECRET: agentClients.GROUP_CHAT_AGENT_SOCKET_SECRET,
    FEISHU_SESSION_COOKIE: feishu.FEISHU_SESSION_COOKIE,
    createFeishuSessionCookie: feishu.createFeishuSessionCookie,
    ensureWebUserForFeishu: compat.ensureWebUserForFeishu as ReturnType<typeof vi.fn>,
    authenticateUserToken: userAuth.authenticateUserToken as ReturnType<typeof vi.fn>,
  }
}

function feishuCookieHeader(name: string, value: string): string {
  // Surround with unrelated cookies to prove the extractor isolates the right one.
  return `theme=dark; ${name}=${value}; other=1`
}

afterEach(() => {
  process.env = originalEnv
  vi.clearAllMocks()
})

describe('resolveGroupChatSocketAuth', () => {
  it('admits the internal agent socket on a valid agentSocketSecret', async () => {
    const m = await load()
    const result = await m.resolveGroupChatSocketAuth({
      auth: { source: 'agent', agentSocketSecret: m.GROUP_CHAT_AGENT_SOCKET_SECRET },
    })
    expect(result).toEqual({ kind: 'agent' })
    expect(m.authenticateUserToken).not.toHaveBeenCalled()
    expect(m.ensureWebUserForFeishu).not.toHaveBeenCalled()
  })

  it('admits a localStorage-JWT user via auth.token (unchanged path)', async () => {
    const m = await load()
    const jwtUser = { id: 7, username: 'alice', role: 'admin', profiles: ['p1'] }
    m.authenticateUserToken.mockResolvedValueOnce(jwtUser)

    const result = await m.resolveGroupChatSocketAuth({ auth: { token: 'jwt-abc' } })

    expect(result).toEqual({ kind: 'user', user: jwtUser })
    expect(m.authenticateUserToken).toHaveBeenCalledWith('jwt-abc')
    // JWT succeeded → no Feishu fallback needed.
    expect(m.ensureWebUserForFeishu).not.toHaveBeenCalled()
  })

  it('admits a Feishu user via the session cookie when no JWT token is present', async () => {
    const m = await load()
    const bridged = { id: 42, username: 'feishu:ou_x', role: 'user', profiles: ['researcher'] }
    m.ensureWebUserForFeishu.mockReturnValueOnce(bridged)

    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_x',
      profile: 'researcher',
      name: '张三',
      avatarUrl: 'https://example.com/a.png',
      secret: SESSION_SECRET,
      maxAgeSeconds: 3600,
    })

    const result = await m.resolveGroupChatSocketAuth({
      auth: {},
      headers: { cookie: feishuCookieHeader(m.FEISHU_SESSION_COOKIE, cookie) },
    })

    expect(result).toEqual({ kind: 'user', user: bridged })
    expect(m.ensureWebUserForFeishu).toHaveBeenCalledWith('ou_x', {
      name: '张三',
      avatarUrl: 'https://example.com/a.png',
    })
  })

  it('rejects when there is neither a valid token nor a Feishu cookie', async () => {
    const m = await load()
    const result = await m.resolveGroupChatSocketAuth({ auth: {}, headers: {} })
    expect(result).toEqual({ kind: 'unauthorized' })
    expect(m.ensureWebUserForFeishu).not.toHaveBeenCalled()
  })

  it('rejects a tampered Feishu session cookie (signature mismatch)', async () => {
    const m = await load()
    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_x',
      profile: 'researcher',
      secret: SESSION_SECRET,
      maxAgeSeconds: 3600,
    })
    const result = await m.resolveGroupChatSocketAuth({
      auth: {},
      headers: { cookie: feishuCookieHeader(m.FEISHU_SESSION_COOKIE, `${cookie}x`) },
    })
    expect(result).toEqual({ kind: 'unauthorized' })
    expect(m.ensureWebUserForFeishu).not.toHaveBeenCalled()
  })

  it('rejects a Feishu cookie whose profile does not match the pinned requiredProfile', async () => {
    const m = await load({ HERMES_REQUIRED_PROFILE: 'locked-profile' })
    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_x',
      profile: 'some-other-profile',
      secret: SESSION_SECRET,
      maxAgeSeconds: 3600,
    })
    const result = await m.resolveGroupChatSocketAuth({
      auth: {},
      headers: { cookie: feishuCookieHeader(m.FEISHU_SESSION_COOKIE, cookie) },
    })
    expect(result).toEqual({ kind: 'unauthorized' })
    expect(m.ensureWebUserForFeishu).not.toHaveBeenCalled()
  })

  it('fails closed (Unauthorized) when the user-store bridge throws', async () => {
    const m = await load()
    m.ensureWebUserForFeishu.mockImplementationOnce(() => {
      throw new Error('user-store unavailable')
    })
    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_x',
      profile: 'researcher',
      secret: SESSION_SECRET,
      maxAgeSeconds: 3600,
    })
    const result = await m.resolveGroupChatSocketAuth({
      auth: {},
      headers: { cookie: feishuCookieHeader(m.FEISHU_SESSION_COOKIE, cookie) },
    })
    expect(result).toEqual({ kind: 'unauthorized' })
  })

  it('still admits a JWT user even when a Feishu cookie is also present (token wins)', async () => {
    const m = await load()
    const jwtUser = { id: 9, username: 'bob', role: 'super_admin' }
    m.authenticateUserToken.mockResolvedValueOnce(jwtUser)
    const cookie = m.createFeishuSessionCookie({
      openid: 'ou_other',
      profile: 'researcher',
      secret: SESSION_SECRET,
      maxAgeSeconds: 3600,
    })
    const result = await m.resolveGroupChatSocketAuth({
      auth: { token: 'jwt-xyz' },
      headers: { cookie: feishuCookieHeader(m.FEISHU_SESSION_COOKIE, cookie) },
    })
    expect(result).toEqual({ kind: 'user', user: jwtUser })
    expect(m.ensureWebUserForFeishu).not.toHaveBeenCalled()
  })
})
