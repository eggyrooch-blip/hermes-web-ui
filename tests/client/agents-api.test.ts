import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  request: mockRequest,
}))

import { fetchAgentShares, grantAgentShare, revokeAgentShare } from '@/api/hermes/agents'

describe('agents api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('proxies agent share management through the WebUI BFF', async () => {
    mockRequest.mockResolvedValueOnce({ shares: [] })
    await fetchAgentShares('agent/shared id')
    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/agents/agent%2Fshared%20id/shares')

    mockRequest.mockResolvedValueOnce({ share: { role: 'editor' } })
    await grantAgentShare('agent-shared', 'ou_editor', 'editor')
    expect(mockRequest).toHaveBeenLastCalledWith('/api/hermes/agents/agent-shared/shares', {
      method: 'POST',
      body: JSON.stringify({ granteeOpenId: 'ou_editor', role: 'editor' }),
    })

    mockRequest.mockResolvedValueOnce({ success: true })
    await revokeAgentShare('agent-shared', 'ou/editor')
    expect(mockRequest).toHaveBeenLastCalledWith('/api/hermes/agents/agent-shared/shares/ou%2Feditor', {
      method: 'DELETE',
    })
  })

  it('grants shares by provider-neutral grantee lookup', async () => {
    mockRequest.mockResolvedValueOnce({ share: { role: 'manager', grantee_principal_id: 'prn_editor' } })

    await grantAgentShare('agent-shared', {
      provider: 'feishu',
      type: 'email',
      value: 'editor@example.test',
    }, 'manager')

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/agents/agent-shared/shares', {
      method: 'POST',
      body: JSON.stringify({
        grantee: {
          provider: 'feishu',
          type: 'email',
          value: 'editor@example.test',
        },
        role: 'manager',
      }),
    })
  })
})
