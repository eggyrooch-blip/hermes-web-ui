import type { Context } from 'koa'
import { getCredentials, setCredentials, verifyCredentials, deleteCredentials } from '../services/credentials'
import { getToken, HERMES_SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SECONDS } from '../services/auth'
import { checkPassword, recordPasswordFailure, recordPasswordSuccess, extractIp, getLockedIps, unlockIp, unlockAll } from '../services/login-limiter'
import { config } from '../config'
import {
  buildFeishuAuthorizeUrl,
  createBoundFeishuSession,
  createFeishuState,
  exchangeFeishuCode,
  FEISHU_SESSION_COOKIE,
  FEISHU_STATE_COOKIE,
  verifyFeishuState,
} from '../services/feishu-oauth'
import { logger } from '../services/logger'
import type { WebUser } from '../services/request-context'

function cookieSecure(ctx: Context): boolean {
  return ctx.protocol === 'https' || ctx.secure
}

function setFeishuCookie(ctx: Context, name: string, value: string, maxAgeSeconds: number) {
  ctx.cookies.set(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(ctx),
    maxAge: maxAgeSeconds * 1000,
    overwrite: true,
  })
}

function maskOpenId(openid: string): string {
  return openid.length <= 8 ? '***' : `***${openid.slice(-8)}`
}

/**
 * GET /api/auth/status
 * Check if username/password login is configured (public).
 */
export async function authStatus(ctx: Context) {
  const cred = await getCredentials()
  ctx.body = {
    hasPasswordLogin: !!cred,
    username: cred?.username || null,
    authMode: config.authMode,
    plane: config.webPlane,
  }
}

/**
 * POST /api/auth/login
 * Authenticate with username/password (public).
 * Returns the static token on success.
 */
export async function login(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }

  const ip = extractIp(ctx)
  const result = checkPassword(ip)
  if (!result.allowed) {
    ctx.status = result.status
    ctx.body = { error: 'Too many login attempts, please try again later' }
    return
  }

  const valid = await verifyCredentials(username, password)
  if (!valid) {
    recordPasswordFailure(ip)
    ctx.status = 401
    ctx.body = { error: 'Invalid username or password' }
    return
  }

  const token = await getToken()
  if (!token) {
    ctx.status = 500
    ctx.body = { error: 'Auth is disabled on this server' }
    return
  }

  // SECURITY: also set an HttpOnly session cookie. Browsers that support it
  // can use cookie auth (immune to XSS exfiltration of localStorage). The
  // bearer token is still returned in the body for v0.5.x clients and
  // non-browser callers; v0.7.0 will drop the body field. See
  // Plans/token-cookie-migration.md.
  ctx.cookies.set(HERMES_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(ctx),
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
    overwrite: true,
  })

  recordPasswordSuccess(ip)
  ctx.body = { token }
}

/**
 * POST /api/auth/logout
 * Clears the HermesSession cookie. The bearer token in localStorage is the
 * client's responsibility; the server cannot revoke it without state.
 */
export async function logout(ctx: Context) {
  ctx.cookies.set(HERMES_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(ctx),
    maxAge: 0,
    overwrite: true,
  })
  ctx.body = { success: true }
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

  const state = createFeishuState()
  setFeishuCookie(ctx, FEISHU_STATE_COOKIE, state, 10 * 60)
  ctx.redirect(buildFeishuAuthorizeUrl(state))
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
      name: token.name,
      avatarUrl: token.avatarUrl,
    })
    if (!bound) {
      logger.warn({ openid: maskOpenId(token.openid) }, 'Feishu OAuth login rejected: no bound Hermes profile')
      ctx.status = 403
      ctx.body = { error: 'No Hermes profile is bound to this Feishu user' }
      return
    }

    logger.info({ openid: maskOpenId(token.openid), profile: bound.user.profile }, 'Feishu OAuth login bound to Hermes profile')
    setFeishuCookie(ctx, FEISHU_SESSION_COOKIE, bound.cookie, config.feishuSessionMaxAgeSeconds)
    ctx.cookies.set(FEISHU_STATE_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(ctx),
      maxAge: 0,
      overwrite: true,
    })
    ctx.redirect(config.feishuCallbackRedirect)
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Feishu OAuth failed' }
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

export async function currentUser(ctx: Context) {
  const user = ctx.state.user as WebUser | undefined
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  ctx.body = {
    openid: user.openid,
    profile: user.profile,
    role: user.role,
    name: user.name,
    avatarUrl: user.avatarUrl,
  }
}

/**
 * POST /api/auth/setup
 * Set up username/password (protected).
 */
export async function setupPassword(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }
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

  await setCredentials(username, password)
  ctx.body = { success: true }
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

  const cred = await getCredentials()
  if (!cred) {
    ctx.status = 400
    ctx.body = { error: 'Password login not configured' }
    return
  }

  // Verify current password — use the username from stored credentials
  const valid = await verifyCredentials(cred.username, currentPassword)
  if (!valid) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  await setCredentials(cred.username, newPassword)
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

  const cred = await getCredentials()
  if (!cred) {
    ctx.status = 400
    ctx.body = { error: 'Password login not configured' }
    return
  }

  const valid = await verifyCredentials(cred.username, currentPassword)
  if (!valid) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  // Update username, keep the same password
  await setCredentials(newUsername, currentPassword)
  ctx.body = { success: true }
}

/**
 * DELETE /api/auth/password
 * Remove username/password login (protected).
 */
export async function removePassword(ctx: Context) {
  await deleteCredentials()
  ctx.body = { success: true }
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
