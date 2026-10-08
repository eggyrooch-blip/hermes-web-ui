/**
 * Bot Screen (云电脑看屏) — shared rules for the REST passthrough and the RFB
 * WebSocket bridge to the MT run broker (`/api/run-broker/desktop/*`).
 *
 * The broker resolves the profile from `X-Hermes-Owner-Open-Id` (+ the
 * optional `X-Hermes-Agent-Id`); this layer only decides whether the verified
 * actor may name the profile/agent it asked for. A request for a profile or
 * agent the actor cannot use is refused here (403) rather than silently
 * re-targeted at the actor's own profile.
 */

import { createHash } from 'crypto'
import { config } from '../../config'
import type { WebUser } from '../request-context'
import { ownerOwnsProfile, resolveOwnedProfileAgentId } from './agent-ownership'
import { resolveAccessibleAgentProfile } from './handshake-identity'

export interface DesktopTarget {
  openid: string
  agentId?: string
}

export interface DesktopLease {
  holder?: string
  viewer_id?: string | null
  viewer_hash?: string | null
  [key: string]: unknown
}

/** Server-minted viewer ids are url-safe tokens; anything else never reaches the broker. */
const VIEWER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
/** `lease.public_view` names the holder by the first 12 hex of sha256(viewer_id). */
const VIEWER_HASH_HEX = 12

export async function authorizeDesktopTarget(
  user: Pick<WebUser, 'openid' | 'profile'> | null | undefined,
  requestedProfile: string,
  requestedAgentId: string,
): Promise<DesktopTarget | null> {
  const openid = user?.openid?.trim()
  if (!openid) return null
  const profile = requestedProfile.trim()
  const agentId = requestedAgentId.trim()

  if (agentId) {
    const agentProfile = await resolveAccessibleAgentProfile(openid, agentId, profile).catch(() => null)
    return agentProfile ? { openid, agentId } : null
  }
  if (!profile || profile === user?.profile) return { openid }
  if (!ownerOwnsProfile(openid, profile)) return null
  // An owned non-default profile is addressed through its agent id; without
  // one the broker would fall back to the owner's default profile.
  const ownedAgentId = resolveOwnedProfileAgentId(openid, profile)
  return ownedAgentId ? { openid, agentId: ownedAgentId } : null
}

export function buildDesktopBrokerHeaders(target: DesktopTarget): Record<string, string> {
  const headers: Record<string, string> = { 'X-Hermes-Owner-Open-Id': target.openid }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  if (target.agentId) headers['X-Hermes-Agent-Id'] = target.agentId
  return headers
}

export function normalizeViewerId(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return VIEWER_ID_PATTERN.test(text) ? text : null
}

export function viewerHash(viewerId: string): string {
  return createHash('sha256').update(viewerId).digest('hex').slice(0, VIEWER_HASH_HEX)
}

/** Does `viewerId` hold `lease`? The raw id is a capability, so the browser only ever learns this boolean. */
export function viewerHoldsLease(lease: DesktopLease | null | undefined, viewerId: string | null): boolean {
  if (!lease || !viewerId || lease.holder !== 'human') return false
  if (typeof lease.viewer_id === 'string' && lease.viewer_id) return lease.viewer_id === viewerId
  return typeof lease.viewer_hash === 'string' && lease.viewer_hash === viewerHash(viewerId)
}

export function brokerDesktopWsUrl(viewerId: string): string | null {
  if (!config.runBrokerUrl) return null
  const url = new URL(`${config.runBrokerUrl.replace(/\/+$/, '')}/api/run-broker/desktop/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('viewer_id', viewerId)
  return url.toString()
}
