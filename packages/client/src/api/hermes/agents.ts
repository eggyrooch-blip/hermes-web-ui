import { request } from '../client'

export type AgentShareRole = 'viewer' | 'editor' | 'manager'

export interface AgentShare {
  agent_id: string
  grantee_open_id: string
  role: AgentShareRole | string
  status: string
  created_by_open_id?: string
  created_at?: number
  updated_at?: number
  revoked_at?: number | null
}

export async function fetchAgentShares(agentId: string): Promise<AgentShare[]> {
  const res = await request<{ shares: AgentShare[] }>(`/api/hermes/agents/${encodeURIComponent(agentId)}/shares`)
  return Array.isArray(res.shares) ? res.shares : []
}

export async function grantAgentShare(agentId: string, granteeOpenId: string, role: AgentShareRole): Promise<AgentShare> {
  const res = await request<{ share: AgentShare }>(`/api/hermes/agents/${encodeURIComponent(agentId)}/shares`, {
    method: 'POST',
    body: JSON.stringify({ granteeOpenId, role }),
  })
  return res.share
}

export async function revokeAgentShare(agentId: string, granteeOpenId: string): Promise<void> {
  await request(`/api/hermes/agents/${encodeURIComponent(agentId)}/shares/${encodeURIComponent(granteeOpenId)}`, {
    method: 'DELETE',
  })
}
