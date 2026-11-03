// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn(async () => ({ job: { id: 'job-1' } })))

vi.mock('@/api/client', () => ({
  request: mockRequest,
  getBaseUrlValue: () => 'http://localhost',
  getApiKey: () => '',
}))

import { createJob } from '@/api/hermes/jobs'

describe('createJob executor transport (M-0)', () => {
  beforeEach(() => {
    mockRequest.mockClear()
  })

  it('sends the selected agent profile as X-Hermes-Profile plus the query selector', async () => {
    await createJob(
      { name: 'agent task', schedule: '0 9 * * *', expert_id: 'hr-expert' },
      { profile: 'agent_prof' },
    )

    const [path, options] = mockRequest.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/hermes/jobs?profile=agent_prof')
    expect((options.headers as Record<string, string>)['X-Hermes-Profile']).toBe('agent_prof')
    expect(JSON.parse(options.body as string)).toMatchObject({ expert_id: 'hr-expert' })
  })

  it('keeps the legacy request byte-identical when no executor is selected', async () => {
    await createJob({ name: 'plain task', schedule: '0 9 * * *' })

    const [path, options] = mockRequest.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/hermes/jobs')
    expect(options.headers).toBeUndefined()
    expect(JSON.parse(options.body as string).expert_id).toBeUndefined()
  })
})
