import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const socketMocks = vi.hoisted(() => ({
  sockets: [] as any[],
}))

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socket: any = {
      id: `socket-${socketMocks.sockets.length + 1}`,
      connected: true,
      handlers: new Map<string, Function[]>(),
      io: {
        on: vi.fn(),
      },
      emit: vi.fn((event: string, payload: any, ack?: Function) => {
        if (event === 'join') {
          ack?.({ roomId: payload.roomId, roomName: payload.roomId, members: [], messages: [], rooms: [] })
          return
        }
        if (event === 'message') {
          ack?.({ id: `msg-${socket.emit.mock.calls.length}` })
        }
      }),
      on: vi.fn((event: string, cb: Function) => {
        const handlers = socket.handlers.get(event) || []
        handlers.push(cb)
        socket.handlers.set(event, handlers)
        if (event === 'connect') queueMicrotask(() => cb())
        return socket
      }),
      disconnect: vi.fn(() => {
        socket.connected = false
      }),
    }
    socketMocks.sockets.push(socket)
    return socket
  }),
}))

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { config } from '../../packages/server/src/config'
import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

describe('group-chat agent run broker compatibility', () => {
  const originalConfig = {
    webuiRunBroker: config.webuiRunBroker,
    runBrokerUrl: config.runBrokerUrl,
    runBrokerKey: config.runBrokerKey,
  }
  const originalFetch = global.fetch

  beforeEach(() => {
    socketMocks.sockets.length = 0
    config.webuiRunBroker = true
    config.runBrokerUrl = 'http://broker.test'
    config.runBrokerKey = 'broker-secret'
  })

  afterEach(() => {
    config.webuiRunBroker = originalConfig.webuiRunBroker
    config.runBrokerUrl = originalConfig.runBrokerUrl
    config.runBrokerKey = originalConfig.runBrokerKey
    global.fetch = originalFetch
    vi.clearAllMocks()
  })

  it('routes group-chat agent replies through the run broker with the room owner identity', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('event: content\ndata: {"kind":"content","run_id":"run-1","text":"broker reply"}\n\n'))
        controller.enqueue(enc.encode('event: done\ndata: {"kind":"done","run_id":"run-1"}\n\n'))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as any

    const clients = new AgentClients()
    clients.setGatewayManager({
      getUpstream: vi.fn(() => 'http://profile-gateway.test'),
      getApiKey: vi.fn(() => null),
    } as any)
    clients.setStorage({
      getRoom: vi.fn(() => ({
        id: 'room-1',
        owner_open_id: 'ou_owner',
        triggerTokens: 4000,
        maxHistoryTokens: 2000,
        tailMessageCount: 10,
      })),
      getRoomMembers: vi.fn(() => []),
    })
    const agent = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'feishu_g41a5b5g',
      name: 'feishu_g41a5b5g',
      description: 'group agent',
      invited: 0,
    })
    await clients.addAgentToRoom('room-1', agent)

    await agent.replyToMention('room-1', {
      content: '@feishu_g41a5b5g hello',
      senderName: '孙可',
      senderId: 'ou_sender',
      timestamp: Date.now(),
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('http://broker.test/api/run-broker/runs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer broker-secret',
        'X-Hermes-Owner-Open-Id': 'ou_owner',
        'X-Hermes-Feishu-OpenId': 'ou_owner',
      }),
    }))
    const request = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(request).toEqual(expect.objectContaining({
      channel: 'webui',
      profile_name: 'feishu_g41a5b5g',
      user_key: 'ou_owner',
      credential_subject: 'ou_owner',
      delivery_mode: 'socket',
      requires_host_tools: true,
    }))
    expect(request.content).toContain('原始消息：hello')

    const socket = socketMocks.sockets[0]
    expect(socket.emit).toHaveBeenCalledWith('message', { roomId: 'room-1', content: 'broker reply' }, expect.any(Function))
  })
})
