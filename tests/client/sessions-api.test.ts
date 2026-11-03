import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  request: requestMock,
  getApiKey: vi.fn(() => ''),
  getBaseUrlValue: vi.fn(() => ''),
}))

import { consumeSessionExpertSaveError, fetchSessionMessagesPage, setSessionExpert, setSessionModel } from '@/api/hermes/sessions'

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

  it('persists or clears the session expert through the BFF', async () => {
    requestMock.mockResolvedValue({ ok: true })

    await expect(setSessionExpert('session-1', 'expert-a', 'harness', 'profile-a')).resolves.toBe(true)
    expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/sessions/session-1/expert?profile=profile-a', {
      method: 'POST',
      body: JSON.stringify({ expert_id: 'expert-a', execution_engine: 'harness', profile: 'profile-a' }),
    })

    await expect(setSessionExpert('session-1', null, 'hermes', 'profile-a')).resolves.toBe(true)
    expect(requestMock).toHaveBeenLastCalledWith('/api/hermes/sessions/session-1/expert?profile=profile-a', {
      method: 'POST',
      body: JSON.stringify({ expert_id: null, execution_engine: 'hermes', profile: 'profile-a' }),
    })
  })

  it('parks the refusal reason for the session it belongs to, and hands it out once', async () => {
    requestMock.mockRejectedValue(Object.assign(
      new Error('API Error 409: Expert is fixed once the session has messages'),
      { status: 409 },
    ))

    await expect(setSessionExpert('session-1', 'expert-a', 'hermes')).resolves.toBe(false)

    // Another session's save must not inherit it.
    expect(consumeSessionExpertSaveError('session-2')).toBeNull()

    expect(consumeSessionExpertSaveError('session-1')).toEqual({
      status: 409,
      message: 'API Error 409: Expert is fixed once the session has messages',
    })
    // Consuming clears it, so a later generic failure can never replay a 409.
    expect(consumeSessionExpertSaveError('session-1')).toBeNull()
  })

  it('falls back to the status embedded in the message when the Error carries none', async () => {
    requestMock.mockRejectedValue(new Error('API Error 500: upstream exploded'))

    await expect(setSessionExpert('session-3', 'expert-a', 'hermes')).resolves.toBe(false)
    expect(consumeSessionExpertSaveError('session-3')).toEqual({
      status: 500,
      message: 'API Error 500: upstream exploded',
    })

    requestMock.mockRejectedValue(new Error('Unauthorized'))
    await expect(setSessionExpert('session-3', 'expert-a', 'hermes')).resolves.toBe(false)
    expect(consumeSessionExpertSaveError('session-3')).toEqual({ status: null, message: 'Unauthorized' })
  })

  it('clears a recorded refusal once the save succeeds', async () => {
    requestMock.mockRejectedValue(Object.assign(new Error('API Error 409: fixed'), { status: 409 }))
    await expect(setSessionExpert('session-4', 'expert-a', 'hermes')).resolves.toBe(false)

    requestMock.mockResolvedValue({ ok: true })
    await expect(setSessionExpert('session-4', 'expert-b', 'hermes')).resolves.toBe(true)

    expect(consumeSessionExpertSaveError('session-4')).toBeNull()
  })
})
