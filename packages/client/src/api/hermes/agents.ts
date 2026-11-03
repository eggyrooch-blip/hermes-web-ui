import { request } from '../client'

export type AgentShareRole = 'viewer' | 'editor' | 'manager'
export type AgentShareGrantee = {
  provider: 'feishu' | string
  type: 'email' | 'user_id' | string
  value: string
}

export interface AgentSharePrincipal {
  provider: string
  display_name?: string
  avatar_url?: string
  email?: string
  user_id?: string
}

export interface AgentShare {
  agent_id: string
  grantee_open_id: string
  share_id?: string
  grantee_principal_id?: string
  role: AgentShareRole | string
  status: string
  principal?: AgentSharePrincipal
  created_by_open_id?: string
  created_by_principal_id?: string
  created_at?: number
  updated_at?: number
  revoked_at?: number | null
}

export async function fetchAgentShares(agentId: string): Promise<AgentShare[]> {
  const res = await request<{ shares: AgentShare[] }>(`/api/hermes/agents/${encodeURIComponent(agentId)}/shares`)
  return Array.isArray(res.shares) ? res.shares : []
}

export async function grantAgentShare(agentId: string, grantee: string | AgentShareGrantee, role: AgentShareRole): Promise<AgentShare> {
  const body = typeof grantee === 'string'
    ? { granteeOpenId: grantee, role }
    : { grantee, role }
  const res = await request<{ share: AgentShare }>(`/api/hermes/agents/${encodeURIComponent(agentId)}/shares`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return res.share
}

export async function revokeAgentShare(agentId: string, shareIdOrGranteeOpenId: string): Promise<void> {
  await request(`/api/hermes/agents/${encodeURIComponent(agentId)}/shares/${encodeURIComponent(shareIdOrGranteeOpenId)}`, {
    method: 'DELETE',
  })
}
