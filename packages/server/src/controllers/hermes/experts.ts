import type { Context } from 'koa'
import { config } from '../../config'
import { logger } from '../../services/logger'
import { getRequestProfile } from '../../services/request-context'
import {
  fetchExpertCatalog,
  emptyCatalog,
} from '../../services/hermes/expert-registry-client'

const ASSET_COMPONENT_RE = /^[A-Za-z0-9_.:-]{1,180}$/
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

interface WebUser {
  openid?: string
  profile?: string
}

/**
 * GET /api/hermes/experts — proxy the expert catalog from the Run Broker.
 *
 * Mirrors the skills/connectors BFF pattern. Profile is resolved through the
 * shared request-context (chat-plane isolation honoured). When the broker is
 * unavailable the catalog is served EMPTY — never a fabricated expert.
 */
export async function list(ctx: Context): Promise<void> {
  const profileName = getRequestProfile(ctx)
  const user = ctx.state?.user as WebUser | undefined
  try {
    ctx.body = await fetchExpertCatalog({ profileName, userKey: user?.openid })
  } catch (err: any) {
    logger.warn(
      { profile: profileName, err: err?.message || String(err) },
      'Expert broker unavailable; serving empty catalog',
    )
    ctx.body = emptyCatalog(profileName)
  }
}

function safeAssetComponent(raw: unknown): string | null {
  const value = String(raw || '').trim()
  if (!value || value.startsWith('.') || value.includes('/') || value.includes('\\')) return null
  return ASSET_COMPONENT_RE.test(value) ? value : null
}

/**
 * GET /api/hermes/plugin-assets/:pluginId/:assetName — browser-loadable BFF
 * proxy for Run Broker managed plugin assets.
 */
export async function asset(ctx: Context): Promise<void> {
  const pluginId = safeAssetComponent(ctx.params.pluginId)
  const assetName = safeAssetComponent(ctx.params.assetName)
  if (!pluginId || !assetName) {
    ctx.status = 404
    ctx.body = { error: 'not found' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'run broker unavailable' }
    return
  }

  const profileName = getRequestProfile(ctx)
  const user = ctx.state?.user as WebUser | undefined
  const params = new URLSearchParams()
  params.set('profile_name', profileName)
  if (user?.openid) params.set('user_key', user.openid)
  const headers: Record<string, string> = {}
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  headers['X-Hermes-Profile'] = profileName
  if (user?.openid) headers['X-Hermes-User-Key'] = user.openid
  const url = `${config.runBrokerUrl}/api/run-broker/plugin-assets/${encodeURIComponent(pluginId)}/${encodeURIComponent(assetName)}?${params.toString()}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
    })
  } catch (err: any) {
    logger.warn({ pluginId, assetName, err: err?.message || String(err) }, 'Expert asset broker request failed')
    ctx.status = 503
    ctx.body = { error: 'asset unavailable' }
    return
  }
  if (!res.ok) {
    ctx.status = res.status === 401 ? 502 : res.status
    ctx.body = { error: 'asset unavailable' }
    return
  }
  const contentType = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase()
  if (!IMAGE_CONTENT_TYPES.has(contentType)) {
    ctx.status = 502
    ctx.body = { error: 'invalid asset type' }
    return
  }
  const body = Buffer.from(await res.arrayBuffer())
  ctx.set('Content-Type', contentType)
  ctx.set('Cache-Control', res.headers.get('cache-control') || 'public, max-age=3600')
  ctx.set('X-Content-Type-Options', 'nosniff')
  ctx.body = body
}
