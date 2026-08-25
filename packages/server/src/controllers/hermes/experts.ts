import type { Context } from 'koa'
import { config } from '../../config'
import { logger } from '../../services/logger'
import { getRequestProfile } from '../../services/request-context'
import {
  fetchExpertCatalog,
  emptyCatalog,
  resolveExpertOwner,
} from '../../services/hermes/expert-registry-client'
import { isSessionStorageAvailable, listSessions } from '../../db/hermes/session-store'
import { listFeedback } from '../../db/hermes/feedback-store'

const ASSET_COMPONENT_RE = /^[A-Za-z0-9_.:-]{1,180}$/
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

interface WebUser {
  openid?: string
  profile?: string
}

const WORK_RECORD_LIMIT = 20
const WORK_RECORD_SCAN_LIMIT = 2000
const WORK_RECORD_WINDOW_DAYS = 30

function principal(ctx: Context): { openid: string; profile: string; subject: string } | null {
  const user = ctx.state?.user as WebUser | undefined
  const openid = user?.openid?.trim() || ''
  const profile = user?.profile?.trim() || ''
  return openid && profile ? { openid, profile, subject: `feishu:${openid}` } : null
}

function unavailable(items = false) {
  return items ? { status: 'unavailable', items: [] } : { status: 'unavailable' }
}

function recentExpertSessions(expertId: string, profile?: string) {
  const cutoff = Math.floor(Date.now() / 1000) - WORK_RECORD_WINDOW_DAYS * 86400
  return listSessions(profile, undefined, WORK_RECORD_SCAN_LIMIT, { includeArchived: true })
    .filter(session => session.expert_id === expertId && !!session.user_id && session.last_active >= cutoff)
}

