import type { Context } from 'koa'
import { config } from '../../config'
import type { WebUser } from '../../services/request-context'

function actor(ctx: Context): Partial<WebUser> | undefined {
  return ctx.state?.user as Partial<WebUser> | undefined
}

function actorOpenId(ctx: Context): string {
  const value = actor(ctx)?.openid
  return typeof value === 'string' ? value.trim() : ''
}

function setHeaderIfPresent(headers: Record<string, string>, name: string, value: unknown): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed) headers[name] = trimmed
}

function brokerHeaders(ctx: Context): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  const user = actor(ctx)
  const openid = actorOpenId(ctx)
  if (openid) headers['X-Hermes-Owner-Open-Id'] = openid
  if (user?.userId && user?.tenantKey) {
    headers['X-Hermes-Actor-Provider'] = 'feishu'
    setHeaderIfPresent(headers, 'X-Hermes-Actor-Tenant-Key', user.tenantKey)
    setHeaderIfPresent(headers, 'X-Hermes-Actor-App-Id', user.appId || config.feishuAppId)
    setHeaderIfPresent(headers, 'X-Hermes-Actor-User-Id', user.userId)
    setHeaderIfPresent(headers, 'X-Hermes-Actor-Display-Name', user.name)
    setHeaderIfPresent(headers, 'X-Hermes-Actor-Avatar-Url', user.avatarUrl)
    setHeaderIfPresent(headers, 'X-Hermes-Actor-Email', user.email)
  }
  return headers
}

function brokerUrl(path: string): string {
  if (!config.runBrokerUrl) {
    const err: any = new Error('HERMES_RUN_BROKER_URL is required for agent sharing')
    err.status = 503
    throw err
  }
  return `${config.runBrokerUrl}${path}`
}

async function pipeBroker(ctx: Context, res: Response): Promise<void> {
  const body = await res.json().catch(async () => ({ error: await res.text().catch(() => 'Broker request failed') }))
  ctx.status = res.status
  ctx.body = body
}

function handleBrokerError(ctx: Context, err: any): void {
  ctx.status = typeof err?.status === 'number' ? err.status : 500
  ctx.body = { error: err?.message || 'Agent sharing request failed' }
}

function requireActor(ctx: Context): boolean {
  if (actorOpenId(ctx)) return true
  ctx.status = 403
  ctx.body = { error: 'Feishu user identity required' }
  return false
}

export async function listSharedAgents(ctx: Context) {
  if (!requireActor(ctx)) return
  try {
    const res = await fetch(brokerUrl('/api/run-broker/agents/shared'), {
      method: 'GET',
      headers: brokerHeaders(ctx),
    })
    await pipeBroker(ctx, res)
  } catch (err: any) {
    handleBrokerError(ctx, err)
  }
}

export async function listShares(ctx: Context) {
  if (!requireActor(ctx)) return
  try {
    const agentId = encodeURIComponent(String(ctx.params.agentId || ''))
    const res = await fetch(brokerUrl(`/api/run-broker/agents/${agentId}/shares`), {
      method: 'GET',
      headers: brokerHeaders(ctx),
    })
    await pipeBroker(ctx, res)
  } catch (err: any) {
    handleBrokerError(ctx, err)
  }
}

export async function grantShare(ctx: Context) {
  if (!requireActor(ctx)) return
  try {
    const agentId = encodeURIComponent(String(ctx.params.agentId || ''))
    const body = ctx.request.body as {
      granteeOpenId?: string
      grantee_open_id?: string
      grantee?: { provider?: string; type?: string; value?: string }
      role?: string
    }
    const brokerBody: Record<string, unknown> = { role: body.role || '' }
    if (body.grantee && typeof body.grantee === 'object') {
      brokerBody.grantee = body.grantee
    } else {
      brokerBody.grantee_open_id = body.grantee_open_id || body.granteeOpenId || ''
    }
    const res = await fetch(brokerUrl(`/api/run-broker/agents/${agentId}/shares`), {
      method: 'POST',
      headers: brokerHeaders(ctx),
      body: JSON.stringify(brokerBody),
    })
    await pipeBroker(ctx, res)
  } catch (err: any) {
    handleBrokerError(ctx, err)
  }
}

export async function revokeShare(ctx: Context) {
  if (!requireActor(ctx)) return
  try {
    const agentId = encodeURIComponent(String(ctx.params.agentId || ''))
    const granteeOpenId = encodeURIComponent(String(ctx.params.granteeOpenId || ''))
    const res = await fetch(brokerUrl(`/api/run-broker/agents/${agentId}/shares/${granteeOpenId}`), {
      method: 'DELETE',
      headers: brokerHeaders(ctx),
    })
    await pipeBroker(ctx, res)
  } catch (err: any) {
    handleBrokerError(ctx, err)
  }
}
