// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({ request: vi.fn() }))

describe('MCP OAuth callback navigation', () => {
  it('allows only HTTP(S) callback URLs', async () => {
    const { safeOAuthCallbackUrl } = await import('@/api/mcpOAuth')

    expect(safeOAuthCallbackUrl('http://127.0.0.1:7777/callback?code=redacted'))
      .toBe('http://127.0.0.1:7777/callback?code=redacted')
    expect(() => safeOAuthCallbackUrl('javascript:alert(1)')).toThrow('callback')
  })
})
