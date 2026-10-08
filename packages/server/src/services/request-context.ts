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
  userId?: string
  unionId?: string
  tenantKey?: string
  appId?: string
  email?: string
  name?: string
  avatarUrl?: string
}

export const CHAT_PLANE_CONFIG_SECTIONS = new Set([
  'display',
  'session_reset',
  'privacy',
])

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

function verifyTrustedFeishuHeaderValues(getHeader: (name: string) => string): ({ ok: true } & TrustedFeishuIdentity) | { ok: false; status: number; error: string } {
  if (!config.trustedHeaderSecret) {
    return { ok: false, status: 500, error: 'Trusted Feishu auth is not configured' }
  }

  const openid = getHeader(config.trustedHeaderOpenId).trim()
  const name = getHeader(config.trustedHeaderName).trim()
  const avatarUrl = getHeader(config.trustedHeaderAvatarUrl).trim()
  const timestamp = getHeader(config.trustedHeaderTimestamp).trim()
  const signature = getHeader(config.trustedHeaderSignature).trim()
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

export function verifyTrustedFeishuHeaders(ctx: Context): ReturnType<typeof verifyTrustedFeishuHeaderValues> {
  return verifyTrustedFeishuHeaderValues(name => ctx.get(name) || '')
}

export function verifyTrustedFeishuSocketHeaders(
  headers: Record<string, string | string[] | undefined>,
): ReturnType<typeof verifyTrustedFeishuHeaderValues> {
  return verifyTrustedFeishuHeaderValues(name => {
    const value = headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] || '' : value || ''
  })
}

