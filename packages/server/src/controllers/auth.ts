import type { Context } from 'koa'
import { checkPassword, recordPasswordFailure, recordPasswordSuccess, extractIp, getLockedIps, isLoopbackSocket, socketRemoteAddress, unlockIp, unlockAll } from '../services/login-limiter'
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
import { resolveConsoleRole } from '../services/console-rbac'
import { startOutboundRelayClient } from '../services/global-agent/outbound-relay-client'
import { config, parseBool } from '../config'
import { logger } from '../services/logger'
import {
  buildFeishuAuthorizeUrl,
  createBoundFeishuSession,
  createFeishuState,
  exchangeFeishuCode,
  verifyFeishuState,
  cookieSecure,
  setFeishuCookie,
  FEISHU_SESSION_COOKIE,
  FEISHU_STATE_COOKIE,
  FEISHU_SCOPE_DEGRADED_COOKIE,
} from '../services/feishu-oauth'
import { getGatewayManagerInstance } from '../services/gateway-bootstrap'
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
import type { SkillCredentialsResult } from '../services/hermes/skill-credentials'
import { connectorRequestHasOnly } from '../services/hermes/connector-request-shape'
import {
  connectCatalogConnector,
  completeCatalogOAuth,
  deleteCustomConnector,
  failSafeResult,
  fetchConnectorCatalog,
  fetchCatalogConnectorStatus,
  fetchConnectorIcon,
  fetchConnectorStatuses,
  importCustomConnectors,
  isKnownConnectorIconKey,
  listCustomConnectors,
  runShadowCompare,
  classifyOAuthIssuer,
} from '../services/hermes/connector-registry-client'

/**
 * GET /api/auth/status
 * Check if username/password login is configured (public).
 */
export async function authStatus(ctx: Context) {
  ctx.body = {
    hasPasswordLogin: true,
    hasUsers: countUsers() > 0,
    authMode: config.authMode,
    plane: config.webPlane,
    // 空字符串 = 未配置 → 前端不渲染「去 GitLab 建 token」链接。
    gitlabBaseUrl: config.gitlabBaseUrl,
  }
}

/**
 * GET /api/auth/me
 * Return the authenticated account.
 */
