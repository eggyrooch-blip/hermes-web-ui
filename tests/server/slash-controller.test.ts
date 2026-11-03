import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
    const dir = mkdtempSync(join(tmpdir(), 'slash-controller-agent-id-'))
    const dbPath = join(dir, 'multitenancy.db')
    const originalMultitenancyDb = config.multitenancyDb
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE multitenancy_routing (
          user_id TEXT PRIMARY KEY NOT NULL,
          profile_name TEXT NOT NULL,
          open_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          owner_open_id TEXT,
          provenance TEXT DEFAULT 'sync',
          agent_id TEXT
        );
      `)
      db.prepare('INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id, provenance, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'agent-owned',
        'selected_profile',
        'agent-owned',
        1,
        'ou_owner',
        'webui-agent',
        'agent-owned',
      )
    } finally {
      db.close()
    }
    config.multitenancyDb = dbPath
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
      query: { profile: 'selected_profile' },
      search: '?profile=selected_profile&token=secret',
    })
    await listSlashCommands(c)

    try {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8766/api/run-broker/slash/commands?profile_name=selected_profile&agent_id=agent-owned',
        expect.objectContaining({
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer broker-secret',
            'X-Hermes-Owner-Open-Id': 'ou_owner',
            'X-Hermes-Agent-Id': 'agent-owned',
          },
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
    } finally {
      config.multitenancyDb = originalMultitenancyDb
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects chat-plane slash registry requests for unowned profiles before contacting the broker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slash-controller-unowned-'))
    const dbPath = join(dir, 'multitenancy.db')
    const originalMultitenancyDb = config.multitenancyDb
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE multitenancy_routing (
          user_id TEXT PRIMARY KEY NOT NULL,
          profile_name TEXT NOT NULL,
          open_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          owner_open_id TEXT,
          provenance TEXT DEFAULT 'sync',
          agent_id TEXT
        );
      `)
      db.prepare('INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id, provenance, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'victim-root',
        'victim_profile',
        'ou_victim',
        1,
        null,
        'sync',
        null,
      )
    } finally {
      db.close()
    }
    config.multitenancyDb = dbPath
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const c = ctx({ query: { profile: 'victim_profile' } })
    await listSlashCommands(c)

    try {
      expect(fetchMock).not.toHaveBeenCalled()
      expect(c.status).toBe(403)
      expect(c.body).toEqual({ error: 'profile is not accessible for current owner' })
    } finally {
      config.multitenancyDb = originalMultitenancyDb
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores client-supplied agent_id in chat-plane slash registry requests without a selected profile', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      profile_name: 'owner_sync_profile',
      commands: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const c = ctx({
      query: { agent_id: 'client-forged-agent' },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-agent-id' ? 'client-forged-header-agent' : ''),
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
      }),
    )
    expect(c.status).toBe(200)
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
