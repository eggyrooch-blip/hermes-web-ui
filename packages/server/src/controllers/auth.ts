import type { Context } from 'koa'
import { checkPassword, recordPasswordFailure, recordPasswordSuccess, extractIp, getLockedIps, unlockIp, unlockAll } from '../services/login-limiter'
import {
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
  bootstrapDefaultSuperAdmin,
  countActiveSuperAdmins,
  countUsers,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  getUserAvatar,
  listUserProfiles,
  listUsers,
  setUserAvatar,
  updateUser,
  updateUsername,
  updateUserPassword,
  verifyPassword,
  type UserRole,
  type UserRecord,
  type UserStatus,
} from '../db/hermes/users-store'
import { issueUserJwt } from '../middleware/user-auth'
import { getProfileDir, listProfileNamesFromDisk } from '../services/hermes/hermes-profile'
import { startOutboundRelayClient } from '../services/global-agent/outbound-relay-client'
import { config } from '../config'
import { logger } from '../services/logger'
import type { WebUser } from '../services/request-context'
import { getRequestProfile } from '../services/request-context'
import {
  completeKepCliAuthCallback,
  completeKeepRecordAuth,
  getSkillCredentialStartAction,
  listSkillCredentialStatuses,
  startFeishuProjectAuth,
  startKepCliAuth,
  startKeepRecordAuth,
} from '../services/hermes/skill-credentials'

/**
 * GET /api/auth/status
 * Check if username/password login is configured (public).
 */
export async function authStatus(ctx: Context) {
  ctx.body = {
    hasPasswordLogin: true,
    hasUsers: countUsers() > 0,
  }
}

/**
 * GET /api/auth/me
 * Return the authenticated account.
 */
export async function currentUser(ctx: Context) {
  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }
  ctx.body = {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      avatar: user.avatar || '',
      requiresCredentialChange: process.env.HERMES_DESKTOP === 'true'
        ? false
        : user.username === DEFAULT_USERNAME && verifyPassword(DEFAULT_PASSWORD, user.password_hash),
    },
  }
}

const MAX_AVATAR_BYTES = 500 * 1024

function isValidAvatarPayload(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Invalid avatar payload' }
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type !== 'image' && type !== 'default') return { ok: false, error: 'Avatar type must be "image" or "default"' }
  if (type === 'image') {
    if (typeof obj.dataUrl !== 'string' || !obj.dataUrl.startsWith('data:image/')) {
      return { ok: false, error: 'Image avatar must include a dataUrl' }
    }
    if (obj.dataUrl.length > MAX_AVATAR_BYTES) {
      return { ok: false, error: `Avatar image is too large (max ${MAX_AVATAR_BYTES} bytes)` }
    }
  }
  if (obj.seed != null && typeof obj.seed !== 'string') {
    return { ok: false, error: 'Avatar seed must be a string' }
  }
  return { ok: true, json: JSON.stringify(value) }
}

/**
 * GET /api/auth/avatar
 * Return the authenticated user's avatar JSON string.
 */
export async function getMyAvatar(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  ctx.body = { avatar: getUserAvatar(userId) }
}

/**
 * PUT /api/auth/avatar
 * Update the authenticated user's avatar. Body: { avatar: <json string> } OR
 * body directly contains the avatar object { type, dataUrl?, seed? }.
 */
export async function updateMyAvatar(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  const body = ctx.request.body as { avatar?: unknown } & Record<string, unknown>
  // Accept both { avatar: "<json string>" } and a direct avatar object
  const candidate = body && Object.prototype.hasOwnProperty.call(body, 'avatar') ? body.avatar : body
  if (typeof candidate === 'string') {
    if (candidate.length > MAX_AVATAR_BYTES * 2) {
      ctx.status = 400
      ctx.body = { error: 'Avatar string is too large' }
      return
    }
    try {
      const parsed = JSON.parse(candidate)
      const validation = isValidAvatarPayload(parsed)
      if (!validation.ok) {
        ctx.status = 400
        ctx.body = { error: validation.error }
        return
      }
      const ok = setUserAvatar(userId, candidate)
      if (!ok) {
        ctx.status = 500
        ctx.body = { error: 'Failed to save avatar' }
        return
      }
      ctx.body = { success: true, avatar: candidate }
      return
    } catch {
      ctx.status = 400
      ctx.body = { error: 'Avatar string is not valid JSON' }
      return
    }
  }
  const validation = isValidAvatarPayload(candidate)
  if (!validation.ok) {
    ctx.status = 400
    ctx.body = { error: validation.error }
    return
  }
  const ok = setUserAvatar(userId, validation.json)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to save avatar' }
    return
  }
  ctx.body = { success: true, avatar: validation.json }
}

