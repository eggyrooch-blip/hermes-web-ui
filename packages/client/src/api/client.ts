import router from '@/router'

const DEFAULT_BASE_URL = ''
const AUTH_MODE_STORAGE_KEY = 'hermes_auth_mode'
const PLANE_STORAGE_KEY = 'hermes_web_plane'
const CURRENT_USER_STORAGE_KEY = 'hermes_current_user'

function getBaseUrl(): string {
  return localStorage.getItem('hermes_server_url') || DEFAULT_BASE_URL
}

export function getApiKey(): string {
  return localStorage.getItem('hermes_api_key') || ''
}

export function getAuthMode(): string {
  return localStorage.getItem(AUTH_MODE_STORAGE_KEY) || 'token'
}

export function getWebPlane(): string {
  return localStorage.getItem(PLANE_STORAGE_KEY) || 'both'
}

export function isUserMode(): boolean {
  return getWebPlane() === 'chat' || !!localStorage.getItem(CURRENT_USER_STORAGE_KEY)
}

export function setRuntimeMode(authMode?: string, plane?: string) {
  if (authMode) localStorage.setItem(AUTH_MODE_STORAGE_KEY, authMode)
  if (plane) localStorage.setItem(PLANE_STORAGE_KEY, plane)
}

export function setServerUrl(url: string) {
  localStorage.setItem('hermes_server_url', url)
}

export function setApiKey(key: string) {
  localStorage.setItem('hermes_api_key', key)
}

export function clearApiKey() {
  localStorage.removeItem('hermes_api_key')
}

export function hasApiKey(): boolean {
  if (getAuthMode() === 'trusted-feishu') return true
  return !!getApiKey()
}

export function shouldSkipLoginPage(): boolean {
  return hasApiKey()
}

export function canAccessProtectedRoutes(): boolean {
  const authMode = getAuthMode()
  if (authMode === 'feishu-oauth-dev') return true
  return hasApiKey()
}

/**
 * Get current active profile name.
 * Reads from store first (authoritative source), falls back to localStorage.
 */
function getActiveProfileName(): string | null {
  try {
    // Dynamic import to avoid circular dependency
    const { useProfilesStore } = require('@/stores/hermes/profiles')
    const store = useProfilesStore()
    // Store is the source of truth - it's updated from /api/hermes/profiles
    return store.activeProfileName
  } catch {
    // Fallback to localStorage if store is not available (e.g., during initialization)
    return localStorage.getItem('hermes_active_profile_name')
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getBaseUrl()
  const url = `${base}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  }

  const apiKey = getApiKey()
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Inject active profile header for proxied gateway requests
  const profileName = getActiveProfileName()
  const authMode = getAuthMode()
  if (authMode !== 'trusted-feishu' && authMode !== 'feishu-oauth-dev' && getWebPlane() !== 'chat' && profileName && profileName !== 'default') {
    headers['X-Hermes-Profile'] = profileName
  }

  // Send the HermesSession HttpOnly cookie alongside the bearer header. The
  // server prefers the cookie when both are present (services/auth.ts), so
  // this is the migration foothold for the v0.7.0 retirement of the
  // localStorage Bearer token. Cookie path: same-origin only.
  const res = await fetch(url, { ...options, headers, credentials: 'same-origin' })

  // Global 401 handler — only redirect to login for local BFF endpoints
  // Proxied gateway requests should not trigger logout
  const isLocalBff = !path.startsWith('/api/hermes/v1/') &&
    !path.startsWith('/api/hermes/jobs') &&
    !path.startsWith('/api/hermes/skills')

  if (res.status === 401 && isLocalBff) {
    clearApiKey()
    if (router.currentRoute.value.name !== 'login') {
      router.replace({ name: 'login' })
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`)
  }

  return res.json()
}

export function getBaseUrlValue(): string {
  return getBaseUrl()
}
