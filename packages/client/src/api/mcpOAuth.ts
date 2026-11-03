import { request } from './client'

export interface McpOAuthApprovalResult {
  ok: true
  redirect_url: string
}

export interface McpOAuthRequest {
  client_id: string
  client_name: string
  redirect_origin: string
  scopes: string[]
}

export function getMcpOAuthRequest(requestId: string): Promise<McpOAuthRequest> {
  return request(`/api/auth/mcp-oauth/requests/${encodeURIComponent(requestId)}`)
}

export function approveMcpOAuth(requestId: string): Promise<McpOAuthApprovalResult> {
  return request('/api/auth/mcp-oauth/approve', {
    method: 'POST',
    body: JSON.stringify({ request_id: requestId }),
  })
}

export function navigateToOAuthClient(url: string): void {
  window.location.assign(safeOAuthCallbackUrl(url))
}

export function safeOAuthCallbackUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol.toLowerCase())) {
    throw new Error('Unsupported OAuth callback URL')
  }
  return url.toString()
}
