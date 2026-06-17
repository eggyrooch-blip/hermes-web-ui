import type { Context, Next } from 'koa'
import { createHmac, timingSafeEqual } from 'crypto'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config'
import { getActiveProfileName, getProfileDir } from './hermes/hermes-profile'
import { ownerOwnsProfile } from './hermes/agent-ownership'

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

function trustedSignaturePayload(
  openid: string,
  timestamp: string,
  metadata?: Partial<Pick<WebUser, 'name' | 'avatarUrl'>>,
): string {
  const name = metadata?.name?.trim() || ''
  const avatarUrl = metadata?.avatarUrl?.trim() || ''
  if (!name && !avatarUrl) return `${openid}.${timestamp}`
  return [
    openid,
    timestamp,
    Buffer.from(name, 'utf8').toString('base64url'),
    Buffer.from(avatarUrl, 'utf8').toString('base64url'),
  ].join('.')
}

export function signTrustedFeishuHeader(
  openid: string,
  timestamp: string,
  secret = config.trustedHeaderSecret,
  metadata?: Partial<Pick<WebUser, 'name' | 'avatarUrl'>>,
): string {
  return createHmac('sha256', secret).update(trustedSignaturePayload(openid, timestamp, metadata)).digest('hex')
}

type TrustedFeishuIdentity = Pick<WebUser, 'openid'> & Partial<Pick<WebUser, 'name' | 'avatarUrl'>>