async function passwordLogin(
  ctx: Context,
  username: string,
  password: string,
): Promise<{ ok: true; token: string; user: UserRecord } | { ok: false }> {
  const ip = extractIp(ctx)
  const result = checkPassword(ip)
  if (!result.allowed) {
    ctx.status = result.status
    ctx.body = { error: 'Too many login attempts, please try again later' }
    return { ok: false }
  }

  const existingUserCount = countUsers()
  const user = existingUserCount === 0
    ? bootstrapDefaultSuperAdmin(username, password)
    : findUserByUsername(username)

  if (!user || user.status !== 'active' || (existingUserCount > 0 && !verifyPassword(password, user.password_hash))) {
    recordPasswordFailure(ip)
    ctx.status = 401
    ctx.body = { error: 'Invalid username or password' }
    return { ok: false }
  }

  try {
    const token = await issueUserJwt(user)
    recordPasswordSuccess(ip)
    return { ok: true, token, user }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to issue login token' }
    return { ok: false }
  }
}

function accessibleProfileNames(user: UserRecord): string[] {
  if (user.role === 'super_admin') return listProfileNamesFromDisk()
  return listUserProfiles(user.id).map(profile => profile.profile_name)
}

/**
 * POST /api/auth/login
 * Authenticate with username/password (public).
 * Returns a user-scoped JWT on success.
 */
export async function login(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }

  const result = await passwordLogin(ctx, username, password)
  if (!result.ok) return
  ctx.body = { token: result.token }
}

function normalizeRelayUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return null
  }
}

/**
 * POST /api/auth/mcu-login
 * Authenticate with the existing username/password login and connect this
 * Hermes Studio instance to the relay URL provided by an MCU/device client.
 * Body: { token, url, id, account, password }.
 */
export async function microcontrollerLogin(ctx: Context) {
  const {
    token: relayToken,
    url,
    id,
    account,
    password,
  } = ctx.request.body as {
    token?: string
    url?: string
    id?: string
    account?: string
    password?: string
  }

  if (!relayToken || !url || !id || !account || !password) {
    ctx.status = 400
    ctx.body = { error: 'token, url, id, account and password are required' }
    return
  }

  const relayUrl = normalizeRelayUrl(url)
  if (!relayUrl) {
    ctx.status = 400
    ctx.body = { error: 'url must be a valid http, https, ws, or wss URL' }
    return
  }

  const result = await passwordLogin(ctx, account, password)
  if (!result.ok) return

  const client = startOutboundRelayClient({
    connectionId: id.trim(),
    relayUrl,
    relayToken,
    instanceId: id.trim(),
  })
  if (!client) {
    ctx.status = 400
    ctx.body = { error: 'Failed to start relay client' }
    return
  }

  ctx.body = {
    token: result.token,
    profiles: accessibleProfileNames(result.user),
    relay: {
      connected: true,
      id: id.trim(),
      url: relayUrl,
    },
  }
}

/**
 * POST /api/auth/setup
 * Set up username/password (protected).
 */
export async function setupPassword(ctx: Context) {
  ctx.status = 400
  ctx.body = { error: 'Password login is managed by user accounts' }
}

/**
 * POST /api/auth/change-password
 * Change password (protected).
 */
export async function changePassword(ctx: Context) {
  const { currentPassword, newPassword } = ctx.request.body as { currentPassword?: string; newPassword?: string }
  if (!currentPassword || !newPassword) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new password are required' }
    return
  }
  if (newPassword.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'New password must be at least 6 characters' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  updateUserPassword(user.id, newPassword)
  ctx.body = { success: true }
}

/**
 * POST /api/auth/change-username
 * Change username (protected).
 */
export async function changeUsername(ctx: Context) {
  const { currentPassword, newUsername } = ctx.request.body as { currentPassword?: string; newUsername?: string }
  if (!currentPassword || !newUsername) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new username are required' }
    return
  }
  if (newUsername.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  const existing = findUserByUsername(newUsername)
  if (existing && existing.id !== user.id) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }

  updateUsername(user.id, newUsername)
  ctx.body = { success: true }
}

/**
 * DELETE /api/auth/password
 * Remove username/password login (protected).
 */
export async function removePassword(ctx: Context) {
  ctx.status = 400
  ctx.body = { error: 'Password login cannot be removed for user accounts' }
}

