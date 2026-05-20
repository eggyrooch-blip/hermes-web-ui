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

function withProfile(path: string, profile?: string): string {
  const value = profile?.trim()
  return value ? `${path}?profile=${encodeURIComponent(value)}` : path
}

export async function fetchSkillCredentials(profile?: string): Promise<SkillCredentialsResponse> {
  return request(withProfile('/api/auth/skill-credentials', profile))
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
