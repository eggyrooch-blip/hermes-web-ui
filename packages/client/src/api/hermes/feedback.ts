import { request } from '../client'

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

export async function fetchFeedback(sessionId: string): Promise<MessageFeedback[]> {
  const response = await request<{ feedback: MessageFeedback[] }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/feedback`,
  )
  return response.feedback
}

export async function putFeedback(
  sessionId: string,
  runId: string,
  rating: FeedbackRating,
  reason: FeedbackReason | null,
): Promise<MessageFeedback> {
  const response = await request<{ feedback: MessageFeedback }>(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/feedback`,
    { method: 'PUT', body: JSON.stringify({ rating, reason }) },
  )
  return response.feedback
}

export async function deleteFeedback(sessionId: string, runId: string): Promise<void> {
  await request(
    `/api/hermes/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/feedback`,
    { method: 'DELETE' },
  )
}
