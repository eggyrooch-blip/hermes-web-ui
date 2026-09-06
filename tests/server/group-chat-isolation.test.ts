import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'
import { GC_ROOMS_SCHEMA } from '../../packages/server/src/db/hermes/schemas'
import { canReadGroupChatRoom } from '../../packages/server/src/services/hermes/group-chat'

// Group chat is bound to the trusted numeric WebUI principal. Feishu open_id is
// deliberately not copied into this store or exposed by these tests.

const originalEnv = process.env

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Missing ${method} ${path}`)
  return layer.stack[0]
}

function room(id = 'room-a', ownerAuthUserId: number | null = 1) {
  return {
    id,
    name: 'Private room',
    inviteCode: 'JOINME88',
    ownerAuthUserId,
    triggerTokens: 100000,
    maxHistoryTokens: 32000,
    tailMessageCount: 10,
    totalTokens: 0,
    sessionSeed: '0',
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createRoutingDbWithOwnerColumns(): string {
  const dir = makeTempDir('gc-routing-owner-')
  const dbPath = join(dir, 'multitenancy.db')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        user_id TEXT PRIMARY KEY NOT NULL,
        profile_name TEXT NOT NULL,
        open_id TEXT NOT NULL,
        owner_open_id TEXT,
        provenance TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
    `)

    db.prepare(`
      INSERT INTO multitenancy_routing (user_id, profile_name, open_id, owner_open_id, provenance, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-ouA', 'profA', 'ouA', 'ouA', 'sync', 1)
  } finally {
    db.close()
  }

  return dbPath
}

function createRoutingDbWithoutOwnerColumns(): string {
  const dir = makeTempDir('gc-routing-legacy-')
  const dbPath = join(dir, 'multitenancy.db')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        user_id TEXT PRIMARY KEY NOT NULL,
        profile_name TEXT NOT NULL,
        open_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
    `)

    db.prepare(`
      INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active)
      VALUES (?, ?, ?, ?)
    `).run('legacy-ouA', 'profA', 'ouA', 1)
  } finally {
    db.close()
  }

  return dbPath
}

async function loadOwnerOwnsProfile(multitenancyDbPath: string) {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env = { ...originalEnv, HERMES_MULTITENANCY_DB: multitenancyDbPath }
  return import('../../packages/server/src/services/hermes/agent-ownership')
}

