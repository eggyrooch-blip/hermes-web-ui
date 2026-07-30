import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  request: requestMock,
  getApiKey: vi.fn(() => ''),
  getBaseUrlValue: vi.fn(() => ''),
}))

import { fetchSessionMessagesPage, setSessionModel } from '@/api/hermes/sessions'

describe('sessions api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bounds paginated message hydration with an abort signal', async () => {
    requestMock.mockResolvedValue({
      session: { id: 'session-1' },
      messages: [],
      total: 0,
      offset: 0,
      limit: 150,
      hasMore: false,
    })

    await fetchSessionMessagesPage('session-1', 0, 150, 'tester')

    expect(requestMock).toHaveBeenCalledWith(
      '/api/hermes/sessions/conversations/session-1/messages/paginated?offset=0&limit=150&profile=tester',
      { signal: expect.any(AbortSignal) },
    )
  })

  it('logs paginated hydration failures while preserving the nullable contract', async () => {
    const failure = new Error('network unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    requestMock.mockRejectedValue(failure)

    await expect(fetchSessionMessagesPage('session-1', 0, 150, 'tester')).resolves.toBeNull()

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to fetch paginated session messages:',
      failure,
    )
    errorSpy.mockRestore()
  })

  it('carries the BFF cross-family notice through the model switch response', async () => {
    requestMock.mockResolvedValue({ ok: true, family_switch_notice: true })

    await expect(setSessionModel('session-1', 'gpt-5.5', 'openai')).resolves.toEqual({
      ok: true,
      familySwitchNotice: true,
    })

    // A plain ack must not toast, and a failed switch must not either.
    requestMock.mockResolvedValue({ ok: true })
    await expect(setSessionModel('session-1', 'gpt-5.5', 'openai')).resolves.toEqual({
      ok: true,
      familySwitchNotice: false,
    })

    requestMock.mockRejectedValue(new Error('offline'))
    await expect(setSessionModel('session-1', 'gpt-5.5', 'openai')).resolves.toEqual({
      ok: false,
      familySwitchNotice: false,
    })
  })
})
