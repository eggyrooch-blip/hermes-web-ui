import { config } from '../../config'
import { logger } from '../../services/logger'

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const PROJECT_FIELDS = new Set(['name', 'description', 'instructions', 'icon', 'color', 'primary_folder'])

function actorOpenId(ctx: any): string {
  return typeof ctx.state?.user?.openid === 'string' ? ctx.state.user.openid.trim() : ''
}

function safeId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(id)) throw new Error('Not found')
  return encodeURIComponent(id)
}

function cleanProjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object')
  const body = value as Record<string, unknown>
  const unknown = Object.keys(body).filter(key => !PROJECT_FIELDS.has(key))
  if (unknown.length) throw new Error(`Unsupported Project field: ${unknown[0]}`)
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80)) throw new Error('name is invalid')
  for (const [key, limit] of [['description', 2000], ['instructions', 8000], ['icon', 32], ['color', 32], ['primary_folder', 512]] as const) {
    if (key in body && body[key] != null && (typeof body[key] !== 'string' || body[key].length > limit)) throw new Error(`${key} is invalid`)
  }
  return Object.fromEntries(Object.entries(body).filter(([, item]) => item !== undefined))
}

function headers(ctx: any): Record<string, string> {
  const result: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Hermes-Owner-Open-Id': actorOpenId(ctx),
  }
  if (config.runBrokerKey) result.Authorization = `Bearer ${config.runBrokerKey}`
  const agentId = typeof ctx.get === 'function' ? String(ctx.get('x-hermes-agent-id') || '').trim() : ''
  if (agentId && ID.test(agentId)) result['X-Hermes-Agent-Id'] = agentId
  return result
}

async function proxy(ctx: any, method: Method, path: string, body?: Record<string, unknown>) {
  if (!actorOpenId(ctx)) {
    ctx.status = 401
    ctx.body = { error: 'Verified user identity is required' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'Projects are unavailable', code: 'PROJECTS_UNAVAILABLE' }
    return
  }
  try {
    const response = await fetch(`${config.runBrokerUrl}/api/run-broker${path}`, {
      method,
      headers: headers(ctx),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    ctx.status = response.status
    if (response.status === 403 || response.status === 404) {
      ctx.body = { error: response.status === 404 ? 'Not found' : 'Forbidden' }
      return
    }
    try {
      ctx.body = text ? JSON.parse(text) : {}
    } catch {
      ctx.status = response.ok ? 502 : response.status
      ctx.body = { error: 'Projects returned an invalid response' }
    }
  } catch (err) {
    logger.warn({ err, path }, '[projects] Run Broker request failed')
    ctx.status = 503
    ctx.body = { error: 'Projects are unavailable', code: 'PROJECTS_UNAVAILABLE' }
  }
}

export async function listProjects(ctx: any) {
  const includeArchived = String(ctx.query?.include_archived || '').toLowerCase()
  await proxy(ctx, 'GET', `/projects${['1', 'true'].includes(includeArchived) ? '?include_archived=true' : ''}`)
}

export async function createProject(ctx: any) {
  try { await proxy(ctx, 'POST', '/projects', cleanProjectBody(ctx.request.body)) } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : 'Invalid Project request' }
  }
}

export async function getProject(ctx: any) {
  try { await proxy(ctx, 'GET', `/projects/${safeId(ctx.params.projectId)}`) } catch { ctx.status = 404; ctx.body = { error: 'Not found' } }
}

export async function updateProject(ctx: any) {
  try { await proxy(ctx, 'PATCH', `/projects/${safeId(ctx.params.projectId)}`, cleanProjectBody(ctx.request.body)) } catch (error) {
    ctx.status = error instanceof Error && error.message === 'Not found' ? 404 : 400
    ctx.body = { error: ctx.status === 404 ? 'Not found' : error instanceof Error ? error.message : 'Invalid Project request' }
  }
}

export async function archiveProject(ctx: any) {
  try { await proxy(ctx, 'DELETE', `/projects/${safeId(ctx.params.projectId)}`) } catch { ctx.status = 404; ctx.body = { error: 'Not found' } }
}

export async function listProjectSessions(ctx: any) {
  try { await proxy(ctx, 'GET', `/projects/${safeId(ctx.params.projectId)}/sessions`) } catch { ctx.status = 404; ctx.body = { error: 'Not found' } }
}

export async function getSessionProject(ctx: any) {
  try { await proxy(ctx, 'GET', `/sessions/${safeId(ctx.params.sessionId)}/project`) } catch { ctx.status = 404; ctx.body = { error: 'Not found' } }
}
