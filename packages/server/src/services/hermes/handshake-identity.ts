/**
 * Identity for raw handshakes (Socket.IO /chat-run, plain WebSocket upgrades)
 * that never pass through the Koa auth chain. Feishu deployments only: the
 * cookie (feishu-oauth-dev) or the signed trusted headers (trusted-feishu) are
 * the sole source of the actor; nothing identity-shaped is read from the query.
 */

import { config } from '../../config'
import {
  extractFeishuSessionFromCookieHeader,
  getFeishuSessionSecret,
  parseFeishuSessionCookie,
} from '../feishu-oauth'
import {
  resolveProfileForOpenId,
  verifyTrustedFeishuSocketHeaders,
  type WebUser,
} from '../request-context'
import { ownerOwnsProfile, resolveOwnedProfileAgentId } from './agent-ownership'

export type HandshakeHeaders = Record<string, string | string[] | undefined>

const SHARED_AGENTS_TIMEOUT_MS = 10_000

/**
 * `undefined` = this deployment does not authenticate handshakes by Feishu
 * identity (token/JWT mode; callers apply their own scheme). `null` = Feishu
 * mode and the handshake carries no valid identity.
 */
export function resolveFeishuHandshakeUser(headers: HandshakeHeaders | undefined): WebUser | null | undefined {
  if (config.authMode === 'feishu-oauth-dev') {
    const sessionCookie = extractFeishuSessionFromCookieHeader(headers?.cookie)
    return parseFeishuSessionCookie(sessionCookie, { secret: getFeishuSessionSecret() })
  }
  if (config.authMode === 'trusted-feishu') {
    const verified = verifyTrustedFeishuSocketHeaders(headers || {})
    if (!verified.ok) return null
    const profile = resolveProfileForOpenId(verified.openid)
    if (!profile) return null
    return { ...verified, profile, role: 'user' }
  }
  return undefined
}

/**
 * The profile behind `agentId` when `openid` may use it: either the actor owns
 * `requestedProfile` and that profile's agent is `agentId`, or the broker lists
 * `agentId` among the agents shared with the actor. `null` = no access.
 */
export async function resolveAccessibleAgentProfile(openid: string, agentId: string, requestedProfile: string): Promise<string | null> {
  const actor = openid.trim()
  const requestedAgentId = agentId.trim()
  if (!actor || !requestedAgentId) return null

  if (requestedProfile && ownerOwnsProfile(actor, requestedProfile)) {
    const ownedAgentId = resolveOwnedProfileAgentId(actor, requestedProfile)
    if (ownedAgentId === requestedAgentId) return requestedProfile
  }

  if (!config.runBrokerUrl) return null
  const headers: Record<string, string> = {
    'X-Hermes-Owner-Open-Id': actor,
  }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  // Bounded: this sits on handshake paths that hold a raw socket open. An
  // unreachable or slow broker is "no access", never a thrown handshake.
  const res = await fetch(`${config.runBrokerUrl}/api/run-broker/agents/shared`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(SHARED_AGENTS_TIMEOUT_MS),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = await res.json().catch(() => null) as any
  const agents = Array.isArray(body?.agents) ? body.agents : []
  const shared = agents.find((agent: any) => String(agent?.agent_id || '').trim() === requestedAgentId)
  if (!shared) return null
  const profileName = String(shared.profile_name || '').trim()
  if (requestedProfile && profileName && requestedProfile !== profileName) return null
  return profileName || requestedProfile || null
}
