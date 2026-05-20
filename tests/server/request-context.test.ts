import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const originalEnv = process.env

async function loadRequestContext(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  process.env = { ...originalEnv, ...env }
  return import('../../packages/server/src/services/request-context')
}

function mockCtx(path: string, method = 'GET') {
  return {
    path,
    method,
    status: 200,
    body: undefined,
  } as any
}

describe('chat plane access control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('allows model list endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/available-models')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('keeps settings endpoints blocked in chat plane by default', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/config')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
  })

  it('allows settings endpoints in chat plane when explicitly enabled', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    })
    const ctx = mockCtx('/api/hermes/config')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('allows model listing but blocks model config and credential writes in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const allowedModelListCtx = mockCtx('/api/hermes/available-models', 'GET')
    const blockedModelCtx = mockCtx('/api/hermes/config/model', 'PUT')
    const blockedCredentialsCtx = mockCtx('/api/hermes/config/credentials', 'PUT')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(allowedModelListCtx, next)
    await enforcePlaneAccess(blockedModelCtx, next)
    await enforcePlaneAccess(blockedCredentialsCtx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(allowedModelListCtx.status).toBe(200)
    expect(blockedModelCtx.status).toBe(403)
    expect(blockedCredentialsCtx.status).toBe(403)
  })

  it('allows profile memory edits and sandboxed file management in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const memoryCtx = mockCtx('/api/hermes/memory', 'POST')
    const fileCtx = mockCtx('/api/hermes/files/list', 'GET')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(memoryCtx, next)
    await enforcePlaneAccess(fileCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(memoryCtx.status).toBe(200)
    expect(fileCtx.status).toBe(200)
  })

  it('allows owner-scoped group chat endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const listCtx = mockCtx('/api/hermes/group-chat/rooms', 'GET')
    const createCtx = mockCtx('/api/hermes/group-chat/rooms', 'POST')
    const updateCtx = mockCtx('/api/hermes/group-chat/rooms/room-1/config', 'PUT')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(listCtx, next)
    await enforcePlaneAccess(createCtx, next)
    await enforcePlaneAccess(updateCtx, next)

    expect(next).toHaveBeenCalledTimes(3)
    expect(listCtx.status).toBe(200)
    expect(createCtx.status).toBe(200)
    expect(updateCtx.status).toBe(200)
  })

  it('allows owner-scoped profile listing and creation in chat plane but keeps profile admin actions blocked', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const listCtx = mockCtx('/api/hermes/profiles', 'GET')
    const createCtx = mockCtx('/api/hermes/profiles', 'POST')
    const detailCtx = mockCtx('/api/hermes/profiles/other', 'GET')
    const deleteCtx = mockCtx('/api/hermes/profiles/other', 'DELETE')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(listCtx, next)
    await enforcePlaneAccess(createCtx, next)
    await enforcePlaneAccess(detailCtx, next)
    await enforcePlaneAccess(deleteCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(listCtx.status).toBe(200)
    expect(createCtx.status).toBe(200)
    expect(detailCtx.status).toBe(403)
    expect(deleteCtx.status).toBe(403)
  })

  it('allows authenticated Feishu UAT self-service endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const statusCtx = mockCtx('/api/auth/feishu/uat/status', 'GET')
    const startCtx = mockCtx('/api/auth/feishu/uat/start', 'POST')
    const pollCtx = mockCtx('/api/auth/feishu/uat/sessions/sess-1', 'GET')
    const cancelCtx = mockCtx('/api/auth/feishu/uat/sessions/sess-1', 'DELETE')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(statusCtx, next)
    await enforcePlaneAccess(startCtx, next)
    await enforcePlaneAccess(pollCtx, next)
    await enforcePlaneAccess(cancelCtx, next)

    expect(next).toHaveBeenCalledTimes(4)
    expect(statusCtx.status).toBe(200)
    expect(startCtx.status).toBe(200)
    expect(pollCtx.status).toBe(200)
    expect(cancelCtx.status).toBe(200)
  })

  it('keeps sandboxed file management available when settings are explicitly enabled', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    })
    const ctx = mockCtx('/api/hermes/files/list')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('does not reopen admin surface endpoints through the removed temporary flag', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN: '1',
    })
    const allowed = [
      '/api/hermes/config',
      '/api/hermes/gateways',
      '/api/hermes/logs',
      '/api/hermes/channels',
      '/api/hermes/cron-history',
      '/api/hermes/model-context',
      '/api/hermes/auth/copilot/check-token',
      '/api/hermes/weixin/qrcode',
      '/api/hermes/skills/toggle',
    ]

    for (const path of allowed) {
      const ctx = mockCtx(path, path.includes('toggle') ? 'POST' : 'GET')
      const next = vi.fn(async () => {})

      await enforcePlaneAccess(ctx, next)

      expect(next, path).not.toHaveBeenCalled()
      expect(ctx.status, path).toBe(403)
    }
  })

  it('keeps sandboxed files available even when the removed temporary flag is set', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN: '1',
    })
    const ctx = mockCtx('/api/hermes/files/list')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })
})

