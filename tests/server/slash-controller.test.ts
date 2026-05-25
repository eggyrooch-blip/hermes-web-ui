import { beforeEach, describe, expect, it, vi } from 'vitest'

import { config } from '../../packages/server/src/config'
import { listSlashCommands } from '../../packages/server/src/controllers/hermes/slash'

function ctx(overrides: Record<string, any> = {}) {
  return {
    state: { user: { openid: 'ou_owner', profile: 'owner_sync_profile', role: 'user' } },
    query: {},
    search: '',
    req: { method: 'GET' },
    method: 'GET',
    status: 200,
    body: null,
    set: vi.fn(),
    get: vi.fn(() => ''),
    ...overrides,
  } as any
}

describe('slash controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    config.webPlane = 'chat'
    config.runBrokerUrl = 'http://127.0.0.1:8766'
    config.runBrokerKey = 'broker-secret'
  })

  it('proxies chat-plane slash registry to the owner-scoped run broker', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify({
      ok: true,
      profile_name: 'owner_sync_profile',
      commands: [
        {
          name: 'kep-prd-analysis',
          slash: '/kep-prd-analysis',
          title: 'KEP PRD Analysis',
          description: 'PRD analysis helper',
          source: 'skill',
          type: 'skill',
          category: 'Keep',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const c = ctx({
      query: { profile: 'spoofed' },
      search: '?profile=spoofed&token=secret',
    })
    await listSlashCommands(c)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8766/api/run-broker/slash/commands',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer broker-secret',
          'X-Hermes-Owner-Open-Id': 'ou_owner',
        },
        body: undefined,
      }),
    )
    expect(c.body).toEqual({
      ok: true,
      commands: [
        {
          name: 'clear',
          slash: '/clear',
          title: 'Clear conversation',
          description: 'Clear the current chat transcript.',
          source: 'local',
          type: 'local',
          category: 'Chat',
        },
        {
          name: 'kep-prd-analysis',
          slash: '/kep-prd-analysis',
          title: 'KEP PRD Analysis',
          description: 'PRD analysis helper',
          source: 'skill',
          type: 'skill',
          category: 'Keep',
        },
      ],
      broker: {
        ok: true,
        profile_name: 'owner_sync_profile',
      },
    })
  })

  it('returns local commands with an unavailable marker when broker is not configured', async () => {
    config.runBrokerUrl = ''
    const c = ctx()

    await listSlashCommands(c)

    expect(c.status).toBe(200)
    expect(c.body).toEqual({
      ok: true,
      commands: [
        {
          name: 'clear',
          slash: '/clear',
          title: 'Clear conversation',
          description: 'Clear the current chat transcript.',
          source: 'local',
          type: 'local',
          category: 'Chat',
        },
      ],
      broker: {
        ok: false,
        error: 'HERMES_RUN_BROKER_URL is required for slash registry',
      },
    })
  })
})
