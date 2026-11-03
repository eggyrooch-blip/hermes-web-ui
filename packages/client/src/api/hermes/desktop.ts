import { getActiveProfileName, getBaseUrlValue, request } from '../client'

const ACTIVE_AGENT_STORAGE_KEY = 'hermes_active_agent_id'

/** `lease.public_view` from the broker; the WebUI server also blanks the holder's raw viewer id. */
export interface DesktopLease {
  holder: 'agent' | 'human'
  viewer_hash?: string | null
  since?: number | null
  reason?: string | null
  epoch?: number
}

export interface DesktopObserveResult {
  enabled: boolean
  running: boolean
  lease: DesktopLease | null
  viewer_id: string | null
  /** Server-computed: this viewer id is the human lease holder. */
  you_hold: boolean
}

export interface DesktopLeaseResult {
  lease: DesktopLease | null
  you_hold: boolean
}

/** The bot the page is looking at: the active profile/agent, validated server-side. */
function targetQuery(): string {
  const params = new URLSearchParams()
  const profile = getActiveProfileName()
  const agentId = localStorage.getItem(ACTIVE_AGENT_STORAGE_KEY)
  if (profile) params.set('profile', profile)
  if (agentId) params.set('agent_id', agentId)
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * The screen entry probes observe on every chat page, and the screen page
 * handles lease 403s itself, so a desktop 403 never raises the global
 * access-denied toast.
 */
function post<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
  return request<T>(`/api/hermes/desktop/${operation}${targetQuery()}`, {
    method: 'POST',
    body: JSON.stringify(body),
    suppressForbiddenNotice: true,
  })
}

export function observeDesktop(): Promise<DesktopObserveResult> {
  return post<DesktopObserveResult>('observe')
}

/** Passing the page's viewer id keeps it when still valid; the broker mints a new one otherwise. */
export function ensureDesktop(viewerId?: string | null): Promise<DesktopObserveResult> {
  return post<DesktopObserveResult>('ensure', viewerId ? { viewer_id: viewerId } : {})
}

export function acquireDesktopLease(viewerId: string): Promise<DesktopLeaseResult> {
  return post<DesktopLeaseResult>('lease/acquire', { viewer_id: viewerId })
}

export function releaseDesktopLease(viewerId: string): Promise<DesktopLeaseResult> {
  return post<DesktopLeaseResult>('lease/release', { viewer_id: viewerId })
}

export function buildDesktopScreenWebSocketUrl(viewerId: string): string {
  const params = new URLSearchParams(targetQuery().slice(1))
  params.set('viewer_id', viewerId)
  const path = `/api/hermes/desktop/ws?${params.toString()}`
  const base = getBaseUrlValue()
  if (base) {
    const url = new URL(base)
    return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${path}`
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`
}