describe('multitenancy profile resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeRoutingDb(rows: Array<{ user_id: string; profile_name: string; open_id: string; active?: number; owner_open_id?: string; provenance?: string }>) {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-routing-'))
    const dbPath = join(dir, 'multitenancy.db')
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE multitenancy_routing (
          user_id TEXT PRIMARY KEY NOT NULL,
          profile_name TEXT NOT NULL,
          open_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          owner_open_id TEXT,
          provenance TEXT DEFAULT 'sync'
        );
      `)
      const stmt = db.prepare('INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id, provenance) VALUES (?, ?, ?, ?, ?, ?)')
      for (const row of rows) {
        stmt.run(row.user_id, row.profile_name, row.open_id, row.active ?? 1, row.owner_open_id ?? row.open_id, row.provenance ?? 'sync')
      }
    } finally {
      db.close()
    }
    return dbPath
  }

  it('resolves the profile bound by multitenancy routing', async () => {
    const dbPath = makeRoutingDb([{ user_id: 'sunke', profile_name: 'sunke', open_id: 'ou_sunke' }])
    const { resolveProfileForOpenId } = await loadRequestContext({ HERMES_MULTITENANCY_DB: dbPath })

    expect(resolveProfileForOpenId('ou_sunke')).toBe('sunke')
  })

  it('rejects OAuth profile binding when the route is not the required canonical profile', async () => {
    const dbPath = makeRoutingDb([{ user_id: 'sunke', profile_name: 'feishu_sunke', open_id: 'ou_sunke' }])
    const { resolveProfileForOpenId } = await loadRequestContext({
      HERMES_MULTITENANCY_DB: dbPath,
      HERMES_REQUIRED_PROFILE: 'sunke',
    })

    expect(resolveProfileForOpenId('ou_sunke')).toBeNull()
  })

  it('uses an owner-scoped selected profile header in chat plane', async () => {
    const dbPath = makeRoutingDb([
      { user_id: 'sunke', profile_name: 'feishu_sunke', open_id: 'ou_sunke' },
      { user_id: 'group:alpha', profile_name: 'feishu_group_alpha', open_id: '', owner_open_id: 'ou_sunke', provenance: 'group' },
    ])
    const { getRequestProfile } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_MULTITENANCY_DB: dbPath,
    })
    const ctx = {
      state: { user: { openid: 'ou_sunke', profile: 'feishu_sunke', role: 'user' } },
      get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'feishu_group_alpha' : '',
      query: {},
    } as any

    expect(getRequestProfile(ctx)).toBe('feishu_group_alpha')
  })

  it('falls back to the bound profile when the selected chat-plane profile is not owned', async () => {
    const dbPath = makeRoutingDb([
      { user_id: 'sunke', profile_name: 'feishu_sunke', open_id: 'ou_sunke' },
      { user_id: 'other-group', profile_name: 'feishu_group_other', open_id: '', owner_open_id: 'ou_other', provenance: 'group' },
    ])
    const { getRequestProfile } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_MULTITENANCY_DB: dbPath,
    })
    const ctx = {
      state: { user: { openid: 'ou_sunke', profile: 'feishu_sunke', role: 'user' } },
      get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'feishu_group_other' : '',
      query: {},
    } as any

    expect(getRequestProfile(ctx)).toBe('feishu_sunke')
  })
})
