// API-boundary pin for submitGitlabToken (codex round-1 review):
// the view-level test mocks this module, so URL construction itself needs its
// own test — otherwise the profile hint can silently regress to a no-op while
// everything above stays green and group binds land as personal.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  request: requestMock,
}))

import { submitGitlabToken } from '@/api/skillCredentials'

describe('submitGitlabToken URL construction', () => {
  beforeEach(() => {
    requestMock.mockReset()
    requestMock.mockResolvedValue({ ok: true })
  })

  it('encodes the panel profile as a query param', async () => {
    await submitGitlabToken({ tier: 'read', token: 'glpat-x' }, 'feishu_group_x')

    const [url, init] = requestMock.mock.calls[0] as [string, any]
    expect(url).toBe('/api/hermes/credentials/gitlab?profile=feishu_group_x')
    expect(JSON.parse(init.body)).toEqual({ tier: 'read', token: 'glpat-x' })
  })

  it('profile needing escaping is URL-encoded, not string-glued', async () => {
    await submitGitlabToken({ tier: 'read', token: 'glpat-x' }, 'a b&c')

    const [url] = requestMock.mock.calls[0] as [string, any]
    expect(url).toBe('/api/hermes/credentials/gitlab?profile=a+b%26c')
  })

  it('absent or blank profile keeps the legacy path byte-identical', async () => {
    await submitGitlabToken({ tier: 'write', token: 'glpat-y' })
    await submitGitlabToken({ tier: 'write', token: 'glpat-y' }, '   ')

    for (const call of requestMock.mock.calls) {
      expect(call[0]).toBe('/api/hermes/credentials/gitlab')
    }
  })
})
