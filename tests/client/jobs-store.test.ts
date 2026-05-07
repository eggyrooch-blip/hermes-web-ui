// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { mockListJobs, mockWakeJobs } = vi.hoisted(() => ({
  mockListJobs: vi.fn(),
  mockWakeJobs: vi.fn(),
}))

vi.mock('@/api/hermes/jobs', () => ({
  listJobs: mockListJobs,
  wakeJobs: mockWakeJobs,
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  runJob: vi.fn(),
}))

import { useJobsStore } from '../../packages/client/src/stores/hermes/jobs'

describe('Hermes jobs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('wakes the gateway and clears connecting state when the refreshed job list is available', async () => {
    mockListJobs
      .mockResolvedValueOnce({
        jobs: [],
        gatewayUnavailable: true,
        errorMessage: 'Proxy error: ECONNREFUSED',
      })
      .mockResolvedValueOnce({
        jobs: [],
        gatewayUnavailable: false,
      })
    mockWakeJobs.mockResolvedValue({
      profile: 'g41a5b5g',
      running: true,
      status: 'ready',
      url: 'http://127.0.0.1:8656',
    })

    const store = useJobsStore()
    await store.fetchJobs()

    expect(mockWakeJobs).toHaveBeenCalledOnce()
    expect(mockListJobs).toHaveBeenCalledTimes(2)
    expect(store.gatewayUnavailable).toBe(false)
    expect(store.error).toBeNull()
    expect(store.loading).toBe(false)
    expect(store.jobs).toEqual([])
  })
})