export async function workRecord(ctx: Context): Promise<void> {
  const actor = principal(ctx)
  if (!actor) {
    ctx.status = 401
    ctx.body = { error: 'Verified user identity is required' }
    return
  }
  const expertId = String(ctx.params?.expertId || '').trim()
  if (!expertId) {
    ctx.status = 404
    ctx.body = { error: 'not found' }
    return
  }

  if (ctx.query?.view === 'maintainer') {
    let owner: { subject: string }
    try {
      owner = await resolveExpertOwner({ profileName: actor.profile, userKey: actor.openid, expertId })
    } catch {
      ctx.status = 503
      ctx.body = { error: 'expert maintainer unavailable' }
      return
    }
    if (owner.subject !== actor.subject) {
      ctx.status = 404
      ctx.body = { error: 'not found' }
      return
    }

    let sessionRows: ReturnType<typeof recentExpertSessions> = []
    let sessionsPartition: Record<string, unknown>
    try {
      if (!isSessionStorageAvailable()) throw new Error('session storage unavailable')
      // ponytail: bounded 2,000-row live owner verification; persist owner bindings only if this view becomes slow.
      const ownerByRoute = new Map<string, string>()
      for (const session of recentExpertSessions(expertId)) {
        const userKey = session.user_id || ''
        const routeKey = `${session.profile}\n${userKey}`
        let sessionOwner = ownerByRoute.get(routeKey)
        if (!sessionOwner) {
          sessionOwner = (await resolveExpertOwner({
            profileName: session.profile,
            userKey,
            expertId,
          })).subject
          ownerByRoute.set(routeKey, sessionOwner)
        }
        if (sessionOwner === actor.subject) sessionRows.push(session)
      }
      sessionsPartition = {
        status: 'available',
        count: sessionRows.length,
        active: sessionRows.filter(row => row.ended_at == null).length,
        completed: sessionRows.filter(row => row.ended_at != null).length,
      }
    } catch {
      sessionsPartition = unavailable()
    }
    let feedbackPartition: Record<string, unknown> = unavailable()
    if (sessionsPartition.status === 'available') try {
      const cutoff = Math.floor(Date.now() / 1000) - WORK_RECORD_WINDOW_DAYS * 86400
      const rows = sessionRows.flatMap(session => (
        listFeedback(`feishu:${session.user_id}`, session.id)
      )).filter(row => row.expert_id === expertId && row.updated_at >= cutoff)
      const positive = rows.filter(row => row.rating === 'up').length
      const negative = rows.filter(row => row.rating === 'down').length
      feedbackPartition = {
        status: 'available',
        count: rows.length,
        positive,
        negative,
        positive_rate: rows.length ? positive / rows.length : 0,
      }
    } catch {
      feedbackPartition = unavailable()
    }
    let jobsPartition: Record<string, unknown> = unavailable()
    if (sessionsPartition.status === 'available') try {
      const { listJobsForWorkRecord } = await import('./jobs')
      const jobs = new Map<string, Record<string, unknown>>()
      const routes = new Map(sessionRows.map(session => [
        `${session.profile}\n${session.user_id}`,
        { profile: session.profile, openid: session.user_id || '' },
      ]))
      for (const route of routes.values()) {
        const result = await listJobsForWorkRecord(ctx, route)
        if (!result.available) throw new Error('jobs unavailable')
        for (const job of result.jobs) {
          const id = String(job.id || job.job_id || '').trim()
          if (id && String(job.expert_id || '').trim() === expertId) jobs.set(id, job)
        }
      }
      const rows = [...jobs.values()]
        jobsPartition = {
          status: 'available',
          // The jobs authority is owner-scoped: there is no endpoint that
          // enumerates every principal holding a job for this expert. The
          // routes therefore come from the session window, so this count
          // covers exactly those principals — labelled, never presented as an
          // expert-wide total (SPEC: never leak another scope as if it were
          // this one).
          scope: 'principals_with_sessions_in_window',
          count: rows.length,
          active: rows.filter(job => !['paused', 'disabled'].includes(String(job.state || '').trim())).length,
          paused: rows.filter(job => ['paused', 'disabled'].includes(String(job.state || '').trim())).length,
        }
    } catch {
      jobsPartition = unavailable()
    }
    ctx.status = 200
    ctx.body = {
      expert_id: expertId,
      mode: 'maintainer',
      window_days: WORK_RECORD_WINDOW_DAYS,
      partitions: {
        sessions: sessionsPartition,
        jobs: jobsPartition,
        feedback: feedbackPartition,
      },
    }
    return
  }

  try {
    const catalog = await fetchExpertCatalog({ profileName: actor.profile, userKey: actor.openid })
    if (catalog.experts.filter(expert => expert.id === expertId).length !== 1) {
      ctx.status = 404
      ctx.body = { error: 'not found' }
      return
    }
  } catch {
    ctx.status = 503
    ctx.body = { error: 'expert work record unavailable' }
    return
  }

  let sessionRows: ReturnType<typeof recentExpertSessions> = []
  let sessionsPartition: Record<string, unknown>
  let feedbackPartition: Record<string, unknown> = unavailable(true)
  try {
    if (!isSessionStorageAvailable()) throw new Error('session storage unavailable')
    const { canAccessSessionAsync } = await import('./sessions')
    const candidates = recentExpertSessions(expertId, actor.profile)
      .filter(session => session.user_id === actor.openid)
    const allowed = await Promise.all(candidates.map(async session => (
      await canAccessSessionAsync(ctx, session) ? session : null
    )))
    sessionRows = allowed.filter((session): session is NonNullable<typeof session> => !!session)
      .slice(0, WORK_RECORD_LIMIT)
    sessionsPartition = {
      status: 'available',
      items: sessionRows.map(session => ({
        id: session.id,
        title: session.title || '',
        last_active: session.last_active,
        status: session.ended_at == null ? 'active' : 'completed',
      })),
    }
  } catch {
    sessionsPartition = unavailable(true)
  }

  if (sessionsPartition.status === 'available') {
    try {
      const items = sessionRows.flatMap(session => listFeedback(actor.subject, session.id))
        .filter(item => item.expert_id === expertId)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, WORK_RECORD_LIMIT)
        .map(item => ({
          session_id: item.session_id,
          run_id: item.run_id,
          rating: item.rating,
          reason: item.reason,
          updated_at: item.updated_at,
        }))
      feedbackPartition = { status: 'available', items }
    } catch {
      feedbackPartition = unavailable(true)
    }
  }

  let jobsPartition: Record<string, unknown> = unavailable(true)
  try {
    const { listJobsForWorkRecord } = await import('./jobs')
    const result = await listJobsForWorkRecord(ctx)
    if (result.available) {
      jobsPartition = {
        status: 'available',
        items: result.jobs
          .filter(job => String(job.expert_id || '').trim() === expertId)
          .slice(0, WORK_RECORD_LIMIT)
          .map(job => ({
            id: String(job.id || job.job_id || ''),
            name: String(job.name || ''),
            schedule: String(job.schedule_display || ''),
            status: String(job.state || job.last_status || ''),
          }))
          .filter(job => job.id),
      }
    }
  } catch {
    jobsPartition = unavailable(true)
  }
  ctx.status = 200
  ctx.body = {
    expert_id: expertId,
    mode: 'user',
    window_days: WORK_RECORD_WINDOW_DAYS,
    partitions: {
      sessions: {
        ...sessionsPartition,
      },
      jobs: jobsPartition,
      feedback: feedbackPartition,
    },
  }
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
