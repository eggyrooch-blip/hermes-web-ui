// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
  getApiKey: vi.fn(() => ''),
}))

import {
  cloneRoom,
  clearRoomContext,
  joinRoomByCode,
} from '../../packages/client/src/api/hermes/group-chat'

describe('Group chat API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('posts clone and clear-context room operations to scoped endpoints', async () => {
    mockRequest
      .mockResolvedValueOnce({ room: { id: 'copy-room' }, agents: [] })
      .mockResolvedValueOnce({ success: true, room: { id: 'room-1' } })

    await expect(cloneRoom('room-1', { name: 'Copy', inviteCode: 'ABC12345' })).resolves.toEqual({ room: { id: 'copy-room' }, agents: [] })
    await expect(clearRoomContext('room-1')).resolves.toEqual({ success: true, room: { id: 'room-1' } })

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/group-chat/rooms/room-1/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Copy', inviteCode: 'ABC12345' }) }],
      ['/api/hermes/group-chat/rooms/room-1/clear-context', { method: 'POST' }],
    ])
  })

  it('uses POST when an invite code creates persistent membership', async () => {
    mockRequest.mockResolvedValueOnce({ room: { id: 'room-1' } })

    await joinRoomByCode('JOINME88')

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/group-chat/rooms/join/JOINME88', { method: 'POST' })
  })
})