export function candidateMultitenancyDbs(): string[] {
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

// 任务详情页的 log 这一跳。详情本体 (`GET /kanban/:id`) 和 block/assign/complete/unblock
// 这些**写**动作早就放行了，唯独这个**读**没放 —— 是列举时漏掉，不是刻意收紧
// （2026-08-13 由端点归属快照扫出）。控制器 `kanban.ts:823 taskLog()` 与详情同款守卫：
// requireOpenId + requireOwnedTasks(..., openid)，非本人任务被拒（403），不从请求体取身份。
// 沿用同一份 blocklist 卡 id 段，避免 `/kanban/artifact/log` 之类混进来。
function isChatPlaneKanbanTaskLog(path: string, method: string): boolean {
  if (method !== 'GET') return false
  const match = path.match(/^\/api\/hermes\/kanban\/([^/]+)\/log$/)
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

function isChatPlaneCoworkRequest(path: string, method: string): boolean {
  const id = '[^/]{1,256}'
  if (path === '/api/hermes/cowork/projects') return method === 'GET' || method === 'POST'
  if (new RegExp(`^/api/hermes/cowork/projects/${id}$`).test(path)) return ['GET', 'PATCH', 'DELETE'].includes(method)
  if (new RegExp(`^/api/hermes/cowork/projects/${id}/sessions$`).test(path)) return method === 'GET'
  if (new RegExp(`^/api/hermes/cowork/sessions/${id}/project$`).test(path)) return method === 'GET'
  return false
}

function forbiddenInChatPlane(ctx: Context): boolean {
  if (config.webPlane !== 'chat') return false
  // 路径必须先小写归一再比较：@koa/router 的 `sensitive` 默认 false（匹配不区分大小写），
  // 闸若逐字比较就比 router 窄，`/API/HERMES/LOGS` 会绕过整张黑名单而路由照样命中。
  // 铁律：**这道闸至少要和 router 一样宽**。详见 AGENTS.md「Local known gotchas」2026-08-14。
  const path = ctx.path.toLowerCase()
  const method = ctx.method.toUpperCase()

  if (path === '/api/auth/status' || path === '/api/auth/me' || path === '/api/auth/feishu/logout' || path === '/health' || path === '/upload') return false
  if (path.startsWith('/api/auth/feishu/uat/')) return false
  if (path.startsWith('/api/auth/skill-credentials')) return false
  if (path === '/api/auth/mcp-oauth/approve' && method === 'POST') return false
  if (/^\/api\/auth\/mcp-oauth\/requests\/[^/]{1,128}$/.test(path) && method === 'GET') return false
  // Expert catalog (专家广场) — read-only, audience-filtered per the caller's own
  // profile by the broker; safe for chat-plane users (GET only).
  if (path.startsWith('/api/hermes/experts')) return method !== 'GET'
  if (path.startsWith('/api/hermes/plugin-assets/')) return method !== 'GET'
  if (path.startsWith('/api/hermes/sessions')) return false
  if (path.startsWith('/api/hermes/agents')) return false
  if (path.startsWith('/api/hermes/search/sessions')) return false
  if (path.startsWith('/api/hermes/usage/stats')) return false
  if (path.startsWith('/api/hermes/jobs')) return false
  if (path.startsWith('/api/hermes/files')) return false
  if (path.startsWith('/api/hermes/group-chat')) return false
  if (isChatPlaneCoworkRequest(path, method)) return false
  if (path === '/api/hermes/kanban' && (method === 'GET' || method === 'POST')) return false
  if (path === '/api/hermes/kanban/boards' && method === 'GET') return false
  if (path === '/api/hermes/kanban/capabilities' && method === 'GET') return false
  if (path === '/api/hermes/kanban/stats' && method === 'GET') return false
  if (path === '/api/hermes/kanban/assignees' && method === 'GET') return false
  if (path === '/api/hermes/kanban/dispatch' && method === 'POST') return false
  if (isChatPlaneKanbanTaskDetail(path, method)) return false
  if (isChatPlaneKanbanTaskLog(path, method)) return false
  if (isChatPlaneKanbanTaskAction(path, method)) return false
  if (path === '/api/hermes/profiles' && (method === 'GET' || method === 'POST')) return false
  if (path === '/api/hermes/slash/commands' && method === 'GET') return false
  if (path === '/api/hermes/link-previews' && method === 'POST') return false
  if (path === '/api/hermes/config/model' && method === 'PUT') return false
  // 员工提交自己的 GitLab token —— 这个端点的目标用户**就是** chat 面的员工，
  // 却因为落到本函数结尾的 catch-all 而一直被拒（403 not available in chat plane），
  // 等于功能从上线起对它唯一的用户就没工作过（sunke 2026-08-05 实机撞到）。
  // 放行是安全的：控制器不从请求体取身份，owner 只认已验证会话的 ctx.state.user.openid，
  // 服务端盖 X-Hermes-Owner-Open-Id，无身份仍自行 403 —— 与 kanban/jobs 同款写法。
  // 只放 POST：这个路径没有别的动词。
  if (path === '/api/hermes/credentials/gitlab' && method === 'POST') return false
  if (path === '/api/hermes/credentials/github' && (method === 'POST' || method === 'DELETE')) return false
  // 同理：Figma 撤销的唯一用户就是 chat 面的员工。身份同样只从已验证会话来，
  // 控制器无身份自行 403。只放 DELETE —— 起授权走 /api/auth/skill-credentials/figma/start。
  if (path === '/api/hermes/credentials/figma' && method === 'DELETE') return false
  // 云电脑看屏：员工看/接管自己 bot 的桌面。控制器只认已验证会话的 openid，
  // 盖 X-Hermes-Owner-Open-Id；请求里点名的 profile/agent 不归本人则 403。
  if (/^\/api\/hermes\/desktop\/(observe|ensure|lease\/acquire|lease\/release)$/.test(path) && method === 'POST') return false
  if (path === '/api/hermes/config/credentials') return true
  if (config.chatPlaneAllowSettings && path === '/api/hermes/config' && (method === 'GET' || method === 'PUT')) return false
  if (path === '/api/hermes/skills/skillhub/install' && method === 'POST') return false
  if (path === '/api/hermes/skills/import' && method === 'POST') return false
  if (path === '/api/hermes/skills/file' && method === 'PUT') return false
  if (path.startsWith('/api/hermes/skills')) return method === 'PUT' || method === 'POST' || method === 'DELETE'
  if (path === '/api/hermes/write-gate/pending' && method === 'GET') return false
  if (/^\/api\/hermes\/write-gate\/pending\/[^/]+\/[^/]+\/diff$/.test(path) && method === 'GET') return false
  if (/^\/api\/hermes\/write-gate\/pending\/[^/]+\/[^/]+\/(approve|reject)$/.test(path) && method === 'POST') return false
  if (path === '/api/hermes/plugins' && method === 'GET') return false
  if (path === '/api/hermes/mcp/servers' && method === 'GET') return false
  if (path === '/api/hermes/memory') return method !== 'GET' && method !== 'POST'
  if (path.startsWith('/api/hermes/download')) return false
  // Inline preview of workspace artifacts (embedded browser / 详情面板). Shares
  // resolveAndReadHermesFile with download → identical chat-plane confinement
  // (workspace-rooted, sensitive-path blocklist), so it's safe to allow here.
  if (path.startsWith('/api/hermes/preview')) return false
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
