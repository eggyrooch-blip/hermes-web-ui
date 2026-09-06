import { describe, expect, it, vi, beforeEach } from 'vitest'

const { socketHandlers, mockSocket, mockIo } = vi.hoisted(() => {
  const socketHandlers = new Map<string, (...args: any[]) => void>()
  const mockSocket: any = {
    id: 'socket-1',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      socketHandlers.set(event, handler)
      if (event === 'connect') queueMicrotask(() => handler())
      return mockSocket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }
  const mockIo = vi.fn(() => mockSocket)
  return { socketHandlers, mockSocket, mockIo }
})

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

const owner = { id: 1, username: 'owner', role: 'user', profiles: ['default'] }
const ownedRoom = { id: 'room-1', name: 'Room', inviteCode: 'INVITE', ownerAuthUserId: owner.id }

function ownerStorage(extra: Record<string, unknown> = {}) {
  return {
    getRoom: vi.fn(() => ownedRoom),
    getRoomByInviteCode: vi.fn(() => null),
    getMemberByAuthUserId: vi.fn(() => null),
    isRoomProfileAuthorized: vi.fn(() => true),
    ...extra,
  }
}

describe('Group Chat member/agent identity sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    socketHandlers.clear()
  })

  it('uses the persisted group-chat agent id as the runtime agent id and socket user id', async () => {
    const clients = new AgentClients()

    const client = await clients.createAgent({
      agentId: 'agent-stable-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)

    expect(client.agentId).toBe('agent-stable-1')
    expect(mockIo).toHaveBeenCalledWith(
      'http://127.0.0.1:8648/group-chat',
      expect.objectContaining({
        auth: expect.objectContaining({
          token: 'test-token',
          userId: 'agent-stable-1',
          name: 'Worker',
          source: 'agent',
          agentSocketSecret: expect.any(String),
        }),
      }),
    )
  })

  it('passes the same persisted agent id into the runtime client when adding an agent', async () => {
    const addRoomAgent = vi.fn((roomId: string, agentId: string, profile: string, name: string, description: string, invited: number) => ({
      id: 'row-1', roomId, agentId, profile, name, description, invited,
    }))
    const chatServer = {
      getStorage: () => ownerStorage({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
      }),
      agentClients: {
        createAgent: vi.fn(async () => ({ agentId: 'runtime-agent' })),
        addAgentToRoom: vi.fn(async () => undefined),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      state: { user: owner },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    const persisted = ctx.body.agent
    expect(persisted.agentId).toBeTruthy()
    expect(chatServer.agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: persisted.agentId,
      profile: 'default',
      name: 'Worker',
    }))
  })

  it('does not persist an agent when the runtime client cannot connect', async () => {
    const addRoomAgent = vi.fn()
    const chatServer = {
      getStorage: () => ownerStorage({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
      }),
      agentClients: {
        createAgent: vi.fn(async () => {
          throw new Error('Connection timeout')
        }),
        addAgentToRoom: vi.fn(),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      state: { user: owner },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'Connection timeout',
    })
    expect(addRoomAgent).not.toHaveBeenCalled()
  })

  it('does not persist an agent and disconnects runtime state when room join fails', async () => {
    const addRoomAgent = vi.fn()
    const runtimeClient = { agentId: 'agent-stable-1' }
    const chatServer = {
      getStorage: () => ownerStorage({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
      }),
      agentClients: {
        createAgent: vi.fn(async () => runtimeClient),
        addAgentToRoom: vi.fn(async () => {
          throw new Error('join failed')
        }),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      state: { user: owner },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'join failed',
    })
    expect(addRoomAgent).not.toHaveBeenCalled()
    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
  })

  it('rolls back AgentClients room state when joining a room fails', async () => {
    const clients = new AgentClients()
    const runtimeClient = {
      agentId: 'agent-stable-1',
      name: 'Worker',
      joinRoom: vi.fn(async () => {
        throw new Error('join failed')
      }),
      disconnect: vi.fn(),
    }

    await expect(clients.addAgentToRoom('room-1', runtimeClient as any)).rejects.toThrow('join failed')

    expect(runtimeClient.disconnect).toHaveBeenCalled()
    expect(clients.getAgents('room-1')).toEqual([])
  })

  it('removes the runtime agent by persisted agentId and returns synchronized room state', async () => {
    const agentsBefore = [{ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker', description: '', invited: 0 }]
    const storage = ownerStorage({
      getRoomAgent: vi.fn(() => agentsBefore[0]),
      getRoomAgents: vi.fn(() => []),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn(),
      getRoomMembers: vi.fn(() => [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }]),
    })
    const chatServer = {
      getStorage: () => storage,
      agentClients: { removeAgentFromRoom: vi.fn() },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1', agentId: 'row-1' },
      state: { user: owner },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
    expect(storage.removeRoomMembersForAgent).toHaveBeenCalledWith('room-1', agentsBefore[0])
    expect(storage.removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-1')
    expect(ctx.body).toEqual({
      success: true,
      agents: [],
      members: [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }],
    })
  })

  it('reuses an authenticated member name when the browser has no local group-chat name', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice-login', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ ...ownedRoom, ownerAuthUserId: 42 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => ({
        id: 'member-old',
        userId: 'browser-local-id',
        name: 'Alice Display',
        description: 'saved description',
        joinedAt: 1,
        avatar: '',
        authUserId: 42,
      })),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getMessages: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'alice-login', role: 'user', profiles: [] } },
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-1',
      'auth:42',
      'Alice Display',
      'saved description',
      '',
      42,
    )
    expect(ack.mock.calls[0][0].members).toEqual([
      expect.objectContaining({ userId: 'auth:42', name: 'Alice Display' }),
    ])
  })

  it('ignores client-supplied auth user ids and binds the socket to the authenticated principal', () => {
    const server = Object.create(GroupChatServer.prototype) as any
    server.socketUserMap = new Map()
    server.socketRequestedSourceMap = new Map()
    server.socketAuthUserIdMap = new Map()
    server.userInfoMap = new Map()
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'alice', role: 'user', profiles: [] } },
      handshake: { auth: { authUserId: 99, userId: 'forged-user', name: 'Alice' } },
      on: vi.fn(),
    }

    server.onConnection(socket)

    expect(server.socketUserMap.get('socket-1')).toBe('auth:42')
    expect(server.socketAuthUserIdMap.get('socket-1')).toBe(42)
  })

  it('keeps a member online until their last authenticated socket disconnects', () => {
    const emit = vi.fn()
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([
      ['socket-1', 'auth:42'],
      ['socket-2', 'auth:42'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['socket-1', 'human'],
      ['socket-2', 'human'],
    ])
    server.socketAuthUserIdMap = new Map([
      ['socket-1', 42],
      ['socket-2', 42],
    ])
    server.userInfoMap = new Map([['auth:42', { name: 'Alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.nsp = { to: vi.fn(() => ({ emit })) }
    server.storage = {
      getRoom: vi.fn(() => ({ ...ownedRoom, ownerAuthUserId: 42 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => ({
        id: 'member-1', userId: 'auth:42', name: 'Alice', description: '', joinedAt: 1, authUserId: 42,
      })),
      addRoomMember: vi.fn(),
      getMessages: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const makeSocket = (id: string) => ({
      id,
      data: { authUser: { id: 42, username: 'alice', role: 'user', profiles: [] } },
      join: vi.fn(),
      leave: vi.fn(),
      to: vi.fn(() => ({ emit })),
    })
    const first = makeSocket('socket-1')
    const second = makeSocket('socket-2')

    server.handleJoin(first, { roomId: 'room-1' }, vi.fn())
    server.handleJoin(second, { roomId: 'room-1' }, vi.fn())
    emit.mockClear()

    server.handleDisconnect(first)
    expect(emit).not.toHaveBeenCalledWith('member_left', expect.anything())

    server.handleDisconnect(second)
    expect(emit).toHaveBeenCalledWith('member_left', expect.objectContaining({
      roomId: 'room-1',
      memberId: 'auth:42',
    }))
  })

  it('rejects an outsider socket before joining or persisting room state', () => {
    const server = Object.create(GroupChatServer.prototype) as any
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:43']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 43]])
    server.userInfoMap = new Map([['auth:43', { name: 'Mallory', description: '' }]])
    server.storage = {
      getRoom: vi.fn(() => ({ ...ownedRoom, ownerAuthUserId: 42 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      addRoomMember: vi.fn(),
    }
    const ack = vi.fn()

    server.handleJoin({
      id: 'socket-1',
      data: { authUser: { id: 43, username: 'mallory', role: 'user', profiles: [] } },
    }, { roomId: 'room-1' }, ack)

    expect(ack).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(server.storage.addRoomMember).not.toHaveBeenCalled()
    expect(server.rooms.size).toBe(0)
  })

  it('lists only rooms owned by or joined by the authenticated user', async () => {
    const allRooms = [
      { id: 'room-default', name: 'Default', inviteCode: null, ownerAuthUserId: 2 },
      { id: 'room-private', name: 'Private', inviteCode: null, ownerAuthUserId: 9 },
    ]
    const visibleRooms = [allRooms[0]]
    const storage = {
      getAllRooms: vi.fn(() => allRooms),
      getRoomsForAuthUser: vi.fn(() => visibleRooms),
      getRoom: vi.fn((roomId: string) => allRooms.find(room => room.id === roomId)),
      getMemberByAuthUserId: vi.fn(() => null),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 2, username: 'ops', role: 'admin', profiles: ['default', 'research'] } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getRoomsForAuthUser).toHaveBeenCalledWith(2)
    expect(storage.getAllRooms).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [{ id: 'room-default', name: 'Default', inviteCode: null }] })
  })

  it('keeps room list unrestricted for super admins', async () => {
    const rooms = [{ id: 'room-1', name: 'All', inviteCode: null, ownerAuthUserId: 7 }]
    const storage = {
      getAllRooms: vi.fn(() => rooms),
      getRoomsForAuthUser: vi.fn(() => []),
      getRoom: vi.fn(() => rooms[0]),
      getMemberByAuthUserId: vi.fn(() => null),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/hermes/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getAllRooms).toHaveBeenCalledOnce()
    expect(storage.getRoomsForAuthUser).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [{ id: 'room-1', name: 'All', inviteCode: null }] })
  })

  it('routes @mentions from users and bounded agent replies', () => {
    const server = Object.create(GroupChatServer.prototype) as any
    const emit = vi.fn()
    server.rooms = new Map([
      ['room-1', {
        hasOnlineMember: vi.fn(() => true),
        getOnlineMemberBySocketId: vi.fn((socketId: string) => socketId === 'agent-socket'
          ? { userId: 'agent-1', name: '丫鬟', source: 'agent' }
          : { userId: 'human-1', name: 'Human', source: 'human' }),
      }],
    ])
    server.socketUserMap = new Map([
      ['human-socket', 'human-1'],
      ['agent-socket', 'agent-1'],
    ])
    server.userInfoMap = new Map([
      ['human-1', { name: 'Human', description: '' }],
      ['agent-1', { name: '丫鬟', description: '' }],
    ])
    server.agentClients = {
      getAgents: vi.fn(() => [{ agentId: 'agent-1', profile: 'default', name: '丫鬟' }]),
      removeAgentFromRoom: vi.fn(),
      processMentions: vi.fn(async () => undefined),
    }
    server.storage = {
      saveMessageAndRefreshRoom: vi.fn((msg: any) => ({ message: msg, totalTokens: 123 })),
      isRoomProfileAuthorized: vi.fn(() => true),
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }

    server.handleMessage({ id: 'human-socket' }, { roomId: 'room-1', content: '@all hi', role: 'assistant' }, vi.fn())
    expect(server.storage.saveMessageAndRefreshRoom).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }))
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@all hi',
      senderId: 'human-1',
      mentionDepth: 0,
    }))

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, { roomId: 'room-1', content: '@all agent says hi', role: 'assistant', mentionDepth: 1 }, vi.fn())
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@all agent says hi',
      senderId: 'agent-1',
      mentionDepth: 1,
    }))

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, { roomId: 'room-1', content: '@all too deep', role: 'assistant', mentionDepth: 4 }, vi.fn())
    expect(server.agentClients.processMentions).not.toHaveBeenCalled()

    server.storage.isRoomProfileAuthorized.mockReturnValue(false)
    server.handleMessage({ id: 'human-socket' }, { roomId: 'room-1', content: '@all revoked', role: 'user' }, vi.fn())
    expect(server.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    expect(server.agentClients.processMentions).not.toHaveBeenCalled()
  })
})
