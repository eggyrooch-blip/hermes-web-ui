import { getDb, isSqliteAvailable } from '../index'
import { MESSAGE_FEEDBACK_TABLE, MESSAGES_TABLE } from './schemas'

export type FeedbackRating = 'up' | 'down'
export type FeedbackReason = 'inaccurate' | 'unresolved' | 'unclear_source' | 'slow' | 'other'

export interface MessageFeedback {
  session_id: string
  run_id: string
  expert_id: string | null
  rating: FeedbackRating
  reason: FeedbackReason | null
  created_at: number
  updated_at: number
}

function mapFeedback(row: Record<string, unknown>): MessageFeedback {
  return {
    session_id: String(row.session_id),
    run_id: String(row.run_id),
    expert_id: row.expert_id == null ? null : String(row.expert_id),
    rating: String(row.rating) as FeedbackRating,
    reason: row.reason == null ? null : String(row.reason) as FeedbackReason,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

export function listFeedback(principalSubject: string, sessionId: string): MessageFeedback[] {
  if (!isSqliteAvailable()) return []
  return (getDb()!.prepare(
    `SELECT session_id, run_id, expert_id, rating, reason, created_at, updated_at
       FROM ${MESSAGE_FEEDBACK_TABLE}
      WHERE principal_subject = ? AND session_id = ?
      ORDER BY created_at, run_id`,
  ).all(principalSubject, sessionId) as Record<string, unknown>[]).map(mapFeedback)
}

export function upsertFeedback(input: {
  principalSubject: string
  sessionId: string
  runId: string
  expertId: string | null
  rating: FeedbackRating
  reason: FeedbackReason | null
}): MessageFeedback {
  if (!isSqliteAvailable()) throw new Error('Feedback storage is unavailable')
  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO ${MESSAGE_FEEDBACK_TABLE}
       (principal_subject, session_id, run_id, expert_id, rating, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(principal_subject, session_id, run_id) DO UPDATE SET
       expert_id = excluded.expert_id,
       rating = excluded.rating,
       reason = excluded.reason,
       updated_at = excluded.updated_at
     WHERE expert_id IS NOT excluded.expert_id
        OR rating IS NOT excluded.rating
        OR reason IS NOT excluded.reason`,
  ).run(input.principalSubject, input.sessionId, input.runId, input.expertId, input.rating, input.reason, now, now)
  const row = db.prepare(
    `SELECT session_id, run_id, expert_id, rating, reason, created_at, updated_at
       FROM ${MESSAGE_FEEDBACK_TABLE}
      WHERE principal_subject = ? AND session_id = ? AND run_id = ?`,
  ).get(input.principalSubject, input.sessionId, input.runId) as Record<string, unknown>
  return mapFeedback(row)
}

export function deleteFeedback(principalSubject: string, sessionId: string, runId: string): void {
  if (!isSqliteAvailable()) throw new Error('Feedback storage is unavailable')
  getDb()!.prepare(
    `DELETE FROM ${MESSAGE_FEEDBACK_TABLE} WHERE principal_subject = ? AND session_id = ? AND run_id = ?`,
  ).run(principalSubject, sessionId, runId)
}

export function hasFinalAnswer(sessionId: string, runId: string): boolean {
  if (!isSqliteAvailable()) return false
  const row = getDb()!.prepare(
    `SELECT content, finish_reason, tool_calls FROM ${MESSAGES_TABLE}
      WHERE session_id = ? AND run_id = ? AND role = 'assistant'
      ORDER BY id DESC LIMIT 1`,
  ).get(sessionId, runId) as { content?: string; finish_reason?: string | null; tool_calls?: string | null } | undefined
  if (!row || !String(row.content || '').trim()) return false
  const finishReason = String(row.finish_reason || '').trim()
  const toolCalls = String(row.tool_calls || '').trim()
  return finishReason !== ''
    && finishReason !== 'error'
    && finishReason !== 'tool_calls'
    && (toolCalls === '' || toolCalls === '[]')
}

export function deleteFeedbackRowsForSession(db: NonNullable<ReturnType<typeof getDb>>, sessionId: string): void {
  db.prepare(`DELETE FROM ${MESSAGE_FEEDBACK_TABLE} WHERE session_id = ?`).run(sessionId)
}
