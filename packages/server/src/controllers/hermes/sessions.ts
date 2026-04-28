import * as hermesCli from '../../services/hermes/hermes-cli'
import { listConversationSummaries, getConversationDetail } from '../../services/hermes/conversations'
import { listConversationSummariesFromDb, getConversationDetailFromDb } from '../../db/hermes/conversations-db'
import { listSessionSummaries, searchSessionSummaries } from '../../db/hermes/sessions-db'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
import { deleteUsage, getUsage, getUsageBatch } from '../../db/hermes/usage-store'
import { getModelContextLength } from '../../services/hermes/model-context'
import { getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getGroupChatServer } from '../../routes/hermes/group-chat'
import { logger } from '../../services/logger'
import type { ConversationSummary } from '../../services/hermes/conversations'

function getPendingDeletedSessionIds(): Set<string> {
  return getGroupChatServer()?.getStorage().getPendingDeletedSessionIds() || new Set<string>()
}

function filterPendingDeletedSessions<T extends { id: string }>(items: T[]): T[] {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return items
  return items.filter(item => !pendingIds.has(item.id))
}

function filterPendingDeletedConversationSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return filterPendingDeletedSessions(items)
}

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  if (useLocalSessionStore()) {
    const profile = getActiveProfileName()
    const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 200)
    const summaries: ConversationSummary[] = sessions.map(s => ({
      id: s.id,
      source: s.source,
      model: s.model,
      title: s.title,
      started_at: s.started_at,
      ended_at: s.ended_at,
      last_active: s.last_active,
      message_count: s.message_count,
      tool_call_count: s.tool_call_count,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      cache_read_tokens: s.cache_read_tokens,
      cache_write_tokens: s.cache_write_tokens,
      reasoning_tokens: s.reasoning_tokens,
      billing_provider: s.billing_provider,
      estimated_cost_usd: s.estimated_cost_usd,
      actual_cost_usd: s.actual_cost_usd,
      cost_status: s.cost_status,
      preview: s.preview,
      is_active: s.ended_at == null && (Date.now() / 1000 - s.last_active) <= 300,
      thread_session_count: 1,
    }))
    ctx.body = { sessions: filterPendingDeletedConversationSummaries(summaries) }
    return
  }

  try {
    const sessions = await listConversationSummariesFromDb({ source, humanOnly, limit })
    ctx.body = { sessions: filterPendingDeletedConversationSummaries(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Conversation DB: summary query failed, falling back to CLI export')
  }

  const sessions = await listConversationSummaries({ source, humanOnly, limit })
  ctx.body = { sessions: filterPendingDeletedConversationSummaries(sessions) }
}

export async function getConversationMessages(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'

  if (useLocalSessionStore()) {
    const detail = localGetSessionDetail(ctx.params.id)
    if (!detail) {
      ctx.status = 404
      ctx.body = { error: 'Conversation not found' }
      return
    }
    const messages = detail.messages
      .filter(m => {
        if (humanOnly && m.role !== 'user' && m.role !== 'assistant') return false
        if (!m.content) return false
        return true
      })
      .map(m => ({
        id: m.id,
        session_id: m.session_id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp,
      }))
    ctx.body = {
      session_id: ctx.params.id,
      messages,
      visible_count: messages.length,
      thread_session_count: 1,
    }
    return
  }

  try {
    const detail = await getConversationDetailFromDb(ctx.params.id, { source, humanOnly })
    if (!detail) {
      ctx.status = 404
      ctx.body = { error: 'Conversation not found' }
      return
    }
    ctx.body = detail
    return
  } catch (err) {
    logger.warn(err, 'Hermes Conversation DB: detail query failed, falling back to CLI export')
  }

  const detail = await getConversationDetail(ctx.params.id, { source, humanOnly })
  if (!detail) {
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  ctx.body = detail
}

export async function list(ctx: any) {
  if (useLocalSessionStore()) {
    const source = (ctx.query.source as string) || undefined
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  }

  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const sessions = await listSessionSummaries(source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
}

export async function search(ctx: any) {
  if (useLocalSessionStore()) {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20)
    ctx.body = { results: filterPendingDeletedSessions(results) }
    return
  }

  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const source = typeof ctx.query.source === 'string' && ctx.query.source.trim()
    ? ctx.query.source.trim()
    : undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const results = await searchSessionSummaries(q, source, limit && limit > 0 ? limit : 20)
    ctx.body = { results: filterPendingDeletedSessions(results) }
  } catch (err) {
    logger.error(err, 'Hermes Session DB: search failed')
    ctx.status = 500
    ctx.body = { error: 'Failed to search sessions' }
  }
}

export async function get(ctx: any) {
  if (useLocalSessionStore()) {
    const session = localGetSessionDetail(ctx.params.id)
    if (!session) {
      ctx.status = 404
      ctx.body = { error: 'Session not found' }
      return
    }
    ctx.body = { session }
    return
  }

  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

export async function remove(ctx: any) {
  if (useLocalSessionStore()) {
    const sessionId = ctx.params.id
    const ok = localDeleteSession(sessionId)
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete session' }
      return
    }
    deleteUsage(sessionId)
    ctx.body = { ok: true }
    return
  }

  const sessionId = ctx.params.id
  const ok = await hermesCli.deleteSession(sessionId)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  deleteUsage(sessionId)
  ctx.body = { ok: true }
}

export async function usageBatch(ctx: any) {
  const ids = (ctx.query.ids as string)
  if (!ids) {
    ctx.body = {}
    return
  }
  const idList = ids.split(',').filter(Boolean)
  ctx.body = getUsageBatch(idList)
}

export async function usageSingle(ctx: any) {
  const result = getUsage(ctx.params.id)
  if (!result) {
    ctx.body = { input_tokens: 0, output_tokens: 0 }
    return
  }
  ctx.body = result
}

export async function rename(ctx: any) {
  if (useLocalSessionStore()) {
    const { title } = ctx.request.body as { title?: string }
    if (!title || typeof title !== 'string') {
      ctx.status = 400
      ctx.body = { error: 'title is required' }
      return
    }
    const ok = localRenameSession(ctx.params.id, title.trim())
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename session' }
      return
    }
    ctx.body = { ok: true }
    return
  }

  const { title } = ctx.request.body as { title?: string }
  if (!title || typeof title !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  const ok = await hermesCli.renameSession(ctx.params.id, title.trim())
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to rename session' }
    return
  }
  ctx.body = { ok: true }
}

export async function contextLength(ctx: any) {
  const profile = (ctx.query.profile as string) || undefined
  ctx.body = { context_length: getModelContextLength(profile) }
}
