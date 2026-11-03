import type { Context } from 'koa'
import { config } from '../../config'
import type { WebUser } from '../../services/request-context'
import {
  authorizeDesktopTarget,
  buildDesktopBrokerHeaders,
  normalizeViewerId,
  viewerHoldsLease,
  type DesktopLease,
} from '../../services/hermes/desktop-screen'

type DesktopOperation = 'observe' | 'ensure' | 'lease/acquire' | 'lease/release'

/** `ensure` may cold-start the bot's desktop container; the rest are lease/file reads. */
const BROKER_TIMEOUT_MS: Record<DesktopOperation, number> = {
  observe: 10_000,
  ensure: 120_000,
  'lease/acquire': 10_000,
  'lease/release': 10_000,
}

const DESKTOP_DISABLED = { enabled: false, running: false, lease: null, viewer_id: null, you_hold: false }

function firstString(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : ''
}

function requestedProfile(ctx: Context): string {
  return firstString(ctx.query?.profile) || ctx.get('x-hermes-profile') || ''
}

function requestedAgentId(ctx: Context): string {
  return firstString(ctx.query?.agent_id) || ctx.get('x-hermes-agent-id') || ''
}

/**
 * Only the fields the broker contract names cross this boundary; identity
 * comes from the verified session, never from the body.
 */
function brokerPayload(operation: DesktopOperation, body: Record<string, unknown>, viewerId: string | null): Record<string, unknown> {
  if (operation === 'lease/acquire') return { viewer_id: viewerId }
  if (operation === 'lease/release') return { viewer_id: viewerId, ...(body.force === true ? { force: true } : {}) }
  // ensure keeps a still-valid viewer id; observe always mints a new one.
  const keptViewerId = operation === 'ensure' ? normalizeViewerId(body.viewer_id) : null
  return keptViewerId ? { viewer_id: keptViewerId } : {}
}

async function proxyDesktopOperation(ctx: Context, operation: DesktopOperation): Promise<void> {
  const user = ctx.state?.user as WebUser | undefined
  const target = await authorizeDesktopTarget(user, requestedProfile(ctx), requestedAgentId(ctx))
  if (!target) {
    ctx.status = 403
    ctx.body = { error: 'desktop_forbidden' }
    return
  }

  const body = (ctx.request.body || {}) as Record<string, unknown>
  const leaseOperation = operation === 'lease/acquire' || operation === 'lease/release'
  const requestViewerId = leaseOperation ? normalizeViewerId(body.viewer_id) : null
  if (leaseOperation && !requestViewerId && !(operation === 'lease/release' && body.force === true)) {
    ctx.status = 400
    ctx.body = { error: 'viewer_id_required' }
    return
  }

  if (!config.runBrokerUrl) {
    if (leaseOperation) {
      ctx.status = 503
      ctx.body = { error: 'desktop_unavailable' }
    } else {
      ctx.body = DESKTOP_DISABLED
    }
    return
  }

  let res: Response
  try {
    res = await fetch(`${config.runBrokerUrl}/api/run-broker/desktop/${operation}`, {
      method: 'POST',
      headers: { ...buildDesktopBrokerHeaders(target), 'Content-Type': 'application/json' },
      body: JSON.stringify(brokerPayload(operation, body, requestViewerId)),
      signal: AbortSignal.timeout(BROKER_TIMEOUT_MS[operation]),
    })
  } catch {
    ctx.status = 502
    ctx.body = { error: 'desktop_broker_unreachable' }
    return
  }

  const text = await res.text().catch(() => '')
  let parsed: Record<string, unknown> | null = null
  try {
    const value = text ? JSON.parse(text) : null
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    parsed = null
  }

  // Identity is already verified here, so a broker 403 on observe/ensure
  // (desktop_disabled, or owner-only for a shared agent) and a broker that
  // predates the route (404) both mean "no screen for you here", not an auth
  // error the chat page should surface.
  if (!leaseOperation && (res.status === 404 || res.status === 403)) {
    ctx.status = 200
    ctx.body = DESKTOP_DISABLED
    return
  }
  if (!res.ok) {
    ctx.status = res.status
    ctx.body = parsed ?? { error: 'desktop_broker_error' }
    return
  }
  if (!parsed) {
    ctx.status = 502
    ctx.body = { error: 'desktop_broker_bad_response' }
    return
  }

  const lease = (parsed.lease && typeof parsed.lease === 'object' ? parsed.lease : null) as DesktopLease | null
  const viewerId = leaseOperation ? requestViewerId : normalizeViewerId(parsed.viewer_id)
  // The broker's public view already blanks the holder's viewer id; blank it
  // here too so it never reaches a browser even if that changes.
  ctx.body = {
    ...parsed,
    lease: lease ? { ...lease, viewer_id: null } : null,
    you_hold: viewerHoldsLease(lease, viewerId),
  }
}

export const observe = (ctx: Context) => proxyDesktopOperation(ctx, 'observe')
export const ensure = (ctx: Context) => proxyDesktopOperation(ctx, 'ensure')
export const acquireLease = (ctx: Context) => proxyDesktopOperation(ctx, 'lease/acquire')
export const releaseLease = (ctx: Context) => proxyDesktopOperation(ctx, 'lease/release')
