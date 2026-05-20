import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testDbInstance: DatabaseSync | null = null
let testDbPath = ''
const originalEnv = process.env

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => testDbInstance,
  getStoragePath: () => testDbPath,
}))

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function createGroupChatServer(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  process.env = {
    ...originalEnv,
    AUTH_DISABLED: '0',
    HERMES_AUTH_MODE: 'feishu-oauth-dev',
    HERMES_WEB_PLANE: 'chat',
    ...env,
  }

  const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
  initAllHermesTables()

  const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
  const httpServer = createServer()
  const groupChatServer = new GroupChatServer(httpServer)
  return { groupChatServer, httpServer }
}

function closeServers(groupChatServer?: any, httpServer?: HttpServer) {
  try { groupChatServer?.getIO?.().close() } catch { /* ignore */ }
  try { httpServer?.close() } catch { /* ignore */ }
}

describe('group-chat internal agent compatibility', () => {
  let workspaceDir = ''
  let groupChatServer: any
  let httpServer: HttpServer | undefined

  beforeEach(() => {
    workspaceDir = makeTempDir('gc-internal-agent-')
    testDbPath = join(workspaceDir, 'hermes-web-ui.db')
    testDbInstance = new DatabaseSync(testDbPath)
  })

  afterEach(() => {
    closeServers(groupChatServer, httpServer)
    groupChatServer = undefined
    httpServer = undefined
    process.env = originalEnv
    if (testDbInstance) {
      testDbInstance.close()
      testDbInstance = null
    }
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
    testDbPath = ''
    vi.clearAllMocks()
  })

  it('accepts server-created agent sockets in Feishu OAuth mode without a browser session cookie', async () => {
    const created = await createGroupChatServer()
    groupChatServer = created.groupChatServer
    httpServer = created.httpServer
    const secret = groupChatServer.agentSocketSecret
    const socket = {
      handshake: {
        auth: { agentId: 'agent-a', agentSecret: secret, name: 'Owned Agent' },
        headers: {},
        query: {},
      },
      data: {},
    }
    const next = vi.fn()

    await groupChatServer.authMiddleware(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data).toMatchObject({
      internalAgent: true,
      internalAgentId: 'agent-a',
    })
  })

  it('allows an internal agent socket to join only rooms where that agent is persisted', async () => {
    const created = await createGroupChatServer()
    groupChatServer = created.groupChatServer
    httpServer = created.httpServer
    const storage = groupChatServer.getStorage()
    storage.saveRoom('room-owned', 'Owned Room', undefined, undefined, 'ou-owner')
    storage.saveRoom('room-other', 'Other Room', undefined, undefined, 'ou-owner')
    storage.addRoomAgent('room-owned', 'agent-a', 'profA', 'Owned Agent', '', 0)

    const makeSocket = () => ({
      id: `socket-${Math.random()}`,
      data: { internalAgent: true, internalAgentId: 'agent-a' },
      join: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
    })

    const allowedSocket = makeSocket()
    const allowedAck = vi.fn()
    groupChatServer.handleJoin(allowedSocket, { roomId: 'room-owned' }, allowedAck)

    expect(allowedAck).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-owned',
      agents: [expect.objectContaining({ agentId: 'agent-a' })],
    }))
    expect(allowedSocket.join).toHaveBeenCalledWith('room-owned')

    const deniedSocket = makeSocket()
    const deniedAck = vi.fn()
    groupChatServer.handleJoin(deniedSocket, { roomId: 'room-other' }, deniedAck)

    expect(deniedAck).toHaveBeenCalledWith({ error: 'Room not found' })
    expect(deniedSocket.join).not.toHaveBeenCalled()
  })
})
