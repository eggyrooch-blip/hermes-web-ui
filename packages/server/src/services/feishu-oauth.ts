import type { Context, Next } from 'koa'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { config } from '../config'
import { logger } from './logger'
import { resolveProfileForOpenId, type WebUser } from './request-context'
import { ensureWebUserForFeishu } from './compat-user'

export const FEISHU_SESSION_COOKIE = 'hermes_feishu_session'
export const FEISHU_STATE_COOKIE = 'hermes_feishu_state'
// Set only when the broker scope lookup failed and login degraded to a minimal
// scope. The callback reads it to SKIP the UAT import entirely: a narrow-scope
// token must never overwrite a good routed Lark-cli credential.
export const FEISHU_SCOPE_DEGRADED_COOKIE = 'hermes_feishu_scope_degraded'

/**
 * Pull the FEISHU_SESSION_COOKIE value out of a raw `Cookie` header.
 * Socket.IO handlers cannot rely on Koa's cookie parser, so they share this
 * helper instead of each duplicating a tiny cookie splitter.
 */
export function extractFeishuSessionFromCookieHeader(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(';') : header
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === FEISHU_SESSION_COOKIE) {
      return part.slice(eq + 1).trim()
    }
  }
  return undefined
}

type SignedPayload = Record<string, unknown>

interface CookieOptions {
  openid: string
  profile: string
  userId?: string
  unionId?: string
  tenantKey?: string
  appId?: string
  email?: string
  name?: string
  avatarUrl?: string
  secret: string
  now?: number
  maxAgeSeconds?: number
}

interface ParseOptions {
  secret: string
  now?: number
}

interface FeishuTokenResponse {
  code?: number
  msg?: string
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
}

interface FeishuUserInfoResponse {
  code?: number
  msg?: string
  data?: {
    open_id?: string
    user_id?: string
    union_id?: string
    tenant_key?: string
    email?: string
    enterprise_email?: string
    name?: string
    en_name?: string
    avatar_url?: string
    avatar_thumb?: string
    avatar_middle?: string
    avatar_big?: string
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function hmac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left)
  const rightBuf = Buffer.from(right)
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf)
}

