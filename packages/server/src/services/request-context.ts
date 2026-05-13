import type { Context, Next } from 'koa'
import { createHmac, timingSafeEqual } from 'crypto'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config'
import { getActiveProfileName, getProfileDir } from './hermes/hermes-profile'

export interface WebUser {
  openid: string
  profile: string
  role: 'user' | 'admin'
  name?: string
  avatarUrl?: string
}

export const CHAT_PLANE_CONFIG_SECTIONS = new Set([
  'display',
  'agent',
  'memory',
  'session_reset',
  'privacy',
  'approvals',
])

function headerValue(ctx: Context, name: string): string {
  return ctx.get(name) || ''
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function signTrustedFeishuHeader(openid: string, timestamp: string, secret = config.trustedHeaderSecret): string {
  return createHmac('sha256', secret).update(`${openid}.${timestamp}`).digest('hex')
}

export function verifyTrustedFeishuHeaders(ctx: Context): { ok: true; openid: string } | { ok: false; status: number; error: string } {
  if (!config.trustedHeaderSecret) {
    return { ok: false, status: 500, error: 'Trusted Feishu auth is not configured' }
  }

  const openid = headerValue(ctx, config.trustedHeaderOpenId).trim()
  const timestamp = headerValue(ctx, config.trustedHeaderTimestamp).trim()
  const signature = headerValue(ctx, config.trustedHeaderSignature).trim()
  if (!openid || !timestamp || !signature) {
    return { ok: false, status: 401, error: 'Missing trusted Feishu auth headers' }
  }

  const timestampNum = Number(timestamp)
  if (!Number.isFinite(timestampNum)) {
    return { ok: false, status: 401, error: 'Invalid trusted Feishu auth timestamp' }
  }
  const now = Math.floor(Date.now() / 1000)
  const maxAge = Number.isFinite(config.trustedHeaderMaxAgeSeconds) ? config.trustedHeaderMaxAgeSeconds : 300
  if (Math.abs(now - timestampNum) > maxAge) {
    return { ok: false, status: 401, error: 'Trusted Feishu auth timestamp expired' }
  }

  const expected = signTrustedFeishuHeader(openid, timestamp, config.trustedHeaderSecret)
  if (!safeEqual(signature, expected)) {
    return { ok: false, status: 401, error: 'Invalid trusted Feishu auth signature' }
  }

  return { ok: true, openid }
}

function candidateMultitenancyDbs(): string[] {
  const configured = config.multitenancyDb
  const base = resolve(homedir(), '.hermes')
  return Array.from(new Set([
    configured,
    resolve(base, 'multitenancy.db'),
    resolve(base, 'multitenancy_routing.db'),
  ]))
}

export function resolveProfileForOpenId(openid: string): string | null {
  for (const dbPath of candidateMultitenancyDbs()) {
    try {
      if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare(
          'SELECT profile_name FROM multitenancy_routing WHERE open_id = ? AND active = 1 LIMIT 1',
        ).get(openid) as { profile_name?: string } | undefined
        const profile = row?.profile_name?.trim()
        if (profile && config.requiredProfile && profile !== config.requiredProfile) return null
        if (profile) return profile
      } finally {
        db.close()
      }
    } catch {
      // Try the next candidate DB.
    }
  }
  return null
}

export async function trustedFeishuAuth(ctx: Context, next: Next): Promise<void> {
  const verified = verifyTrustedFeishuHeaders(ctx)
  if (!verified.ok) {
    ctx.status = verified.status
    ctx.body = { error: verified.error }
    return
  }

  const profile = resolveProfileForOpenId(verified.openid)
  if (!profile) {
    ctx.status = 403
    ctx.body = { error: 'No Hermes profile is bound to this Feishu user' }
    return
  }

  ctx.state.user = { openid: verified.openid, profile, role: 'user' } satisfies WebUser
  await next()
}

export function getRequestProfile(ctx: Context): string {
  const user = ctx.state?.user as WebUser | undefined
  if (config.webPlane === 'chat' && user?.profile) return user.profile
  return (ctx.get?.('x-hermes-profile') || (ctx.query?.profile as string) || getActiveProfileName() || 'default')
}

export function getRequestProfileDir(ctx: Context): string {
  return getProfileDir(getRequestProfile(ctx))
}

export function isChatPlaneRequest(_ctx?: Context): boolean {
  return config.webPlane === 'chat'
}

function forbiddenInChatPlane(ctx: Context): boolean {
  if (config.webPlane !== 'chat') return false
  const path = ctx.path
  const method = ctx.method.toUpperCase()

  if (path === '/api/auth/status' || path === '/api/auth/me' || path === '/api/auth/feishu/logout' || path === '/health' || path === '/upload') return false
  if (path.startsWith('/api/hermes/sessions')) return false
  if (path.startsWith('/api/hermes/search/sessions')) return false
  if (path.startsWith('/api/hermes/usage/stats')) return false
  if (path.startsWith('/api/hermes/jobs')) return false
  if (path.startsWith('/api/hermes/files')) return false
  if (path === '/api/hermes/config/credentials') return true
  if (config.chatPlaneAllowSettings && path === '/api/hermes/config' && (method === 'GET' || method === 'PUT')) return false
  if (path.startsWith('/api/hermes/skills')) return method === 'PUT' || method === 'POST' || method === 'DELETE'
  if (path === '/api/hermes/memory') return method !== 'GET' && method !== 'POST'
  if (path.startsWith('/api/hermes/download')) return false
  if (path.startsWith('/api/hermes/v1/') || path.startsWith('/v1/')) return false
  if (path === '/api/hermes/available-models') return false

  const blockedPrefixes = [
    '/api/auth/',
    '/api/hermes/profiles',
    '/api/hermes/gateways',
    '/api/hermes/config',
    '/api/hermes/auth/',
    '/api/hermes/group-chat',
    '/api/hermes/cron-history',
    '/api/hermes/logs',
    '/api/hermes/update',
    '/api/hermes/channels',
  ]
  if (blockedPrefixes.some(prefix => path.startsWith(prefix))) return true
  return path.startsWith('/api/hermes/')
}

export async function enforcePlaneAccess(ctx: Context, next: Next): Promise<void> {
  if (forbiddenInChatPlane(ctx)) {
    ctx.status = 403
    ctx.body = { error: 'This endpoint is not available in chat plane' }
    return
  }
  await next()
}
