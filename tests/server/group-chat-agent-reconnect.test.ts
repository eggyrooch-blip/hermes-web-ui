import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server, type Namespace } from 'socket.io'

vi.mock('../../packages/server/src/services/auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

import { AgentClients } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

// Port of the rejoin half of upstream EKKOLearnAI/hermes-web-ui 0d7c6c3e9: the
// Manager-level `reconnect` event fires before the /group-chat namespace socket
// is connected, so joinRoom() hit ensureConnected() and every rejoin failed.
// Rejoin must run on the namespace `connect` event instead.
describe('group Agent rejoins rooms after a transport reconnect', () => {
  let http: HttpServer
  let ioServer: Server
  let namespace: Namespace
  let port: number
  let agent: any
  let dropJoinAcks = false
  let swallowedJoins = 0

  beforeEach(async () => {
    dropJoinAcks = false
    swallowedJoins = 0
    http = createServer()
    ioServer = new Server(http, { transports: ['websocket'] })
    namespace = ioServer.of('/group-chat')
    namespace.on('connection', socket => {
      socket.on('join', ({ roomId }: { roomId: string }, ack: (res: unknown) => void) => {
        if (dropJoinAcks) { swallowedJoins++; return }
        socket.join(roomId)
        ack({ roomId, roomName: 'Room', members: [], messages: [], rooms: [roomId] })
      })
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    port = (http.address() as AddressInfo).port

    agent = await new AgentClients().createAgent(
      { agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0 },
      {},
      port,
    )
    await agent.joinRoom('room-1')
  })

  afterEach(async () => {
    agent?.disconnect()
    await new Promise<void>(resolve => ioServer.close(() => resolve()))
  })

  it('rejoins after each transport reconnect once the group namespace is connected', async () => {
    const socket = agent.socket
    socket.io.reconnectionDelay(10)
    socket.io.reconnectionDelayMax(20)
    socket.io.randomizationFactor(0)

    for (let attempt = 0; attempt < 2; attempt++) {
      const oldId = socket.id as string
      const connected = new Promise<void>(resolve => socket.once('connect', () => resolve()))
      namespace.sockets.get(oldId)!.conn.close()
      await connected
      expect(socket.id).not.toBe(oldId)
      await vi.waitFor(() => {
        expect(namespace.sockets.get(socket.id)?.rooms.has('room-1')).toBe(true)
      })
    }
    expect(agent.getJoinedRooms()).toEqual(['room-1'])
  })

  it('recovers when a rejoin ack never arrives: times out, resets, and rejoins on the next reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const socket = agent.socket
      socket.io.reconnectionDelay(10)
      socket.io.reconnectionDelayMax(20)
      socket.io.randomizationFactor(0)
      dropJoinAcks = true

      let oldId = socket.id as string
      let connected = new Promise<void>(resolve => socket.once('connect', () => resolve()))
      namespace.sockets.get(oldId)!.conn.close()
      await connected
      await vi.waitFor(() => expect(swallowedJoins).toBe(1))
      expect(agent._reconnecting).toBe(true)

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(agent._reconnecting).toBe(false))

      dropJoinAcks = false
      oldId = socket.id as string
      connected = new Promise<void>(resolve => socket.once('connect', () => resolve()))
      namespace.sockets.get(oldId)!.conn.close()
      await connected
      await vi.waitFor(() => {
        expect(namespace.sockets.get(socket.id)?.rooms.has('room-1')).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rejoin after an explicit disconnect', async () => {
    const socket = agent.socket
    socket.io.reconnectionDelay(10)
    socket.io.reconnectionDelayMax(20)
    const joinSpy = vi.spyOn(agent, 'joinRoom')
    const connectSpy = vi.fn()
    socket.on('connect', connectSpy)
    agent.disconnect()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(agent.socket).toBeNull()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(joinSpy).not.toHaveBeenCalled()
    expect(agent.connected).toBe(false)
  })
})