describe('group-chat isolation', () => {
  afterEach(() => {
    process.env = originalEnv
  })

  it('degrades ownerOwnsProfile across multitenancy schemas with and without owner columns', async () => {
    const legacyDbPath = createRoutingDbWithoutOwnerColumns()
    const { ownerOwnsProfile: legacyOwnerOwnsProfile } = await loadOwnerOwnsProfile(legacyDbPath)

    expect(legacyOwnerOwnsProfile('ouA', 'profA')).toBe(true)
    expect(legacyOwnerOwnsProfile('ouA', 'profMissing')).toBe(false)

    const currentDbPath = createRoutingDbWithOwnerColumns()
    const { ownerOwnsProfile: currentOwnerOwnsProfile } = await loadOwnerOwnsProfile(currentDbPath)

    expect(currentOwnerOwnsProfile('ouA', 'profA')).toBe(true)
    expect(currentOwnerOwnsProfile('ouA', 'profB')).toBe(false)

    rmSync(join(legacyDbPath, '..'), { recursive: true, force: true })
    rmSync(join(currentDbPath, '..'), { recursive: true, force: true })
  })

  it('persists the trusted WebUI creator id on every new room', async () => {
    expect(GC_ROOMS_SCHEMA.ownerAuthUserId).toBe('INTEGER')
    const storage = {
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRoomByInviteCode: vi.fn(() => null),
      getRoom: vi.fn(() => room()),
    }
    const createAgent = vi.fn()
    setGroupChatServer({
      getStorage: () => storage,
      agentClients: { createAgent },
    } as any)
    const ctx: any = {
      state: { user: { id: 1, username: 'alice', role: 'user', profiles: ['profile-a'] } },
      request: { body: { name: 'Private room', inviteCode: 'JOINME88', agents: [] } },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms', 'POST')(ctx)

    expect(storage.saveRoom).toHaveBeenCalledWith(
      expect.any(String),
      'Private room',
      'JOINME88',
      expect.objectContaining({ ownerAuthUserId: 1 }),
    )
    expect(storage.addRoomMember).toHaveBeenCalledWith(
      expect.any(String),
      'auth:1',
      'alice',
      '',
      '',
      1,
    )
  })

  it('resolves two identities to self=2, cross=0, ambiguous=0', () => {
    const rooms = new Map([
      ['room-a', room('room-a', 1)],
      ['room-b', room('room-b', 2)],
    ])
    const storage = {
      getRoom: vi.fn((id: string) => rooms.get(id)),
      getMemberByAuthUserId: vi.fn(() => null),
    }
    const alice = { id: 1, username: 'alice', role: 'user' }
    const bob = { id: 2, username: 'bob', role: 'user' }

    const self = Number(canReadGroupChatRoom(storage as any, 'room-a', alice)) +
      Number(canReadGroupChatRoom(storage as any, 'room-b', bob))
    const cross = Number(canReadGroupChatRoom(storage as any, 'room-b', alice)) +
      Number(canReadGroupChatRoom(storage as any, 'room-a', bob))
    const ambiguous = Number(canReadGroupChatRoom(storage as any, 'room-a', undefined)) +
      Number(canReadGroupChatRoom(storage as any, 'room-a', { ...alice, id: 0 }))

    expect({ self, cross, ambiguous }).toEqual({ self: 2, cross: 0, ambiguous: 0 })
  })

  it('does not trust a legacy string member id without a numeric principal binding', () => {
    const storage = {
      getRoom: vi.fn(() => room()),
      getMemberByAuthUserId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => ({ userId: 'auth:7', authUserId: null })),
    }

    expect(canReadGroupChatRoom(storage as any, 'room-a', {
      id: 7, username: 'legacy', role: 'user',
    })).toBe(false)
    expect(storage.getMemberByUserId).not.toHaveBeenCalled()
  })

  it('rejects malformed agent input before creating room or runtime state', async () => {
    const storage = { saveRoom: vi.fn(), addRoomMember: vi.fn(), getRoomByInviteCode: vi.fn() }
    setGroupChatServer({ getStorage: () => storage, agentClients: { createAgent: vi.fn() } } as any)
    const ctx: any = {
      state: { user: { id: 1, username: 'alice', role: 'user', profiles: ['profile-a'] } },
      request: { body: { name: 'Private room', inviteCode: 'JOINME88', agents: [null] } },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms', 'POST')(ctx)

    expect(ctx.status).toBe(400)
    expect(storage.saveRoom).not.toHaveBeenCalled()
  })

  it('returns 400 instead of throwing on non-string clone fields', async () => {
    const storage = {
      getRoom: vi.fn(() => room()),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomAgents: vi.fn(() => []),
      saveRoom: vi.fn(),
    }
    setGroupChatServer({ getStorage: () => storage } as any)
    const ctx: any = {
      state: { user: { id: 1, username: 'alice', role: 'user', profiles: [] } },
      params: { roomId: 'room-a' },
      request: { body: { inviteCode: 123 } },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')(ctx)

    expect(ctx.status).toBe(400)
    expect(storage.saveRoom).not.toHaveBeenCalled()

    ctx.request.body = { name: 123 }
    ctx.status = 200
    await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')(ctx)
    expect(ctx.status).toBe(400)
    expect(storage.saveRoom).not.toHaveBeenCalled()
  })

  it('fails closed before room data is read for a non-member', async () => {
    const storage = {
      getRoom: vi.fn(() => room()),
      getMemberByAuthUserId: vi.fn(() => null),
      getMessages: vi.fn(),
      getMessageCount: vi.fn(),
      getRoomAgents: vi.fn(),
      getRoomMembers: vi.fn(),
    }
    setGroupChatServer({ getStorage: () => storage } as any)
    const ctx: any = {
      state: { user: { id: 2, username: 'bob', role: 'user', profiles: ['profile-b'] } },
      params: { roomId: 'room-a' },
      query: {},
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Room not found' })
    expect(storage.getMessages).not.toHaveBeenCalled()
  })

  it('atomically records an invited user as a read-only member', async () => {
    const storage = {
      joinRoomByInviteCode: vi.fn(() => room()),
    }
    setGroupChatServer({ getStorage: () => storage } as any)
    const ctx: any = {
      state: { user: { id: 2, username: 'bob', role: 'user', profiles: ['profile-b'] } },
      params: { code: 'JOINME88' },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'POST')(ctx)

    expect(storage.joinRoomByInviteCode).toHaveBeenCalledWith('JOINME88', 2, 'bob')
    expect(ctx.body.room).toEqual(expect.objectContaining({ id: 'room-a', inviteCode: null }))
    expect(ctx.body.room).not.toHaveProperty('ownerAuthUserId')
  })

  it('fails closed when an invite code resolves to an ownerless legacy room', async () => {
    const storage = {
      joinRoomByInviteCode: vi.fn(() => room('legacy-room', null)),
    }
    setGroupChatServer({ getStorage: () => storage } as any)
    const ctx: any = {
      state: { user: { id: 2, username: 'bob', role: 'user', profiles: [] } },
      params: { code: 'LEGACY88' },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'POST')(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Room not found' })
  })

  it('lets members read but never manage room or agent configuration', async () => {
    const storage = {
      getRoom: vi.fn(() => room()),
      getMemberByAuthUserId: vi.fn(() => ({ id: 'member-b', authUserId: 2 })),
      updateRoomConfig: vi.fn(),
    }
    setGroupChatServer({ getStorage: () => storage } as any)
    const ctx: any = {
      state: { user: { id: 2, username: 'bob', role: 'user', profiles: ['profile-b'] } },
      params: { roomId: 'room-a' },
      request: { body: { triggerTokens: 1 } },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/:roomId/config', 'PUT')(ctx)

    expect(ctx.status).toBe(404)
    expect(storage.updateRoomConfig).not.toHaveBeenCalled()
  })

  it('does not connect an agent profile the owner cannot access', async () => {
    const storage = {
      getRoom: vi.fn(() => room()),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomAgents: vi.fn(() => []),
      isRoomProfileAuthorized: vi.fn(() => false),
    }
    const createAgent = vi.fn()
    setGroupChatServer({
      getStorage: () => storage,
      agentClients: { createAgent },
    } as any)
    const ctx: any = {
      state: { user: { id: 1, username: 'alice', role: 'user', profiles: ['profile-a'] } },
      params: { roomId: 'room-a' },
      request: { body: { profile: 'profile-b' } },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Profile unavailable to room owner' })
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('keeps ownerless legacy rooms read-only for super admins and hidden from users', async () => {
    const legacy = room('legacy-room', null)
    const storage = {
      getRoom: vi.fn(() => legacy),
      getMemberByAuthUserId: vi.fn(() => null),
      getMessages: vi.fn(() => []),
      getMessageCount: vi.fn(() => 0),
      getRoomAgents: vi.fn(() => []),
      getRoomMembers: vi.fn(() => []),
      updateRoomConfig: vi.fn(),
    }
    setGroupChatServer({ getStorage: () => storage } as any)
    const admin: any = {
      state: { user: { id: 9, username: 'root', role: 'super_admin' } },
      params: { roomId: 'legacy-room' },
      query: {},
      request: { body: { triggerTokens: 1 } },
      status: 200,
    }

    await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')(admin)
    expect(admin.status).toBe(200)
    expect(admin.body.room).toEqual(expect.objectContaining({ id: 'legacy-room', inviteCode: null }))

    await routeHandler('/api/hermes/group-chat/rooms/:roomId/config', 'PUT')(admin)
    expect(admin.status).toBe(404)
    expect(storage.updateRoomConfig).not.toHaveBeenCalled()
  })
})
