import { request } from './client'

export type SkillCredentialStatus = 'authenticated' | 'configured' | 'missing' | 'needs_auth' | 'unknown' | 'error'
export type SkillCredentialActionKind = 'feishu_device_flow' | 'skill_flow' | 'qr_flow' | 'oauth_url' | 'manual'

export interface SkillCredentialAction {
  kind: SkillCredentialActionKind
  label: string
  command?: string
  description?: string
}

export interface SkillCredentialEntry {
  id: string
  title: string
  provider: string
  installed: boolean
  status: SkillCredentialStatus
  account_hint?: string
  default_identity?: string
  detail?: string
  required_by?: string[]
  action: SkillCredentialAction
}

export interface SkillCredentialsResponse {
  profile_name: string
  credentials: SkillCredentialEntry[]
}

export interface SkillCredentialStartResponse {
  id?: string
  action?: SkillCredentialAction
  status?: string
  session_id?: string
  verification_uri?: string
  user_code?: string
  qrcode_id?: string
  qrcode_url?: string
  redirect_url?: string
  interval?: number
  error?: string
}

export interface SkillCredentialCompleteResponse {
  id: string
  status: string
  account_hint?: string
}

function withProfile(path: string, profile?: string, extra?: Record<string, string>): string {
  const search = new URLSearchParams()
  const value = profile?.trim()
  if (value) search.set('profile', value)
  for (const [k, v] of Object.entries(extra || {})) search.set(k, v)
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

// `fresh` forces the broker to bypass its short-TTL connector cache — used by the
// post-auth poll and the manual refresh so a just-completed login shows immediately.
export async function fetchSkillCredentials(profile?: string, opts?: { fresh?: boolean }): Promise<SkillCredentialsResponse> {
  return request(withProfile('/api/auth/skill-credentials', profile, opts?.fresh ? { fresh: '1' } : undefined))
}

export async function startSkillCredentialAuth(id: string, profile?: string): Promise<SkillCredentialStartResponse> {
  return request(withProfile(`/api/auth/skill-credentials/${encodeURIComponent(id)}/start`, profile), {
    method: 'POST',
    body: JSON.stringify({}),
    skipAuthRedirect: true,
  })
}

export async function completeSkillCredentialAuth(id: string, qrcodeId: string, profile?: string): Promise<SkillCredentialCompleteResponse> {
  return request(withProfile(`/api/auth/skill-credentials/${encodeURIComponent(id)}/complete`, profile), {
    method: 'POST',
    body: JSON.stringify({ qrcode_id: qrcodeId }),
  })
}