function normalizeRole(value: unknown): UserRole | null {
  return value === 'super_admin' || value === 'admin' ? value : null
}

function normalizeStatus(value: unknown): UserStatus | null {
  return value === 'active' || value === 'disabled' ? value : null
}

function normalizeProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
}

function validateProfiles(profiles: string[]): string | null {
  const available = new Set(listProfileNamesFromDisk())
  const missing = profiles.find(profile => !available.has(profile))
  return missing || null
}

/**
 * GET /api/auth/users
 * Super admin user management list.
 */
export async function listManagedUsers(ctx: Context) {
  ctx.body = {
    users: listUsers(),
    profiles: listProfileNamesFromDisk(),
  }
}

/**
 * POST /api/auth/users
 * Create a user account. Super admin only.
 */
export async function createManagedUser(ctx: Context) {
  const body = ctx.request.body as {
    username?: string
    password?: string
    role?: unknown
    status?: unknown
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const role = normalizeRole(body.role || 'admin')
  const status = normalizeStatus(body.status || 'active')
  const profiles = normalizeProfiles(body.profiles)

  if (username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (!role || !status) {
    ctx.status = 400
    ctx.body = { error: 'Invalid role or status' }
    return
  }
  if (findUserByUsername(username)) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }

  const missingProfile = validateProfiles(profiles)
  if (missingProfile) {
    ctx.status = 400
    ctx.body = { error: `Profile "${missingProfile}" does not exist` }
    return
  }

  const user = createUser({
    username,
    password,
    role,
    status,
    profiles: role === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.status = 201
  ctx.body = { user, users: listUsers() }
}

/**
 * PUT /api/auth/users/:id
 * Update user account metadata, password, and profile bindings.
 */
export async function updateManagedUser(ctx: Context) {
  const id = Number(ctx.params.id)
  const user = Number.isInteger(id) ? findUserById(id) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  const body = ctx.request.body as {
    username?: string
    password?: string
    role?: unknown
    status?: unknown
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = body.username == null ? undefined : String(body.username).trim()
  const password = body.password == null ? undefined : String(body.password)
  const role = body.role == null ? undefined : normalizeRole(body.role)
  const status = body.status == null ? undefined : normalizeStatus(body.status)
  const profiles = body.profiles == null ? undefined : normalizeProfiles(body.profiles)

  if (username !== undefined && username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password !== undefined && password.length > 0 && password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (body.role != null && !role || body.status != null && !status) {
    ctx.status = 400
    ctx.body = { error: 'Invalid role or status' }
    return
  }
  if (username && username !== user.username) {
    const existing = findUserByUsername(username)
    if (existing && existing.id !== user.id) {
      ctx.status = 409
      ctx.body = { error: 'Username already exists' }
      return
    }
  }

  const nextRole = role || user.role
  const nextStatus = status || user.status
  const currentUserId = ctx.state.user?.id
  if (user.id === currentUserId && nextStatus !== 'active') {
    ctx.status = 400
    ctx.body = { error: 'You cannot disable your own account' }
    return
  }
  if (user.role === 'super_admin' && user.status === 'active' && (nextRole !== 'super_admin' || nextStatus !== 'active') && countActiveSuperAdmins(user.id) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  if (profiles) {
    const missingProfile = validateProfiles(profiles)
    if (missingProfile) {
      ctx.status = 400
      ctx.body = { error: `Profile "${missingProfile}" does not exist` }
      return
    }
  }

  updateUser({
    userId: user.id,
    username,
    password: password || undefined,
    role: role || undefined,
    status: status || undefined,
    profiles: nextRole === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.body = { user: findUserById(user.id), users: listUsers() }
}

/**
 * DELETE /api/auth/users/:id
 * Delete a user account. Super admin only.
 */
export async function deleteManagedUser(ctx: Context) {
  const id = Number(ctx.params.id)
  const user = Number.isInteger(id) ? findUserById(id) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (ctx.state.user?.id === user.id) {
    ctx.status = 400
    ctx.body = { error: 'You cannot delete your own account' }
    return
  }
  if (user.role === 'super_admin' && user.status === 'active' && countActiveSuperAdmins(user.id) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  deleteUser(user.id)
  ctx.body = { success: true, users: listUsers() }
}

/**
 * GET /api/auth/locked-ips
 * List all currently locked IPs (protected).
 */
export async function listLockedIps(ctx: Context) {
  const locks = getLockedIps()
  ctx.body = { locks }
}

/**
 * DELETE /api/auth/locked-ips?ip=xxx
 * Unlock a specific IP. No ip param = unlock all.
 */
export async function unlockIpHandler(ctx: Context) {
  const ip = ctx.query.ip as string
  if (ip) {
    const found = unlockIp(ip)
    if (!found) {
      ctx.status = 404
      ctx.body = { error: 'IP not locked' }
      return
    }
    ctx.body = { success: true }
    return
  }
  // No IP specified — unlock all
  const count = unlockAll()
  ctx.body = { success: true, count }
}

// ---------------------------------------------------------------------------
// Skill credentials (CredentialsView) — HTTP controller layer connecting the
// surviving services/hermes/skill-credentials service to the client. Profile
// resolution and chat-plane / owner isolation are handled in getRequestProfile
// (services/request-context), which scopes the request to an owner-owned
// profile and is excluded from chat-plane forbidden paths.
// ---------------------------------------------------------------------------

function getHeader(ctx: Context, name: string): string {
  return typeof ctx.get === 'function' ? ctx.get(name) : ''
}

function firstForwardedHeader(value: string): string {
  return value.split(',')[0]?.trim() || ''
}

function externalRequestOrigin(ctx: Context): string {
  const forwardedProto = firstForwardedHeader(getHeader(ctx, 'x-forwarded-proto'))
  const forwardedHost = firstForwardedHeader(getHeader(ctx, 'x-forwarded-host'))
  if (forwardedProto && forwardedHost) {
    try {
      return new URL(`${forwardedProto}://${forwardedHost}`).origin
    } catch {
      // Fall through to Koa's origin below.
    }
  }
  return typeof ctx.origin === 'string' ? ctx.origin : ''
}

function getOptionalFeishuUser(ctx: Context): WebUser | undefined {
  const user = ctx.state?.user as WebUser | undefined
  return user?.profile && user?.openid ? user : undefined
}

function brokerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  return headers
}

function brokerUrl(path: string): string {
  if (!config.runBrokerUrl) {
    const err: any = new Error('HERMES_RUN_BROKER_URL is required for Feishu UAT auth')
    err.status = 503
    throw err
  }
  return `${config.runBrokerUrl}${path}`
}

async function pipeBrokerJson(ctx: Context, res: Response): Promise<void> {
  const body = await res.json().catch(async () => ({ error: await res.text().catch(() => 'Broker request failed') }))
  ctx.status = res.status
  ctx.body = body
}

function handleUatProxyError(ctx: Context, err: any): void {
  ctx.status = typeof err?.status === 'number' ? err.status : 500
  ctx.body = { error: err?.message || 'Feishu UAT auth failed' }
}

async function fetchFeishuUatStatusForUser(user: WebUser, requiredScopes = ''): Promise<Record<string, any>> {
  const params = new URLSearchParams()
  params.set('profile_name', user.profile)
  params.set('user_key', user.openid)
  if (requiredScopes) params.set('required_scopes', requiredScopes)
  const res = await fetch(brokerUrl(`/api/run-broker/credentials/feishu/uat/status?${params.toString()}`), {
    method: 'GET',
    headers: brokerHeaders(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err: any = new Error(body?.error || 'Feishu UAT status failed')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * GET /api/auth/skill-credentials
 * Summarize first-party skill credential status for the request profile.
 */
export async function skillCredentialsStatus(ctx: Context) {
  try {
    const user = getOptionalFeishuUser(ctx)
    const profileName = getRequestProfile(ctx)
    let larkStatus: Record<string, any> | null = null
    if (user) {
      try {
        larkStatus = await fetchFeishuUatStatusForUser(user)
      } catch (err) {
        logger.warn(err, 'Failed to load Lark-cli credential status for credentials page')
      }
    }
    ctx.status = 200
    ctx.body = await listSkillCredentialStatuses({
      profileName,
      profileDir: getProfileDir(profileName),
      user,
      larkStatus,
    })
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

/**
 * POST /api/auth/skill-credentials/:id/start
 * Start the authorization flow for a single skill credential.
 */
export async function skillCredentialStart(ctx: Context) {
  try {
    const user = getOptionalFeishuUser(ctx)
    const profileName = getRequestProfile(ctx)
    const id = String(ctx.params?.id || '').trim()
    if (!id) {
      ctx.status = 400
      ctx.body = { error: 'credential id is required' }
      return
    }
    const normalized = id.toLowerCase() === 'lark_cli' ? 'lark-cli' : id.toLowerCase()
    if (normalized === 'lark-cli') {
      if (!user) {
        ctx.status = 401
        ctx.body = { error: 'Feishu user session is required for Lark-cli authorization' }
        return
      }
      const body = (ctx.request.body || {}) as { scope?: unknown }
      const payload: Record<string, string> = {
        profile_name: user.profile,
        user_key: user.openid,
      }
      if (typeof body.scope === 'string' && body.scope.trim()) payload.scope = body.scope.trim()
      const res = await fetch(brokerUrl('/api/run-broker/feishu-auth/sessions'), {
        method: 'POST',
        headers: brokerHeaders(),
        body: JSON.stringify(payload),
      })
      await pipeBrokerJson(ctx, res)
      return
    }
    if (normalized === 'keep-record') {
      ctx.status = 200
      ctx.body = await startKeepRecordAuth({
        id,
        profileName,
        profileDir: getProfileDir(profileName),
      })
      return
    }
    if (normalized === 'kep-cli' || normalized === 'keep-cli') {
      ctx.status = 200
      ctx.body = await startKepCliAuth({
        id,
        profileName,
        profileDir: getProfileDir(profileName),
        publicOrigin: externalRequestOrigin(ctx),
      })
      return
    }
    if (normalized === 'feishu-project-mcp' || normalized === 'feishu_project_mcp' || normalized === 'feishu-project') {
      ctx.status = 200
      ctx.body = await startFeishuProjectAuth({
        id,
        profileName,
        profileDir: getProfileDir(profileName),
        publicOrigin: externalRequestOrigin(ctx),
      })
      return
    }
    ctx.status = 200
    ctx.body = await getSkillCredentialStartAction({
      id,
      profileName,
      profileDir: getProfileDir(profileName),
    })
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

export async function skillCredentialBindToken(ctx: Context) {
  try {
    const user = getOptionalFeishuUser(ctx)
    const profileName = getRequestProfile(ctx)
    const id = String(ctx.params?.id || '').trim().toLowerCase()
    const body = (ctx.request.body || {}) as { token?: unknown }
    const token = typeof body.token === 'string' ? body.token : ''
    if (!id) {
      ctx.status = 400
      ctx.body = { error: 'credential id is required' }
      return
    }
    if (!token.trim()) {
      ctx.status = 400
      ctx.body = { error: 'token is required' }
      return
    }
    // Self-bind: forward to multitenancy, which stores the token ONLY in this
    // profile's vault + token file. The webui never persists the token itself.
    const payload: Record<string, string> = { profile_name: profileName, provider: id, token }
    if (user?.openid) payload.user_key = user.openid
    const res = await fetch(brokerUrl('/api/run-broker/credentials/token/bind'), {
      method: 'POST',
      headers: brokerHeaders(),
      body: JSON.stringify(payload),
    })
    await pipeBrokerJson(ctx, res)
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

/**
 * GET /api/auth/kep-cli/callback/:sessionId
 * Public OAuth callback for the kep-cli browser authorization flow.
 */
export async function kepCliCallback(ctx: Context) {
  try {
    const sessionId = String(ctx.params?.sessionId || '').trim()
    const result = await completeKepCliAuthCallback({
      sessionId,
      query: ctx.querystring || '',
    })
    ctx.status = 200
    ctx.type = 'html'
    ctx.body = result.body || '<!doctype html><meta charset="utf-8"><title>kep-cli authenticated</title><p>kep-cli authentication completed. You can close this window.</p>'
  } catch (err: any) {
    ctx.status = typeof err?.status === 'number' ? err.status : 500
    ctx.body = { error: err?.message || 'kep-cli OAuth callback failed' }
  }
}

/**
 * POST /api/auth/skill-credentials/:id/complete
 * Complete a QR-based credential flow (Keep-record).
 */
export async function skillCredentialComplete(ctx: Context) {
  try {
    const profileName = getRequestProfile(ctx)
    const id = String(ctx.params?.id || '').trim()
    const normalized = id.toLowerCase() === 'lark_cli' ? 'lark-cli' : id.toLowerCase()
    if (normalized !== 'keep-record') {
      ctx.status = 400
      ctx.body = { error: 'credential completion is not supported for this skill' }
      return
    }
    const body = (ctx.request.body || {}) as { qrcode_id?: unknown }
    const qrcodeId = typeof body.qrcode_id === 'string' ? body.qrcode_id.trim() : ''
    if (!qrcodeId) {
      ctx.status = 400
      ctx.body = { error: 'qrcode_id is required' }
      return
    }
    ctx.status = 200
    ctx.body = await completeKeepRecordAuth({
      id,
      profileName,
      profileDir: getProfileDir(profileName),
      qrcodeId,
    })
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}
