import type { Context } from 'koa'
import { config } from '../config'
import type { WebUser } from '../services/request-context'

const REQUEST_ID = /^hma_[A-Za-z0-9_-]{6,120}$/
const BROKER_ERROR_STATUSES = new Set([400, 403, 404, 410])

function safeRedirectUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol.toLowerCase()) ? url.toString() : null
  } catch {
    return null
  }
}

function brokerHeaders(ctx: Context): Record<string, string> | null {
  const user = ctx.state?.user as WebUser | undefined
  const owner = user?.openid?.trim()
  const profile = user?.profile?.trim()
  if (!owner || !profile) {
    ctx.status = 403
    ctx.body = { error: '无法确认你的身份，请重新登录后再试' }
    return null
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Owner-Open-Id': owner,
    'X-Hermes-Profile': profile,
  }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  return headers
}

export async function getMcpOAuthRequest(ctx: Context): Promise<void> {
  const headers = brokerHeaders(ctx)
  if (!headers) return
  const requestId = String(ctx.params.requestId ?? '').trim()
  if (!REQUEST_ID.test(requestId)) {
    ctx.status = 400
    ctx.body = { error: '授权请求无效或已损坏' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'MCP 授权服务暂时不可用' }
    return
  }
  try {
    const response = await fetch(
      `${config.runBrokerUrl}/api/run-broker/connectors/mcp-oauth/requests/${encodeURIComponent(requestId)}`,
      { headers },
    )
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    const clientId = typeof body.client_id === 'string' ? body.client_id.slice(0, 200) : ''
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : ''
    const redirectOrigin = safeRedirectUrl(body.redirect_origin)
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length <= 100).slice(0, 10)
      : []
    if (!response.ok || !clientId || !clientName || !redirectOrigin || !scopes.length) {
      ctx.status = BROKER_ERROR_STATUSES.has(response.status) ? response.status : 502
      ctx.body = { error: 'MCP 授权请求无效、已过期或无法读取' }
      return
    }
    ctx.body = { client_id: clientId, client_name: clientName, redirect_origin: redirectOrigin, scopes }
  } catch {
    ctx.status = 502
    ctx.body = { error: '暂时联系不上 MCP 授权服务，请稍后重试' }
  }
}

export async function approveMcpOAuth(ctx: Context): Promise<void> {
  const headers = brokerHeaders(ctx)
  if (!headers) return
  if (ctx.get('Origin') !== ctx.origin || ctx.is('application/json') !== 'application/json') {
    ctx.status = 403
    ctx.body = { error: '授权请求来源无效' }
    return
  }

  const requestId = String((ctx.request.body as Record<string, unknown> | undefined)?.request_id ?? '').trim()
  if (!REQUEST_ID.test(requestId)) {
    ctx.status = 400
    ctx.body = { error: '授权请求无效或已损坏' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'MCP 授权服务暂时不可用' }
    return
  }

  try {
    const response = await fetch(`${config.runBrokerUrl}/api/run-broker/connectors/mcp-oauth/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request_id: requestId }),
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    const redirectUrl = safeRedirectUrl(body.redirect_url)
    if (!response.ok || body.ok !== true || !redirectUrl) {
      ctx.status = BROKER_ERROR_STATUSES.has(response.status) ? response.status : 502
      ctx.body = { error: 'MCP 授权请求无效、已过期或无法完成' }
      return
    }
    ctx.status = 200
    ctx.body = { ok: true, redirect_url: redirectUrl }
  } catch {
    ctx.status = 502
    ctx.body = { error: '暂时联系不上 MCP 授权服务，请稍后重试' }
  }
}
