import type { Context } from 'koa'
import { config } from '../../config'
import { isChatPlaneRequest, type WebUser } from '../../services/request-context'
import { ownerOwnsProfile, resolveAccessibleProfileAgentId } from '../../services/hermes/agent-ownership'

export async function previewFeishuLinks(ctx: Context): Promise<void> {
  const user = ctx.state?.user as WebUser | undefined
  const owner = isChatPlaneRequest(ctx) ? user?.openid?.trim() : ''
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const profile = String(body.profile_name || user?.profile || '').trim()
  const urls = body.urls
  if (!owner || !profile || (profile !== user?.profile && !ownerOwnsProfile(owner, profile))) {
    ctx.status = 403
    ctx.body = { error: 'link preview identity unavailable' }
    return
  }
  if (!Array.isArray(urls) || !urls.length || urls.length > 10 || !urls.every(url => typeof url === 'string')) {
    ctx.status = 400
    ctx.body = { error: 'urls must contain 1 to 10 links' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'link preview unavailable' }
    return
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Owner-Open-Id': owner,
  }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  const agentId = resolveAccessibleProfileAgentId(owner, profile)
  if (agentId) headers['X-Hermes-Agent-Id'] = agentId
  let response: Response
  try {
    response = await fetch(new URL('/api/run-broker/link-previews', config.runBrokerUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ profile_name: profile, urls }),
      signal: AbortSignal.timeout(1_500),
    })
  } catch {
    ctx.status = 503
    ctx.body = { error: 'link preview unavailable' }
    return
  }
  if (!response.ok) {
    ctx.status = response.status === 400 ? 400 : 503
    ctx.body = { error: response.status === 400 ? 'unsupported Feishu link' : 'link preview unavailable' }
    return
  }
  const payload = await response.json() as { previews?: unknown }
  const requested = new Set(urls)
  const statuses = new Set(['resolved', 'forbidden', 'generic'])
  const previews = Array.isArray(payload.previews)
    ? payload.previews.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== 'object') return false
        const preview = item as Record<string, unknown>
        return typeof preview.url === 'string'
          && requested.has(preview.url)
          && typeof preview.status === 'string'
          && statuses.has(preview.status)
      }).map(preview => ({
        kind: String(preview.kind || 'feishu'),
        title: String(preview.title || ''),
        type_label: String(preview.type_label || '飞书链接'),
        url: String(preview.url),
        status: String(preview.status),
      }))
    : []
  ctx.status = 200
  ctx.body = { previews }
}
