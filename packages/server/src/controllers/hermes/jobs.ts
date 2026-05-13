import type { Context } from 'koa'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { getRequestProfile, isChatPlaneRequest, type WebUser } from '../../services/request-context'

function getUpstream(profile: string): string {
  const mgr = getGatewayManagerInstance()
  if (!mgr) {
    throw new Error('GatewayManager not initialized')
  }
  return mgr.getUpstream(profile)
}

function getApiKey(profile: string): string | null {
  const mgr = getGatewayManagerInstance()
  return mgr?.getApiKey(profile) ?? null
}

function resolveProfile(ctx: Context): string {
  return getRequestProfile(ctx)
}

function getChatPlaneOpenId(ctx: Context): string | undefined {
  if (!isChatPlaneRequest(ctx)) return undefined
  const user = ctx.state?.user as WebUser | undefined
  const openid = user?.openid?.trim()
  return openid || undefined
}

function buildHeaders(profile: string, ctx: Context): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = getApiKey(profile)
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const openid = getChatPlaneOpenId(ctx)
  if (openid) headers['X-Hermes-Feishu-OpenId'] = openid
  return headers
}

const TIMEOUT_MS = 30_000
const CHAT_PLANE_BODY_BLOCKLIST = new Set([
  'profile',
  'x-hermes-profile',
  'token',
  'provider',
  'base_url',
  'api_key',
  'apiKey',
  'authorization',
])

function sanitizeChatPlaneBody(ctx: Context, value: unknown): unknown {
  if (!isChatPlaneRequest(ctx) || !value || typeof value !== 'object' || Array.isArray(value)) return value

  const sanitized: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (CHAT_PLANE_BODY_BLOCKLIST.has(key)) continue
    sanitized[key] = fieldValue
  }
  return sanitized
}

function normalizeChatPlaneJobBody(ctx: Context, profile: string, upstreamPath: string, method: string, value: unknown): unknown {
  if (!isChatPlaneRequest(ctx) || !value || typeof value !== 'object' || Array.isArray(value)) return value

  const body = { ...(value as Record<string, unknown>) }
  delete body.owner_open_id
  delete body.owner_profile

  const openid = getChatPlaneOpenId(ctx)
  if (openid) {
    body.owner_open_id = openid
    body.owner_profile = profile
  }

  if (method === 'POST' && upstreamPath === '/api/jobs') {
    const deliveryMode = typeof body.delivery_mode === 'string' ? body.delivery_mode : ''
    delete body.delivery_mode
    if (deliveryMode === 'history_only') {
      body.deliver = 'local'
    } else if (deliveryMode === 'feishu_origin') {
      body.deliver = 'origin'
    } else if (!body.deliver || body.deliver === 'origin' || deliveryMode === 'feishu_default') {
      body.deliver = 'feishu'
    }
  }

  return body
}

async function readUpstreamError(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return await res.json()
    } catch {
      // Fall through to a stable error shape below.
    }
  }

  const text = await res.text().catch(() => '')
  return { error: { message: text || `Upstream error: ${res.status} ${res.statusText}` } }
}

async function proxyRequest(
  ctx: Context,
  upstreamPath: string,
  method?: string,
  options: { fallbackUnavailableJobList?: boolean } = {},
): Promise<void> {
  const profile = resolveProfile(ctx)
  let upstream: string
  try {
    upstream = getUpstream(profile)
  } catch (e: any) {
    ctx.status = 503
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: { message: e?.message || 'GatewayManager not initialized' } }
    return
  }
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  if (isChatPlaneRequest(ctx)) {
    params.delete('profile')
    params.delete('x-hermes-profile')
  }
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const requestMethod = method || ctx.req.method || ctx.method || 'GET'
  const headers = buildHeaders(profile, ctx)
  const body = ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD'
    ? JSON.stringify(normalizeChatPlaneJobBody(
      ctx,
      profile,
      upstreamPath,
      requestMethod,
      sanitizeChatPlaneBody(ctx, ctx.request.body || {}),
    ))
    : undefined

  let res: Response
  try {
    res = await fetch(url, {
      method: requestMethod,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e: any) {
    if (options.fallbackUnavailableJobList && isChatPlaneRequest(ctx)) {
      ctx.status = 200
      ctx.set('Content-Type', 'application/json')
      ctx.body = {
        jobs: [],
        gateway_unavailable: true,
        error: { message: `Proxy error: ${e.message}` },
      }
      return
    }
    ctx.status = 502
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: { message: `Proxy error: ${e.message}` } }
    return
  }

  if (!res.ok) {
    ctx.status = res.status
    ctx.set('Content-Type', 'application/json')
    ctx.body = await readUpstreamError(res)
    return
  }

  ctx.status = res.status
  ctx.set('Content-Type', res.headers.get('content-type') || 'application/json')
  ctx.body = await res.json()
}

export async function list(ctx: Context) {
  await proxyRequest(ctx, '/api/jobs', undefined, { fallbackUnavailableJobList: true })
}

export async function wake(ctx: Context) {
  const profile = resolveProfile(ctx)
  const mgr = getGatewayManagerInstance()
  if (!mgr?.detectStatus || !mgr?.startApiOnly) {
    ctx.status = 503
    ctx.body = {
      profile,
      running: false,
      status: 'unavailable',
      error: { message: 'API-only gateway wake is not available' },
    }
    return
  }

  try {
    const current = await mgr.detectStatus(profile)
    if (current?.running) {
      ctx.body = {
        profile,
        running: true,
        status: 'ready',
        url: current.url,
      }
      return
    }

    const status = await mgr.startApiOnly(profile)
    ctx.body = {
      profile,
      running: !!status?.running,
      status: status?.running ? 'ready' : 'starting',
      url: status?.url,
    }
  } catch (err: any) {
    ctx.status = 502
    ctx.body = {
      profile,
      running: false,
      status: 'failed',
      error: { message: err?.message || 'Failed to wake API-only gateway' },
    }
  }
}

export async function sleep(ctx: Context) {
  const profile = resolveProfile(ctx)
  const mgr = getGatewayManagerInstance()
  if (!mgr?.stopApiOnly) {
    ctx.status = 503
    ctx.body = {
      profile,
      running: true,
      status: 'unavailable',
      error: { message: 'API-only gateway sleep is not available' },
    }
    return
  }

  try {
    const status = await mgr.stopApiOnly(profile)
    ctx.body = {
      profile,
      running: !!status?.running,
      status: status?.status || (status?.running ? 'ready' : 'stopped'),
    }
    if (status?.url) (ctx.body as any).url = status.url
  } catch (err: any) {
    ctx.status = 502
    ctx.body = {
      profile,
      running: true,
      status: 'failed',
      error: { message: err?.message || 'Failed to sleep API-only gateway' },
    }
  }
}

export async function get(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function create(ctx: Context) {
  await proxyRequest(ctx, '/api/jobs')
}

export async function update(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function remove(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function pause(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/pause`)
}

export async function resume(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/resume`)
}

export async function run(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/run`)
}