function signPayload(payload: SignedPayload, secret: string): string {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${hmac(body, secret)}`
}

function parseSignedPayload<T extends SignedPayload>(cookie: string | undefined, secret: string): T | null {
  if (!cookie || !secret) return null
  // Exactly body.signature — trailing extra segments would otherwise ride along
  // unverified (review FSHP-001: "valid-cookie.junk" must be rejected).
  const segments = cookie.split('.')
  if (segments.length !== 2) return null
  const [body, signature] = segments
  if (!body || !signature) return null
  if (!safeEqual(signature, hmac(body, secret))) return null
  try {
    return JSON.parse(base64UrlDecode(body)) as T
  } catch {
    return null
  }
}

export function getFeishuSessionSecret(): string {
  return config.feishuSessionSecret || config.trustedHeaderSecret || config.feishuAppSecret
}

export function createFeishuSessionCookie(options: CookieOptions): string {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const maxAgeSeconds = options.maxAgeSeconds ?? config.feishuSessionMaxAgeSeconds
  return signPayload({
    openid: options.openid,
    profile: options.profile,
    role: 'user',
    userId: options.userId,
    unionId: options.unionId,
    tenantKey: options.tenantKey,
    appId: options.appId,
    email: options.email,
    name: options.name,
    avatarUrl: options.avatarUrl,
    iat: now,
    exp: now + maxAgeSeconds,
  }, options.secret)
}

/**
 * Why a session cookie was rejected. Logged on 401 so a lost login can be
 * traced to the actual failing link (browser dropped the cookie / TTL ran out /
 * signing secret changed) instead of being guessed at.
 */
export type FeishuSessionRejectReason = 'no-cookie' | 'bad-signature' | 'expired' | 'malformed-payload'

export interface FeishuSessionParseResult {
  user: WebUser | null
  /** Cookie `exp` (unix seconds) — present only when the cookie parsed cleanly. */
  exp?: number
  reason?: FeishuSessionRejectReason
}

export function parseFeishuSession(cookie: string | undefined, options: ParseOptions): FeishuSessionParseResult {
  if (!cookie) return { user: null, reason: 'no-cookie' }
  const payload = parseSignedPayload<{
    openid?: unknown
    profile?: unknown
    role?: unknown
    userId?: unknown
    unionId?: unknown
    tenantKey?: unknown
    appId?: unknown
    email?: unknown
    name?: unknown
    avatarUrl?: unknown
    exp?: unknown
  }>(cookie, options.secret)
  // parseSignedPayload also returns null for a structurally broken cookie; both
  // land here as bad-signature — from the outside they are indistinguishable.
  if (!payload) return { user: null, reason: 'bad-signature' }
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number') return { user: null, reason: 'malformed-payload' }
  if (payload.exp < now) return { user: null, exp: payload.exp, reason: 'expired' }
  if (typeof payload.openid !== 'string' || typeof payload.profile !== 'string') {
    return { user: null, reason: 'malformed-payload' }
  }
  return {
    exp: payload.exp,
    user: {
      openid: payload.openid,
      profile: payload.profile,
      role: payload.role === 'admin' ? 'admin' : 'user',
      ...(typeof payload.userId === 'string' && payload.userId ? { userId: payload.userId } : {}),
      ...(typeof payload.unionId === 'string' && payload.unionId ? { unionId: payload.unionId } : {}),
      ...(typeof payload.tenantKey === 'string' && payload.tenantKey ? { tenantKey: payload.tenantKey } : {}),
      ...(typeof payload.appId === 'string' && payload.appId ? { appId: payload.appId } : {}),
      ...(typeof payload.email === 'string' && payload.email ? { email: payload.email } : {}),
      ...(typeof payload.name === 'string' && payload.name ? { name: payload.name } : {}),
      ...(typeof payload.avatarUrl === 'string' && payload.avatarUrl ? { avatarUrl: payload.avatarUrl } : {}),
    },
  }
}

/** Narrow view kept for the Socket.IO handshake / broker-controller callers. */
export function parseFeishuSessionCookie(cookie: string | undefined, options: ParseOptions): WebUser | null {
  return parseFeishuSession(cookie, options).user
}

export function cookieSecure(ctx: Context): boolean {
  const forwardedProto = (typeof ctx.get === 'function' ? ctx.get('x-forwarded-proto') : '')
    .split(',')[0]?.trim().toLowerCase() || ''
  return ctx.protocol === 'https' || ctx.secure || forwardedProto === 'https'
}

/**
 * Single implementation of the Feishu cookie write — the OAuth callback, the
 * logout clear and the sliding renewal below MUST agree on flags, otherwise a
 * renewal silently writes a second cookie next to the original one.
 */
export function setFeishuCookie(ctx: Context, name: string, value: string, maxAgeSeconds: number) {
  ctx.cookies.set(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(ctx),
    maxAge: maxAgeSeconds * 1000,
    overwrite: true,
  })
}

export function createFeishuState(secret = getFeishuSessionSecret()): string {
  const state = randomBytes(24).toString('base64url')
  return signPayload({
    state,
    iat: Math.floor(Date.now() / 1000),
  }, secret)
}

export function verifyFeishuState(cookieState: string | undefined, returnedState: string | undefined, secret = getFeishuSessionSecret()): boolean {
  if (!cookieState || !returnedState || cookieState !== returnedState) return false
  return !!parseSignedPayload(cookieState, secret)
}

export function buildFeishuAuthorizeUrl(state: string, scope: string): string {
  const url = new URL(config.feishuAuthorizeUrl)
  if (url.hostname === 'accounts.feishu.cn') {
    url.searchParams.set('client_id', config.feishuAppId)
    url.searchParams.set('response_type', 'code')
  } else {
    // Keep explicit legacy FEISHU_AUTHORIZE_URL deployments compatible.
    url.searchParams.set('app_id', config.feishuAppId)
  }
  url.searchParams.set('redirect_uri', config.feishuRedirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', scope)
  return url.toString()
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Feishu API HTTP ${res.status}`)
  }
  return data as T
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Feishu API HTTP ${res.status}`)
  }
  return data as T
}

function pickAvatar(data: FeishuUserInfoResponse['data'] | null): string | undefined {
  return data?.avatar_url || data?.avatar_middle || data?.avatar_thumb || data?.avatar_big
}

async function getFeishuUserInfo(accessToken: string): Promise<FeishuUserInfoResponse['data'] | null> {
  const data = await getJson<FeishuUserInfoResponse>(
    `${config.feishuApiBaseUrl}/open-apis/authen/v1/user_info`,
    { Authorization: `Bearer ${accessToken}` },
  )
  if (data.code !== 0) return null
  return data.data || null
}

export async function exchangeFeishuCode(code: string): Promise<{
  openid: string
  userId?: string
  unionId?: string
  tenantKey?: string
  appId?: string
  email?: string
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  refreshTokenExpiresIn?: number
  scope?: string
  name?: string
  avatarUrl?: string
}> {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error('Feishu OAuth is not configured')
  }
  const data = await postJson<FeishuTokenResponse>(
    config.feishuTokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: config.feishuAppId,
      client_secret: config.feishuAppSecret,
      code,
      redirect_uri: config.feishuRedirectUri,
    },
  )

  const accessToken = data.access_token
  if (!accessToken) {
    throw new Error(data.error_description || data.msg || 'Failed to exchange Feishu authorization code')
  }
  const userInfo = await getFeishuUserInfo(accessToken)
  const openid = userInfo?.open_id
  if (!openid) {
    throw new Error('Failed to verify Feishu OAuth user')
  }

  return {
    openid,
    userId: userInfo?.user_id,
    unionId: userInfo?.union_id,
    tenantKey: userInfo?.tenant_key,
    appId: config.feishuAppId || undefined,
    email: userInfo?.enterprise_email || userInfo?.email,
    accessToken,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    refreshTokenExpiresIn: data.refresh_token_expires_in,
    scope: data.scope,
    name: userInfo?.name || userInfo?.en_name,
    avatarUrl: pickAvatar(userInfo),
  }
}

export async function feishuOAuthAuth(ctx: Context, next: Next): Promise<void> {
  const lowerPath = ctx.path.toLowerCase()
  if (!lowerPath.startsWith('/api') && !lowerPath.startsWith('/v1') && !lowerPath.startsWith('/upload')) {
    await next()
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const parsed = parseFeishuSession(ctx.cookies.get(FEISHU_SESSION_COOKIE), {
    secret: getFeishuSessionSecret(),
    now,
  })
  const user = parsed.user
  if (!user) {
    // Feishu OAuth is the ONLY accepted auth: no Feishu session cookie → 401.
    // No JWT/password fallback (sunke: 飞书唯一登录, no other login entry).
    // The reason is the only observability we have into "why did I get logged
    // out again" — never log the cookie itself, it is a bearer credential.
    logger.warn({
      reason: parsed.reason,
      path: ctx.path,
      ua: ctx.headers['user-agent'],
    }, 'Feishu session rejected')
    ctx.status = 401
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: 'Unauthorized' }
    return
  }
  if (config.requiredProfile && user.profile !== config.requiredProfile) {
    ctx.status = 401
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: 'Unauthorized' }
    return
  }

  // Fork: bridge the Feishu identity into the upstream user-store so that
  // ctx.state.user carries a real numeric `.id` + owned `profiles` (upstream
  // kanban/group-chat/jobs/files controllers enforce isolation off those),
  // while ALSO retaining the WebUser fields (openid/profile/role) that the
  // fork's own readers — getRequestProfile etc. — cast back to. Merge order:
  // WebUser first, AuthenticatedUser last, so `id`/`profiles` are authoritative.
  // Sliding renewal: an actively used session never ages out. Re-sign once the
  // cookie is more than a day old so a daily user always carries a full-TTL
  // cookie; skipping fresh cookies keeps Set-Cookie off the hot path.
  const maxAgeSeconds = config.feishuSessionMaxAgeSeconds
  if (typeof parsed.exp === 'number' && parsed.exp - now < maxAgeSeconds - 24 * 60 * 60) {
    setFeishuCookie(ctx, FEISHU_SESSION_COOKIE, createFeishuSessionCookie({
      openid: user.openid,
      profile: user.profile,
      userId: user.userId,
      unionId: user.unionId,
      tenantKey: user.tenantKey,
      appId: user.appId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      secret: getFeishuSessionSecret(),
      now,
      maxAgeSeconds,
    }), maxAgeSeconds)
  }

  const authUser = ensureWebUserForFeishu(user.openid, {
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  })
  ctx.state.user = { ...user, ...authUser } as unknown as typeof ctx.state.user
  await next()
}

export function createBoundFeishuSession(openid: string, metadata: Partial<Pick<WebUser, 'userId' | 'unionId' | 'tenantKey' | 'appId' | 'email' | 'name' | 'avatarUrl'>> = {}): { user: WebUser; cookie: string } | null {
  const profile = resolveProfileForOpenId(openid)
  if (!profile) return null

  const user = {
    openid,
    profile,
    role: 'user',
    ...(metadata.userId ? { userId: metadata.userId } : {}),
    ...(metadata.unionId ? { unionId: metadata.unionId } : {}),
    ...(metadata.tenantKey ? { tenantKey: metadata.tenantKey } : {}),
    ...(metadata.appId ? { appId: metadata.appId } : {}),
    ...(metadata.email ? { email: metadata.email } : {}),
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.avatarUrl ? { avatarUrl: metadata.avatarUrl } : {}),
  } satisfies WebUser
  const cookie = createFeishuSessionCookie({
    openid,
    profile,
    userId: metadata.userId,
    unionId: metadata.unionId,
    tenantKey: metadata.tenantKey,
    appId: metadata.appId,
    email: metadata.email,
    name: metadata.name,
    avatarUrl: metadata.avatarUrl,
    secret: getFeishuSessionSecret(),
  })
  return { user, cookie }
}
