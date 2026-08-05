import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

// 评审采纳（grok）：request-context.test.ts 只钉了 plane 闸的路径×动词矩阵，
// 控制器自身的身份纪律（credential WRITE path）没有定向测试——未来谁“顺手”
// 从请求体取 open_id 或删掉 openid 检查，矩阵照样全绿。这里逐条钉死。
async function loadController(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  process.env = {
    ...originalEnv,
    // 钉死 auth mode（codex delta 评审）：feishu-oauth-dev / trusted-feishu 会在
    // config 里强制派生 chat plane，宿主机若带着这类 env 跑测试，
    // 「非 chat plane」用例就会假失败。'token' 不派生 plane，plane 只由下面这行决定。
    HERMES_AUTH_MODE: 'token',
    HERMES_WEB_PLANE: 'chat',
    HERMES_RUN_BROKER_URL: 'http://127.0.0.1:9',
    ...env,
  }
  return import('../../packages/server/src/controllers/hermes/gitlab-credential')
}

function mockCtx(user?: { openid?: string }) {
  return {
    state: user ? { user } : {},
    request: {
      // 请求体故意塞满“敌意”字段：身份、别人的 profile、以及已废弃的到期日。
      // 它们一个都不许穿过 BFF。
      body: {
        token: 'glpat-x',
        tier: 'read',
        expires_on: '2031-11-31',
        open_id: 'ou_evil',
        profile_name: 'someone-else',
      },
    },
    status: 200,
    body: undefined as any,
  } as any
}

describe('submitGitlabToken controller (credential WRITE path)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = originalEnv
  })

  it('outside the chat plane the endpoint plays dead (404), broker untouched', async () => {
    const { submitGitlabToken } = await loadController({ HERMES_WEB_PLANE: undefined })
    const ctx = mockCtx({ openid: 'ou_alice' })
    await submitGitlabToken(ctx)
    expect(ctx.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['no session user at all', undefined],
    ['session user without openid', {}],
    ['blank openid', { openid: '   ' }],
  ] as const)('fails closed on %s: 403 and the broker is never called', async (_name, user) => {
    const { submitGitlabToken } = await loadController()
    const ctx = mockCtx(user as any)
    await submitGitlabToken(ctx)
    expect(ctx.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with a verified openid: stamps it server-side and forwards ONLY token material', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    })
    const { submitGitlabToken } = await loadController()
    const ctx = mockCtx({ openid: 'ou_alice' })
    await submitGitlabToken(ctx)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(String(url)).toContain('/api/run-broker/credentials/gitlab')
    expect(init.headers['X-Hermes-Owner-Open-Id']).toBe('ou_alice')
    // 身份字段和已废弃的 expires_on 都不许过桥——到期日由 broker 从 GitLab 读。
    expect(JSON.parse(init.body)).toEqual({ token: 'glpat-x', tier: 'read' })
    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ ok: true })
  })
})
