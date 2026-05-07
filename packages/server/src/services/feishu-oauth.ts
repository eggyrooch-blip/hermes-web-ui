import type { Context, Next } from 'koa'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { config } from '../config'
import { resolveProfileForOpenId, type WebUser } from './request-context'

export const FEISHU_SESSION_COOKIE = 'hermes_feishu_session'
export const FEISHU_STATE_COOKIE = 'hermes_feishu_state'

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
  data?: {
    open_id?: string
    access_token?: string
    refresh_token?: string
    expires_in?: number
    name?: string
    en_name?: string
    avatar_url?: string
    avatar_thumb?: string
    avatar_middle?: string
    avatar_big?: string
  }
  app_access_token?: string
  tenant_access_token?: string
}

interface FeishuUserInfoResponse {
  code?: number
  msg?: string
  data?: {
    open_id?: string
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
  const [body, signature] = cookie.split('.')
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
    name: options.name,
    avatarUrl: options.avatarUrl,
    iat: now,
    exp: now + maxAgeSeconds,
  }, options.secret)
}

export function parseFeishuSessionCookie(cookie: string | undefined, options: ParseOptions): WebUser | null {
  const payload = parseSignedPayload<{
    openid?: unknown
    profile?: unknown
    role?: unknown
    name?: unknown
    avatarUrl?: unknown
    exp?: unknown
  }>(cookie, options.secret)
  if (!payload) return null
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < now) return null
  if (typeof payload.openid !== 'string' || typeof payload.profile !== 'string') return null
  return {
    openid: payload.openid,
    profile: payload.profile,
    role: payload.role === 'admin' ? 'admin' : 'user',
    ...(typeof payload.name === 'string' && payload.name ? { name: payload.name } : {}),
    ...(typeof payload.avatarUrl === 'string' && payload.avatarUrl ? { avatarUrl: payload.avatarUrl } : {}),
  }
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

export function buildFeishuAuthorizeUrl(state: string): string {
  const url = new URL(config.feishuAuthorizeUrl)
  url.searchParams.set('app_id', config.feishuAppId)
  url.searchParams.set('redirect_uri', config.feishuRedirectUri)
  url.searchParams.set('state', state)
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

function pickAvatar(data: FeishuTokenResponse['data'] | FeishuUserInfoResponse['data'] | null): string | undefined {
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

export async function getFeishuAppAccessToken(): Promise<string> {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error('Feishu OAuth is not configured')
  }

  const data = await postJson<FeishuTokenResponse>(
    `${config.feishuApiBaseUrl}/open-apis/auth/v3/app_access_token/internal`,
    { app_id: config.feishuAppId, app_secret: config.feishuAppSecret },
  )

  if (data.code !== 0 || !data.app_access_token) {
    throw new Error(data.msg || 'Failed to get Feishu app_access_token')
  }
  return data.app_access_token
}

export async function exchangeFeishuCode(code: string): Promise<{
  openid: string
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  name?: string
  avatarUrl?: string
}> {
  const appAccessToken = await getFeishuAppAccessToken()
  const data = await postJson<FeishuTokenResponse>(
    `${config.feishuApiBaseUrl}/open-apis/authen/v1/access_token`,
    { grant_type: 'authorization_code', code },
    { Authorization: `Bearer ${appAccessToken}` },
  )

  const openid = data.data?.open_id
  const accessToken = data.data?.access_token
  if (data.code !== 0 || !openid || !accessToken) {
    throw new Error(data.msg || 'Failed to exchange Feishu authorization code')
  }
  let userInfo: FeishuUserInfoResponse['data'] | null = null
  const tokenName = data.data?.name || data.data?.en_name
  const tokenAvatar = pickAvatar(data.data)
  if (!tokenName || !tokenAvatar) {
    try {
      userInfo = await getFeishuUserInfo(accessToken)
    } catch {
      // The access token exchange is sufficient for login; user_info only enriches display metadata.
    }
  }

  return {
    openid,
    accessToken,
    refreshToken: data.data?.refresh_token,
    expiresIn: data.data?.expires_in,
    name: tokenName || userInfo?.name || userInfo?.en_name,
    avatarUrl: tokenAvatar || pickAvatar(userInfo),
  }
}

export async function feishuOAuthAuth(ctx: Context, next: Next): Promise<void> {
  const lowerPath = ctx.path.toLowerCase()
  if (!lowerPath.startsWith('/api') && !lowerPath.startsWith('/v1') && !lowerPath.startsWith('/upload')) {
    await next()
    return
  }

  const user = parseFeishuSessionCookie(ctx.cookies.get(FEISHU_SESSION_COOKIE), {
    secret: getFeishuSessionSecret(),
  })
  if (!user) {
    ctx.status = 401
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: 'Unauthorized' }
    return
  }

  ctx.state.user = user
  await next()
}

export function createBoundFeishuSession(openid: string, metadata: { name?: string; avatarUrl?: string } = {}): { user: WebUser; cookie: string } | null {
  const profile = resolveProfileForOpenId(openid)
  if (!profile) return null

  const user = {
    openid,
    profile,
    role: 'user',
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.avatarUrl ? { avatarUrl: metadata.avatarUrl } : {}),
  } satisfies WebUser
  const cookie = createFeishuSessionCookie({
    openid,
    profile,
    name: metadata.name,
    avatarUrl: metadata.avatarUrl,
    secret: getFeishuSessionSecret(),
  })
  return { user, cookie }
}