export function verifyTrustedFeishuHeaders(ctx: Context): ({ ok: true } & TrustedFeishuIdentity) | { ok: false; status: number; error: string } {
  if (!config.trustedHeaderSecret) {
    return { ok: false, status: 500, error: 'Trusted Feishu auth is not configured' }
  }

  const openid = headerValue(ctx, config.trustedHeaderOpenId).trim()
  const name = headerValue(ctx, config.trustedHeaderName).trim()
  const avatarUrl = headerValue(ctx, config.trustedHeaderAvatarUrl).trim()
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

  const metadata = {
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  }
  const expected = signTrustedFeishuHeader(openid, timestamp, config.trustedHeaderSecret, metadata)
  if (!safeEqual(signature, expected)) {
    return { ok: false, status: 401, error: 'Invalid trusted Feishu auth signature' }
  }

  return {
    ok: true,
    openid,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  }
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
        const columns = new Set((db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(column => column.name))
        const predicates = ['open_id = ?', 'active = 1']
        if (columns.has('kind')) predicates.push("(kind = 'user' OR kind IS NULL OR kind = '')")
        if (columns.has('provenance')) predicates.push("provenance = 'sync'")
        const orderBy = columns.has('kind')
          ? "CASE WHEN kind = 'user' THEN 0 WHEN kind IS NULL OR kind = '' THEN 1 ELSE 2 END, profile_name"
          : 'profile_name'
        const row = db.prepare(
          `SELECT profile_name FROM multitenancy_routing WHERE ${predicates.join(' AND ')} ORDER BY ${orderBy} LIMIT 1`,
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

  // Fork: bridge the Feishu identity into the upstream user-store so ctx.state.user
  // carries a real numeric `.id` + owned `profiles` (upstream controllers enforce
  // isolation off those) while ALSO retaining the WebUser fields (openid/profile/
  // role) the fork's own readers cast back to. Merge AuthenticatedUser last so
  // `id`/`profiles` win. Imported lazily to avoid a request-context ↔ compat-user
  // import cycle at module-load time.
  const { ensureWebUserForFeishu } = await import('./compat-user')
  const metadata = {
    ...(verified.name ? { name: verified.name } : {}),
    ...(verified.avatarUrl ? { avatarUrl: verified.avatarUrl } : {}),
  }
  const webUser = { openid: verified.openid, profile, role: 'user', ...metadata } satisfies WebUser
  const authUser = ensureWebUserForFeishu(verified.openid, Object.keys(metadata).length > 0 ? metadata : undefined)
  ctx.state.user = { ...webUser, ...authUser } as unknown as typeof ctx.state.user
  await next()
}

export function getRequestProfile(ctx: Context): string {
  const user = ctx.state?.user as WebUser | undefined
  if (config.webPlane === 'chat' && user?.profile) {
    const requestedProfile = (ctx.get?.('x-hermes-profile') || (ctx.query?.profile as string) || '').trim()
    if (requestedProfile && requestedProfile !== user.profile && ownerOwnsProfile(user.openid, requestedProfile)) {
      return requestedProfile
    }
    return user.profile
  }
  return (ctx.get?.('x-hermes-profile') || (ctx.query?.profile as string) || getActiveProfileName() || 'default')
}

export function getRequestProfileDir(ctx: Context): string {
  return getProfileDir(getRequestProfile(ctx))
}

export function isChatPlaneRequest(_ctx?: Context): boolean {
  return config.webPlane === 'chat'
}

const CHAT_PLANE_KANBAN_DETAIL_BLOCKLIST = new Set([
  'artifact',
  'assignees',
  'boards',
  'capabilities',
  'complete',
  'diagnostics',
  'dispatch',
  'events',
  'links',
  'search-sessions',
  'stats',
  'tasks',
  'unblock',
])

function isChatPlaneKanbanTaskDetail(path: string, method: string): boolean {
  if (method !== 'GET') return false
  const match = path.match(/^\/api\/hermes\/kanban\/([^/]+)$/)
  if (!match) return false
  try {
    return !CHAT_PLANE_KANBAN_DETAIL_BLOCKLIST.has(decodeURIComponent(match[1]).toLowerCase())
  } catch {
    return false
  }
}

function isChatPlaneKanbanTaskAction(path: string, method: string): boolean {
  if (method === 'POST' && (path === '/api/hermes/kanban/complete' || path === '/api/hermes/kanban/unblock')) return true
  if (method !== 'POST') return false
  const match = path.match(/^\/api\/hermes\/kanban\/([^/]+)\/(block|assign)$/)
  if (!match) return false
  try {
    return !CHAT_PLANE_KANBAN_DETAIL_BLOCKLIST.has(decodeURIComponent(match[1]).toLowerCase())
  } catch {
    return false
  }
}

function forbiddenInChatPlane(ctx: Context): boolean {
  if (config.webPlane !== 'chat') return false
  const path = ctx.path
  const method = ctx.method.toUpperCase()

  if (path === '/api/auth/status' || path === '/api/auth/me' || path === '/api/auth/feishu/logout' || path === '/health' || path === '/upload') return false
  if (path.startsWith('/api/auth/feishu/uat/')) return false
  if (path.startsWith('/api/auth/skill-credentials')) return false
  if (path.startsWith('/api/hermes/sessions')) return false
  if (path.startsWith('/api/hermes/search/sessions')) return false
  if (path.startsWith('/api/hermes/usage/stats')) return false
  if (path.startsWith('/api/hermes/jobs')) return false
  if (path.startsWith('/api/hermes/files')) return false
  if (path.startsWith('/api/hermes/group-chat')) return false
  if (path === '/api/hermes/kanban' && (method === 'GET' || method === 'POST')) return false
  if (path === '/api/hermes/kanban/boards' && method === 'GET') return false
  if (path === '/api/hermes/kanban/capabilities' && method === 'GET') return false
  if (path === '/api/hermes/kanban/stats' && method === 'GET') return false
  if (path === '/api/hermes/kanban/assignees' && method === 'GET') return false
  if (path === '/api/hermes/kanban/dispatch' && method === 'POST') return false
  if (isChatPlaneKanbanTaskDetail(path, method)) return false
  if (isChatPlaneKanbanTaskAction(path, method)) return false
  if (path === '/api/hermes/profiles' && (method === 'GET' || method === 'POST')) return false
  if (path === '/api/hermes/slash/commands' && method === 'GET') return false
  if (path === '/api/hermes/config/model' && method === 'PUT') return false
  if (path === '/api/hermes/config/credentials') return true
  if (config.chatPlaneAllowSettings && path === '/api/hermes/config' && (method === 'GET' || method === 'PUT')) return false
  if (path === '/api/hermes/skills/skillhub/install' && method === 'POST') return false
  if (path === '/api/hermes/skills/file' && method === 'PUT') return false
  if (path.startsWith('/api/hermes/skills')) return method === 'PUT' || method === 'POST' || method === 'DELETE'
  if (path === '/api/hermes/memory') return method !== 'GET' && method !== 'POST'
  if (path.startsWith('/api/hermes/download')) return false
  if (path.startsWith('/api/hermes/v1/') || path.startsWith('/v1/')) return false
  if (path === '/api/hermes/available-models') return false

  // Coding Agents launch/install/config is an ADMIN-ONLY host tool (it spawns
  // codex/claude-code CLIs against global ~/.claude / ~/.codex config). It must
  // never be reachable by multi-tenant chat-plane users — UI-hiding is not enough.
  if (path.startsWith('/api/coding-agents')) return true

  const blockedPrefixes = [
    '/api/auth/',
    '/api/hermes/profiles',
    '/api/hermes/gateways',
    '/api/hermes/config',
    '/api/hermes/auth/',
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