export async function currentUser(ctx: Context) {
  const userId = ctx.state.user?.id
  const stateUser = ctx.state.user as (Partial<WebUser> & { profiles?: string[] }) | undefined
  const user = userId ? findUserById(userId) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }
  const feishuIdentity: Record<string, unknown> = {}
  if (typeof stateUser?.openid === 'string' && stateUser.openid) {
    feishuIdentity.openid = stateUser.openid
  }
  if (typeof stateUser?.userId === 'string' && stateUser.userId) {
    feishuIdentity.userId = stateUser.userId
  }
  if (typeof stateUser?.unionId === 'string' && stateUser.unionId) {
    feishuIdentity.unionId = stateUser.unionId
  }
  if (typeof stateUser?.tenantKey === 'string' && stateUser.tenantKey) {
    feishuIdentity.tenantKey = stateUser.tenantKey
  }
  if (typeof stateUser?.appId === 'string' && stateUser.appId) {
    feishuIdentity.appId = stateUser.appId
  }
  if (typeof stateUser?.email === 'string' && stateUser.email) {
    feishuIdentity.email = stateUser.email
  }
  if (typeof stateUser?.profile === 'string' && stateUser.profile) {
    feishuIdentity.profile = stateUser.profile
  }
  if (typeof stateUser?.name === 'string' && stateUser.name) {
    feishuIdentity.name = stateUser.name
  }
  if (typeof stateUser?.avatarUrl === 'string' && stateUser.avatarUrl) {
    feishuIdentity.avatarUrl = stateUser.avatarUrl
  }
  if (Array.isArray(stateUser?.profiles)) {
    feishuIdentity.profiles = stateUser.profiles
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
      // Server-authoritative: true only while this account still uses the
      // built-in default credentials, regardless of desktop/server mode.
      requiresCredentialChange: user.username === DEFAULT_USERNAME && verifyPassword(DEFAULT_PASSWORD, user.password_hash),
      // Server-authoritative console role — drives the /console nav gating.
      // Client rendering is convenience only; the real gate is requireConsoleAdmin.
      consoleRole: resolveConsoleRole(ctx),
      ...feishuIdentity,
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

// Remote addresses already told why first-login bootstrap was refused. Capped so
// a scan from many addresses cannot grow it without bound.
const bootstrapRefusalLogged = new Set<string>()
const BOOTSTRAP_REFUSAL_LOG_MAX = 1000

function logBootstrapRefusedOnce(ctx: Context): void {
  const remoteAddress = socketRemoteAddress(ctx) || 'unknown'
  if (bootstrapRefusalLogged.has(remoteAddress)) return
  if (bootstrapRefusalLogged.size >= BOOTSTRAP_REFUSAL_LOG_MAX) bootstrapRefusalLogged.clear()
  bootstrapRefusalLogged.add(remoteAddress)
  logger.warn(
    { remoteAddress },
    'First-login bootstrap refused: the user store is empty and the request did not come from a loopback socket. '
      + 'For a container or remote first install, set HERMES_BOOTSTRAP_ALLOW_REMOTE=1, log in once, change the default password, then unset it.',
  )
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
  // First-login bootstrap creates a super_admin from the published default
  // credentials, so it is only offered to a loopback socket unless the
  // operator explicitly opts in for remote/container first installs.
  const bootstrapAllowed = isLoopbackSocket(ctx) || process.env.HERMES_BOOTSTRAP_ALLOW_REMOTE === '1'
  const user = existingUserCount === 0
    ? (bootstrapAllowed ? bootstrapDefaultSuperAdmin(username, password) : null)
    : findUserByUsername(username)
  if (existingUserCount === 0 && !bootstrapAllowed) logBootstrapRefusedOnce(ctx)

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

// cookieSecure / setFeishuCookie now live in services/feishu-oauth so the OAuth
// callback here and the middleware's sliding renewal write identical cookies.

function maybeCanonicalFeishuLoginRedirect(ctx: Context): string | null {
  const requestOrigin = externalRequestOrigin(ctx)
  if (!requestOrigin || !config.feishuRedirectUri) return null

  try {
    const configuredOrigin = new URL(config.feishuRedirectUri).origin
    if (configuredOrigin === requestOrigin) return null
    const canonical = new URL('/api/auth/feishu/login', configuredOrigin)
    canonical.search = ctx.search || ''
    return canonical.toString()
  } catch {
    return null
  }
}

function maskOpenId(openid: string): string {
  return openid.length <= 8 ? '***' : `***${openid.slice(-8)}`
}

function getAuthenticatedFeishuUser(ctx: Context): WebUser {
  const user = ctx.state?.user as WebUser | undefined
  if (!user?.profile || !user?.openid) {
    const err: any = new Error('Feishu user session is required')
    err.status = 401
    throw err
  }
  return user
}

function shouldSkipBoundProfileGatewayWake(): boolean {
  if (parseBool(process.env.HERMES_WEBUI_ALLOW_API_ONLY_GATEWAYS)) return false
  // In chat broker mode, user chat runs through Run Broker; API-only gateways
  // stay blocked by gateway-manager and should not be woken after OAuth login.
  return config.webPlane === 'chat' && (config.webuiRunBroker || config.webuiJobsBroker)
}

export async function wakeBoundProfileGateway(profile: string): Promise<void> {
  const mgr = getGatewayManagerInstance()
  if (!mgr || !profile) return
  if (shouldSkipBoundProfileGatewayWake()) {
    logger.debug(
      'Skipping bound profile gateway wake for profile "%s": chat broker mode is active',
      profile,
    )
    return
  }
  try {
    const current = typeof mgr.detectStatus === 'function'
      ? await mgr.detectStatus(profile)
      : null
    if (current?.running) return
    if (typeof mgr.startApiOnly === 'function') {
      await mgr.startApiOnly(profile)
      return
    }
    if (typeof mgr.start === 'function') {
      await mgr.start(profile)
    }
  } catch (err) {
    logger.warn(err, 'Failed to wake bound profile gateway after Feishu OAuth login')
  }
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

async function fetchFeishuLoginScope(): Promise<string> {
  const res = await fetch(brokerUrl('/api/run-broker/internal/feishu/oauth-scope'), {
    method: 'GET',
    headers: brokerHeaders(),
  })
  const body = await res.json().catch(() => ({}))
  const scope = typeof body?.scope === 'string' ? body.scope.trim() : ''
  if (!res.ok || !scope) {
    const err: any = new Error('Feishu OAuth scope is unavailable')
    err.status = res.status
    throw err
  }
  const scopes = new Set(scope.split(/\s+/).filter(Boolean))
  scopes.add('offline_access')
  return [...scopes].join(' ')
}

async function importFeishuLoginUat(
  user: WebUser,
  token: Awaited<ReturnType<typeof exchangeFeishuCode>>,
): Promise<void> {
  if (!token.refreshToken) throw new Error('Feishu OAuth refresh token is unavailable')
  const res = await fetch(brokerUrl('/api/run-broker/internal/feishu/uat/import'), {
    method: 'POST',
    headers: {
      ...brokerHeaders(),
      'X-Hermes-Owner-Open-Id': user.openid,
    },
    body: JSON.stringify({
      profile_name: user.profile,
      token: {
        app_id: config.feishuAppId,
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        expires_in: token.expiresIn,
        refresh_token_expires_in: token.refreshTokenExpiresIn,
        scope: token.scope,
      },
    }),
  })
  if (!res.ok) {
    const err: any = new Error('Feishu OAuth credential import failed')
    err.status = res.status
    throw err
  }
}

function feishuUatWarningRedirect(): string {
  try {
    const url = new URL(config.feishuCallbackRedirect)
    url.hash = '/hermes/connectors?lark_auth=required'
    return url.toString()
  } catch {
    return '/#/hermes/connectors?lark_auth=required'
  }
}

/**
 * GET /api/auth/feishu/login
 * Local-dev Feishu OAuth entrypoint. Production can replace this with a
 * reverse-proxy trusted-header layer while keeping the same request context.
 */
export async function feishuLogin(ctx: Context) {
  if (config.authMode !== 'feishu-oauth-dev') {
    ctx.status = 404
    ctx.body = { error: 'Feishu OAuth is not enabled' }
    return
  }
  if (!config.feishuAppId || !config.feishuRedirectUri) {
    ctx.status = 500
    ctx.body = { error: 'Feishu OAuth is not configured' }
    return
  }
  const canonicalLoginUrl = maybeCanonicalFeishuLoginRedirect(ctx)
  if (canonicalLoginUrl) {
    ctx.redirect(canonicalLoginUrl)
    return
  }

  // The broker supplies the full Lark-cli scope set, but it must NEVER gate login:
  // before this merge the login entrypoint did not touch the broker at all, and a
  // broker restart taking every employee's login down is a far worse failure than
  // one login that skips the credential import. Degrade instead: request the
  // minimal scope and mark the round trip so the callback skips the import.
  let scope = ''
  try {
    scope = await fetchFeishuLoginScope()
  } catch {
    logger.warn('Feishu OAuth scope lookup failed; degrading login and skipping UAT import')
  }
  const scopeDegraded = !scope
  const state = createFeishuState()
  setFeishuCookie(ctx, FEISHU_STATE_COOKIE, state, 10 * 60)
  setFeishuCookie(ctx, FEISHU_SCOPE_DEGRADED_COOKIE, scopeDegraded ? '1' : '', 10 * 60)
  ctx.redirect(buildFeishuAuthorizeUrl(state, scope || 'offline_access'))
}

/**
 * GET /api/auth/feishu/callback
 * Exchanges Feishu authorization code, maps open_id to Hermes profile, then
 * stores only a signed local session cookie in the browser.
 */
export async function feishuCallback(ctx: Context) {
  if (config.authMode !== 'feishu-oauth-dev') {
    ctx.status = 404
    ctx.body = { error: 'Feishu OAuth is not enabled' }
    return
  }

  const code = typeof ctx.query.code === 'string' ? ctx.query.code : ''
  const state = typeof ctx.query.state === 'string' ? ctx.query.state : ''
  const stateCookie = ctx.cookies.get(FEISHU_STATE_COOKIE)
  if (!code) {
    ctx.status = 400
    ctx.body = { error: 'Missing Feishu authorization code' }
    return
  }
  if (!verifyFeishuState(stateCookie, state)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Feishu OAuth state' }
    return
  }

  try {
    const token = await exchangeFeishuCode(code)
    const bound = createBoundFeishuSession(token.openid, {
      userId: token.userId,
      unionId: token.unionId,
      tenantKey: token.tenantKey,
      appId: token.appId,
      email: token.email,
      name: token.name,
      avatarUrl: token.avatarUrl,
    })
    if (!bound) {
      logger.warn({ openid: maskOpenId(token.openid) }, 'Feishu OAuth login rejected: no bound Hermes profile')
      ctx.status = 403
      ctx.body = { error: 'No Hermes profile is bound to this Feishu user' }
      return
    }

    // A degraded (minimal-scope) round trip must not import: the resulting token
    // would carry a narrower scope than the credential already on file and
    // overwrite a working Lark-cli authorization. Land on Connectors instead.
    let uatImportFailed = ctx.cookies.get(FEISHU_SCOPE_DEGRADED_COOKIE) === '1'
    if (uatImportFailed) {
      logger.warn('Feishu OAuth login used a degraded scope; skipping UAT import')
    } else {
      try {
        await importFeishuLoginUat(bound.user, token)
      } catch (err: any) {
        uatImportFailed = true
        logger.warn({ status: Number(err?.status) || 500 }, 'Feishu OAuth login succeeded but UAT import failed')
      }
    }

    logger.info({ openid: maskOpenId(token.openid), profile: bound.user.profile }, 'Feishu OAuth login bound to Hermes profile')
    await wakeBoundProfileGateway(bound.user.profile)
    setFeishuCookie(ctx, FEISHU_SESSION_COOKIE, bound.cookie, config.feishuSessionMaxAgeSeconds)
    for (const name of [FEISHU_STATE_COOKIE, FEISHU_SCOPE_DEGRADED_COOKIE]) {
      ctx.cookies.set(name, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure(ctx),
        maxAge: 0,
        overwrite: true,
      })
    }
    ctx.redirect(uatImportFailed ? feishuUatWarningRedirect() : config.feishuCallbackRedirect)
  } catch (err: any) {
    // The non-exposure guard covers logs as well as the browser, so NEITHER
    // surface gets the thrown message: an upstream that embeds token material in
    // Error.message would otherwise land it in the log sink. The error class is
    // enough to bucket a failure here; the specific cause is already logged at
    // the point it is known (import logs its broker status, exchange its own).
    logger.warn({ reason: 'callback_failed', errName: String(err?.name || 'Error') }, 'Feishu OAuth callback failed')
    ctx.status = 502
    ctx.body = { error: 'Feishu OAuth failed' }
  }
}

export async function feishuLogout(ctx: Context) {
  ctx.cookies.set(FEISHU_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(ctx),
    maxAge: 0,
    overwrite: true,
  })
  ctx.body = { success: true }
}

export async function feishuUatStatus(ctx: Context) {
  try {
    const user = getAuthenticatedFeishuUser(ctx)
    const requiredScopes = typeof ctx.query.required_scopes === 'string' ? ctx.query.required_scopes : ''
    ctx.status = 200
    ctx.body = await fetchFeishuUatStatusForUser(user, requiredScopes)
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

export async function feishuUatStart(ctx: Context) {
  try {
    const user = getAuthenticatedFeishuUser(ctx)
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
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

export async function feishuUatPoll(ctx: Context) {
  try {
    const user = getAuthenticatedFeishuUser(ctx)
    const sessionId = String(ctx.params?.sessionId || '').trim()
    if (!sessionId) {
      ctx.status = 400
      ctx.body = { error: 'sessionId is required' }
      return
    }
    const params = new URLSearchParams()
    params.set('profile_name', user.profile)
    params.set('user_key', user.openid)
    const res = await fetch(brokerUrl(`/api/run-broker/feishu-auth/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`), {
      method: 'GET',
      headers: brokerHeaders(),
    })
    await pipeBrokerJson(ctx, res)
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

export async function feishuUatCancel(ctx: Context) {
  try {
    const user = getAuthenticatedFeishuUser(ctx)
    const sessionId = String(ctx.params?.sessionId || '').trim()
    if (!sessionId) {
      ctx.status = 400
      ctx.body = { error: 'sessionId is required' }
      return
    }
    const params = new URLSearchParams()
    params.set('profile_name', user.profile)
    params.set('user_key', user.openid)
    const res = await fetch(brokerUrl(`/api/run-broker/feishu-auth/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`), {
      method: 'DELETE',
      headers: brokerHeaders(),
    })
    await pipeBrokerJson(ctx, res)
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

/**
 * GET /api/auth/skill-credentials
 * Summarize first-party skill credential status for the request profile.
 */
export async function skillCredentialsStatus(ctx: Context) {
  try {
    const user = getOptionalFeishuUser(ctx)
    const profileName = getRequestProfile(ctx)
    // `?fresh=1` (post-auth poll + manual refresh) forces the broker to bypass its
    // short-TTL connector cache so a just-completed login is reflected immediately.
    const fresh = ['1', 'true', 'yes', 'on'].includes(String(ctx.query?.fresh ?? '').trim().toLowerCase())

    // Local source: the WebUI's own 1192-line implementation (unchanged).
    const localFetch = async (): Promise<SkillCredentialsResult> => {
      let larkStatus: Record<string, any> | null = null
      if (user) {
        try {
          larkStatus = await fetchFeishuUatStatusForUser(user)
        } catch (err) {
          logger.warn(err, 'Failed to load Lark-cli credential status for credentials page')
        }
      }
      return listSkillCredentialStatuses({
        profileName,
        profileDir: getProfileDir(profileName),
        user,
        larkStatus,
      })
    }
    // Broker source: the Run Broker connector registry (Phase 2 control plane).
    const brokerFetch = (): Promise<SkillCredentialsResult> =>
      fetchConnectorStatuses({ profileName, userKey: user?.openid, fresh })

    let served: SkillCredentialsResult
    let servedSource: 'local' | 'broker'
    let brokerOk = false

    if (config.connectorsUseBroker) {
      servedSource = 'broker'
      try {
        served = await brokerFetch()
        brokerOk = true
      } catch (err: any) {
        // FAIL-SAFE (plan red line): the broker is the source of truth, so if it
        // is unavailable we surface error states — we do NOT fall back to the
        // local result, which could report a stale `authenticated`.
        logger.warn(err, 'Connector broker unavailable; serving fail-safe error states')
        served = failSafeResult(profileName)
      }
    } else {
      servedSource = 'local'
      served = await localFetch()
    }

    // Phase 1.5 shadow compare: fetch the OTHER source in the background and log
    // a redacted diff. Never blocks, never changes the served result. Skipped
    // when the broker just failed (comparing the fail-safe to local is noise).
    if (config.connectorShadowCompare && (servedSource === 'local' || brokerOk)) {
      void runShadowCompare({
        profileName,
        userKey: user?.openid,
        servedSource,
        servedResult: served,
        fetchOther: servedSource === 'local' ? brokerFetch : localFetch,
      })
    }

    ctx.status = 200
    ctx.body = served
  } catch (err: any) {
    handleUatProxyError(ctx, err)
  }
}

function connectorOwner(ctx: Context): { profileName: string; ownerOpenId: string } | null {
  const body = ctx.request.body as Record<string, unknown> | undefined
  const identityKeys = ['profile', 'profile_name', 'owner_open_id', 'subject_id']
  if (identityKeys.some(key => ctx.query?.[key] != null) || (body && identityKeys.some(key => key in body))) {
    ctx.status = 400
    ctx.body = { error: '连接器身份只能来自当前登录会话' }
    return null
  }
  const user = getOptionalFeishuUser(ctx)
  if (!user) {
    ctx.status = 403
    ctx.body = { error: '无法确认你的连接器身份，请重新登录后再试' }
    return null
  }
  return { profileName: getRequestProfile(ctx), ownerOpenId: user.openid }
}

function handleConnectorCatalogError(ctx: Context, err: any): void {
  ctx.status = typeof err?.status === 'number' ? err.status : 502
  ctx.body = { error: err?.message || '连接器目录暂时不可用' }
}

function requireConnectorRequestShape(ctx: Context, query: readonly string[], body: readonly string[]): boolean {
  if (connectorRequestHasOnly(ctx.query, ctx.request.body, query, body)) return true
  ctx.status = 400
  ctx.body = { error: '连接器请求包含未允许的字段' }
  return false
}

export async function connectorCatalog(ctx: Context) {
  if (!requireConnectorRequestShape(ctx, ['view'], [])) return
  const owner = connectorOwner(ctx)
  if (!owner) return
  const rawView = String(ctx.query?.view || 'source')
  if (rawView !== 'source' && rawView !== 'canonical') {
    ctx.status = 400
    ctx.body = { error: 'invalid connector catalog view' }
    return
  }
  const view = rawView
  try {
    ctx.body = await fetchConnectorCatalog({ ...owner, view })
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function connectorCatalogConnect(ctx: Context) {
  if (!requireConnectorRequestShape(ctx, [], ['row_key', 'fields'])) return
  const owner = connectorOwner(ctx)
  if (!owner) return
  const requestBody = ctx.request.body as { row_key?: string; fields?: unknown } | undefined
  const rowKey = requestBody?.row_key
  if (typeof rowKey !== 'string' || !rowKey || rowKey.length > 256) {
    ctx.status = 400
    ctx.body = { error: 'invalid connector catalog row key' }
    return
  }
  const fields = requestBody?.fields
  if (fields !== undefined && (!fields || typeof fields !== 'object' || Array.isArray(fields))) {
    ctx.status = 400
    ctx.body = { error: 'invalid connector credential fields' }
    return
  }
  try {
    const body = await connectCatalogConnector({
      ...owner,
      rowKey,
      ...(fields ? { fields: fields as Record<string, string> } : {}),
    })
    ctx.status = 201
    ctx.body = body
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function connectorCatalogStatus(ctx: Context) {
  if (!requireConnectorRequestShape(ctx, [], ['row_key'])) return
  const owner = connectorOwner(ctx)
  if (!owner) return
  const rowKey = (ctx.request.body as { row_key?: unknown } | undefined)?.row_key
  if (typeof rowKey !== 'string' || !rowKey || rowKey.length > 256) {
    ctx.status = 400
    ctx.body = { error: 'invalid connector catalog row key' }
    return
  }
  try {
    ctx.body = await fetchCatalogConnectorStatus({ ...owner, rowKey })
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function connectorCatalogOAuthCallback(ctx: Context) {
  // `iss` 必须在允许列表里：Figma 的真实重定向带它（`?code=…&iss=https%3A%2F%2Fapi.figma.com&state=…`），
  // 而这道闸是"只许出现列出的 query 键"，漏掉一个就整条回调 400，员工点完 Allow 回来
  // 看到的是一页报错。列进来不等于信它 —— 下面 classifyOAuthIssuer 决定转发还是 400。
  if (!requireConnectorRequestShape(ctx, ['state', 'code', 'iss'], [])) return
  const state = String(ctx.query?.state || '')
  const code = String(ctx.query?.code || '')
  if (!state || state.length > 512 || !code || code.length > 8192) {
    ctx.status = 400
    ctx.body = { error: 'invalid catalog OAuth callback' }
    return
  }
  // 三态：没带就保持旧契约的精确 {state, code}；带了合法的就原样转给 MT 去比对；
  // 带了但不合法（空、重复、格式错、非 https、超长）直接 400，不调 broker ——
  // 静默丢掉会让 broker 把"错的 issuer"当成"没有 issuer"放行。
  const issuer = classifyOAuthIssuer(ctx.query?.iss)
  if (issuer.kind === 'invalid') {
    ctx.status = 400
    ctx.body = { error: 'invalid catalog OAuth issuer' }
    return
  }
  try {
    await completeCatalogOAuth({ state, code, ...(issuer.kind === 'valid' ? { iss: issuer.value } : {}) })
    ctx.redirect('/hermes/connectors?catalog_oauth=success')
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function connectorCatalogIcon(ctx: Context) {
  const rowKey = String(ctx.query?.row_key || '').trim()
  // This public image route never forwards an arbitrary key with broker credentials:
  // fetchConnectorCatalog first registers only rows from a valid 642/330 catalog.
  const exactCatalogMatch = isKnownConnectorIconKey(rowKey)
  if (!rowKey || rowKey.length > 256 || /[\u0000-\u001f\u007f]/.test(rowKey) || !exactCatalogMatch) {
    ctx.status = 404
    ctx.body = { error: 'connector icon unavailable' }
    return
  }
  try {
    const response = await fetchConnectorIcon(rowKey)
    if (!response.ok) {
      ctx.status = response.status === 404 ? 404 : 502
      ctx.body = { error: 'connector icon unavailable' }
      return
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0]
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(contentType)) {
      ctx.status = 502
      ctx.body = { error: 'connector icon type is invalid' }
      return
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > 2 * 1024 * 1024) {
      ctx.status = 502
      ctx.body = { error: 'connector icon is too large' }
      return
    }
    ctx.set('Cache-Control', 'public, max-age=86400, immutable')
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    ctx.type = contentType
    ctx.body = Buffer.from(bytes)
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function customConnectors(ctx: Context) {
  if (!requireConnectorRequestShape(ctx, [], [])) return
  const owner = connectorOwner(ctx)
  if (!owner) return
  try {
    ctx.body = await listCustomConnectors(owner)
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function customConnectorImport(ctx: Context) {
  if (!requireConnectorRequestShape(ctx, [], ['config'])) return
  const owner = connectorOwner(ctx)
  if (!owner) return
  const { config: configValue } = (ctx.request.body || {}) as { config: string }
  if (typeof configValue !== 'string' || !configValue || Buffer.byteLength(configValue) > 64 * 1024) {
    ctx.status = 400
    ctx.body = { error: '连接器配置为空或过大' }
    return
  }
  try {
    ctx.status = 201
    ctx.body = await importCustomConnectors({ ...owner, config: configValue })
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
  }
}

export async function customConnectorDelete(ctx: Context) {
  if (!requireConnectorRequestShape(ctx, [], [])) return
  const owner = connectorOwner(ctx)
  if (!owner) return
  const connectorId = String(ctx.params?.connectorId || '')
  if (!/^custom-[a-f0-9]{24}$/.test(connectorId)) {
    ctx.status = 400
    ctx.body = { error: 'invalid connector id' }
    return
  }
  try {
    ctx.body = await deleteCustomConnector({ ...owner, connectorId })
  } catch (err) {
    handleConnectorCatalogError(ctx, err)
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
    const rawNormalized = id.toLowerCase()
    const normalized = rawNormalized === 'lark_cli'
      ? 'lark-cli'
      : rawNormalized === 'kep_cli_online'
        ? 'kep-cli-online'
        : rawNormalized === 'kep_cli_pre'
          ? 'kep-cli-pre'
          : rawNormalized
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
    if (normalized === 'kep-cli' || normalized === 'keep-cli' || normalized === 'kep-cli-online' || normalized === 'kep-cli-pre') {
      const body = (ctx.request.body || {}) as { env?: unknown }
      const bodyEnv = typeof body.env === 'string' ? body.env.trim() : ''
      const env = bodyEnv || (normalized === 'kep-cli-pre' ? 'pre' : normalized === 'kep-cli-online' ? 'online' : '')
      ctx.status = 200
      ctx.body = await startKepCliAuth({
        id,
        profileName,
        profileDir: getProfileDir(profileName),
        publicOrigin: externalRequestOrigin(ctx),
        ...(env ? { env } : {}),
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
      publicOrigin: externalRequestOrigin(ctx),
      // 身份只从已验证的会话来（figma 的 broker 代理用它当 owner 断言）。
      // 请求体里的任何 open_id/profile 字段到这里已经被丢掉了。
      ...(user?.openid ? { ownerOpenId: user.openid } : {}),
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
    // Phase 2: thin-forward to the Run Broker public callback (which owns the
    // kep-auth session + localhost forward). The route id is unchanged so
    // already-open OAuth browser tabs keep working. OFF (default) → local
    // complete, the rollback path.
    if (config.connectorKepCallbackForward) {
      const qs = ctx.querystring ? `?${ctx.querystring}` : ''
      const res = await fetch(
        brokerUrl(`/api/run-broker/credentials/kep-cli/callback/${encodeURIComponent(sessionId)}${qs}`),
        { method: 'GET' },
      )
      ctx.status = res.status
      ctx.type = 'html'
      ctx.body = await res.text().catch(() => '认证处理完成，可关闭本页面。')
      return
    }
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
