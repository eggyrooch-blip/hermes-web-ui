import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListPendingWrites = vi.hoisted(() => vi.fn())
const mockGetRequestProfile = vi.hoisted(() => vi.fn())
const mockIsChatPlaneRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/write-gate', () => ({
  approvePendingWrite: vi.fn(),
  getPendingWriteReview: vi.fn(),
  listPendingWrites: mockListPendingWrites,
  rejectPendingWrite: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'active-profile'),
}))

vi.mock('../../packages/server/src/services/request-context', () => ({
  getRequestProfile: mockGetRequestProfile,
  isChatPlaneRequest: mockIsChatPlaneRequest,
}))

import { list } from '../../packages/server/src/controllers/hermes/write-gate'

describe('write-gate controller profile binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListPendingWrites.mockResolvedValue({ records: [], counts: { memory: 0, skills: 0 }, supported: true })
    mockGetRequestProfile.mockReturnValue('bound-feishu-profile')
    mockIsChatPlaneRequest.mockReturnValue(false)
  })

  it('uses the Feishu-bound request profile in chat plane', async () => {
    mockIsChatPlaneRequest.mockReturnValue(true)
    const ctx = {
      state: { profile: { name: 'stale-global-profile' } },
      body: undefined,
    } as any

    await list(ctx)

    expect(mockGetRequestProfile).toHaveBeenCalledWith(ctx)
    expect(mockListPendingWrites).toHaveBeenCalledWith('bound-feishu-profile')
    expect(ctx.body).toEqual({ records: [], counts: { memory: 0, skills: 0 }, supported: true })
  })
})
