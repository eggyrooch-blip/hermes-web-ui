import { getSession } from '../../db/hermes/session-store'
import {
  deleteFeedback as deleteFeedbackRow,
  hasFinalAnswer,
  listFeedback as listFeedbackRows,
  upsertFeedback,
  type FeedbackRating,
  type FeedbackReason,
} from '../../db/hermes/feedback-store'
import { canAccessSessionAsync } from './sessions'

const DOWN_REASONS = new Set<FeedbackReason>(['inaccurate', 'unresolved', 'unclear_source', 'slow', 'other'])

function requestPrincipal(ctx: any): { subject: string; ownerId: string } | null {
  const openid = typeof ctx.state?.user?.openid === 'string' ? ctx.state.user.openid.trim() : ''
  if (openid) return { subject: `feishu:${openid}`, ownerId: openid }
  const id = ctx.state?.user?.id
  const ownerId = typeof id === 'string' || typeof id === 'number' ? String(id).trim() : ''
  return ownerId ? { subject: `user:${ownerId}`, ownerId } : null
}

async function authorize(ctx: any) {
  const principal = requestPrincipal(ctx)
  if (!principal) {
    ctx.status = 401
    ctx.body = { error: 'Verified user identity is required' }
    return null
  }
  const sessionId = String(ctx.params?.sessionId || '').trim()
  const session = sessionId ? getSession(sessionId) : null
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return null
  }
  if (!(await canAccessSessionAsync(ctx, session))) {
    ctx.status = 403
    ctx.body = { error: 'Session is not available for this user' }
    return null
  }
  if (String(session.user_id || '').trim() !== principal.ownerId) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return null
  }
  return { principal, session, sessionId }
}

function validatedRun(ctx: any, sessionId: string): string | null {
  const runId = String(ctx.params?.runId || '').trim()
  if (!runId || !hasFinalAnswer(sessionId, runId)) {
    ctx.status = 404
    ctx.body = { error: 'Final answer not found' }
    return null
  }
  return runId
}

export async function listFeedback(ctx: any) {
  const authorized = await authorize(ctx)
  if (!authorized) return
  ctx.body = { feedback: listFeedbackRows(authorized.principal.subject, authorized.sessionId) }
}

export async function putFeedback(ctx: any) {
  const authorized = await authorize(ctx)
  if (!authorized) return
  const body = ctx.request?.body && typeof ctx.request.body === 'object' ? ctx.request.body : {}
  if (Object.keys(body).some(key => key !== 'rating' && key !== 'reason')) {
    ctx.status = 400
    ctx.body = { error: 'Only rating and reason are accepted' }
    return
  }
  const rating = String(body.rating || '') as FeedbackRating
  const rawReason = body.reason == null ? null : String(body.reason)
  if (rating !== 'up' && rating !== 'down') {
    ctx.status = 400
    ctx.body = { error: 'rating must be up or down' }
    return
  }
  if (rating === 'down' && !DOWN_REASONS.has(rawReason as FeedbackReason)) {
    ctx.status = 400
    ctx.body = { error: 'A valid reason is required for down feedback' }
    return
  }
  const runId = validatedRun(ctx, authorized.sessionId)
  if (!runId) return
  const feedback = upsertFeedback({
    principalSubject: authorized.principal.subject,
    sessionId: authorized.sessionId,
    runId,
    expertId: authorized.session.expert_id || null,
    rating,
    reason: rating === 'up' ? null : rawReason as FeedbackReason,
  })
  ctx.body = { feedback }
}

export async function deleteFeedback(ctx: any) {
  const authorized = await authorize(ctx)
  if (!authorized) return
  const runId = validatedRun(ctx, authorized.sessionId)
  if (!runId) return
  deleteFeedbackRow(authorized.principal.subject, authorized.sessionId, runId)
  ctx.body = { ok: true, feedback: null }
}
