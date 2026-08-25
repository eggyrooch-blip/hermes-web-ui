import {
  deleteFeedback,
  fetchFeedback,
  putFeedback,
  type FeedbackRating,
  type FeedbackReason,
  type MessageFeedback,
} from '@/api/hermes/feedback'
import { defineStore } from 'pinia'
import { reactive } from 'vue'

function key(sessionId: string, runId: string): string {
  return `${sessionId}\n${runId}`
}

export const useFeedbackStore = defineStore('message-feedback', () => {
  const rows = reactive(new Map<string, MessageFeedback>())
  const loadedSessions = new Set<string>()
  const loads = new Map<string, Promise<void>>()
  const saving = reactive(new Set<string>())
  const errors = reactive(new Map<string, string>())

  function get(sessionId: string, runId: string): MessageFeedback | undefined {
    return rows.get(key(sessionId, runId))
  }

  async function load(sessionId: string): Promise<void> {
    if (!sessionId || loadedSessions.has(sessionId)) return
    const pending = loads.get(sessionId)
    if (pending) return pending
    const task = fetchFeedback(sessionId)
      .then(feedback => {
        for (const row of feedback) rows.set(key(sessionId, row.run_id), row)
        loadedSessions.add(sessionId)
      })
      .finally(() => loads.delete(sessionId))
    loads.set(sessionId, task)
    return task
  }

  async function set(
    sessionId: string,
    runId: string,
    rating: FeedbackRating,
    reason: FeedbackReason | null,
  ): Promise<void> {
    const rowKey = key(sessionId, runId)
    saving.add(rowKey)
    errors.delete(rowKey)
    try {
      rows.set(rowKey, await putFeedback(sessionId, runId, rating, reason))
    } catch (error) {
      errors.set(rowKey, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      saving.delete(rowKey)
    }
  }

  async function remove(sessionId: string, runId: string): Promise<void> {
    const rowKey = key(sessionId, runId)
    saving.add(rowKey)
    errors.delete(rowKey)
    try {
      await deleteFeedback(sessionId, runId)
      rows.delete(rowKey)
    } catch (error) {
      errors.set(rowKey, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      saving.delete(rowKey)
    }
  }

  return {
    get,
    load,
    set,
    remove,
    isSaving: (sessionId: string, runId: string) => saving.has(key(sessionId, runId)),
    errorFor: (sessionId: string, runId: string) => errors.get(key(sessionId, runId)) || '',
  }
})
