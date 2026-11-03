import { describe, expect, it } from 'vitest'

import { bridgeTerminalError } from '../../packages/server/src/services/hermes/run-chat/handle-bridge-run'

describe('bridge terminal error detection', () => {
  it('uses bridge status errors directly', () => {
    expect(bridgeTerminalError({
      status: 'error',
      error: 'bridge crashed',
      result: null,
    } as any)).toBe('bridge crashed')
  })

  it('surfaces agent result failure flags as run failures', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      error: undefined,
      result: {
        failed: true,
        completed: false,
        error: 'API call failed after 3 retries. HTTP 503: no available channel',
        final_response: 'API call failed after 3 retries. HTTP 503: no available channel',
      },
    } as any)).toBe('API call failed after 3 retries. HTTP 503: no available channel')
  })

  it('falls back to final_response for failed results without an error field', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        completed: false,
        final_response: 'API call failed after 3 retries: timeout',
      },
    } as any)).toBe('API call failed after 3 retries: timeout')
  })

  it('surfaces HTTP auth/provider errors even when failure flags are missing', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        final_response: 'API call failed after 3 retries. HTTP 403: forbidden',
      },
    } as any)).toBe('API call failed after 3 retries. HTTP 403: forbidden')

    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        error: 'HTTP 401: unauthorized',
      },
    } as any)).toBe('HTTP 401: unauthorized')
  })

  it('surfaces generic provider result errors even without failed flags', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        error: '分组 subrouter 下模型 test 无可用渠道（distributor）',
      },
    } as any)).toBe('分组 subrouter 下模型 test 无可用渠道（distributor）')
  })

  it('surfaces explicit result errors even when failure flags are missing', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        error: 'HTTP 400: Bad Request',
      },
    } as any)).toBe('HTTP 400: Bad Request')
  })

  it('does not flag successful complete results', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        completed: true,
        final_response: 'done',
      },
    } as any)).toBeNull()
  })

  it('does not flag successful results that describe HTTP 401 handling', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        completed: true,
        final_response: 'Added handling for HTTP 401 responses and verified the login error state.',
      },
    } as any)).toBeNull()
  })

  it('does not flag successful results that describe HTTP 403 handling', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        completed: true,
        final_response: 'Documented how HTTP 403 failed permission checks are displayed in the UI.',
      },
    } as any)).toBeNull()
  })

  it('does not treat a successful result message as an error', () => {
    expect(bridgeTerminalError({
      status: 'complete',
      result: {
        completed: true,
        message: 'All checks passed after verifying error and failed display states.',
        final_response: 'All checks passed.',
      },
    } as any)).toBeNull()
  })
})
