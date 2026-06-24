import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('agent sharing controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('proxies owner share grants to the Run Broker with the verified Feishu actor', async () => {
    process.env.HERMES_RUN_BROKER_URL = 'http://broker.test'
    process.env.HERMES_RUN_BROKER_KEY = 'broker-key'
    vi.resetModules()
    const fetchMock = vi.fn(async (url: string, options: any) => {
      expect(url).toBe('http://broker.test/api/run-broker/agents/agent-shared/shares')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer broker-key')
      expect(options.headers['X-Hermes-Owner-Open-Id']).toBe('ou_owner')
      expect(JSON.parse(options.body)).toEqual({
        grantee_open_id: 'ou_editor',
        role: 'editor',
      })
      return new Response(JSON.stringify({
        share: {
          agent_id: 'agent-shared',
          grantee_open_id: 'ou_editor',
          role: 'editor',
          status: 'active',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { grantShare } = await import('../../packages/server/src/controllers/hermes/agents')
    const ctx: any = {
      params: { agentId: 'agent-shared' },
      state: { user: { openid: 'ou_owner' } },
      request: { body: { granteeOpenId: 'ou_editor', role: 'editor' } },
      status: 200,
      body: undefined,
    }

    await grantShare(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.share.role).toBe('editor')
  })
})
