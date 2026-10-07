import { request, getApiKey, getBaseUrlValue } from '../client'
import { filenameFromContentDisposition, foreignResponseError, isForeignResponse } from './download'

export type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages'

export interface SessionSummary {
  id: string
  profile?: string | null
  source: string
  agent?: string
  agent_mode?: 'global' | 'scoped' | string
  agent_session_id?: string
  agent_native_session_id?: string
  expert_id?: string | null
  expert_label?: string | null
  expert_avatar?: string | null
  execution_engine?: 'hermes' | 'harness'
  model: string
  provider?: string
  /** Per-session reasoning-effort override; '' or absent means "config default". */
  reasoning_effort?: string
  title: string | null
  preview?: string
  started_at: number
  ended_at: number | null
  last_active?: number
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  workspace?: string | null
  project_id?: string | null
  project_name?: string | null
  project_bound?: boolean
  webui_imported?: boolean
  is_archived?: boolean
  is_pinned?: boolean
}

export interface SessionDetail extends SessionSummary {
  messages: HermesMessage[]
}

export interface PaginatedSessionMessages {
  session: SessionSummary
  messages: HermesMessage[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface SessionSearchResult extends SessionSummary {
  matched_message_id: number | null
  snippet: string
  rank: number
}

export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command'
  content: string
  display_role?: 'user' | 'assistant' | 'system' | 'tool' | 'command' | null
  display_content?: string | null
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  run_id?: string | null
  client_id?: string | null
  source_refs?: import('./chat').SourceRef[] | null
}

export interface WorkspaceRunChangeFileSummary {
  id: number
  change_id: string
  session_id: string
  path: string
  old_path: string | null
  change_type: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  size_before: number | null
  size_after: number | null
  patch_bytes: number
  truncated: boolean
  binary: boolean
  created_at: number
}

export interface WorkspaceRunChangeFileDetail extends WorkspaceRunChangeFileSummary {
  patch: string | null
}

export interface WorkspaceRunChangeSummary {
  change_id: string
  session_id: string
  run_id: string
  source: 'run'
  workspace: string
  workspace_kind: 'git' | 'filesystem' | 'unavailable'
  started_at: number
  finished_at: number
  files_changed: number
  additions: number
  deletions: number
  truncated: boolean
  degraded_reason?: 'lease_acquisition_timeout'
  total_patch_bytes: number
  created_at: number
  files: WorkspaceRunChangeFileSummary[]
}

function profileQuery(profile?: string | null): string {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export async function fetchSessions(source?: string, limit?: number, profile?: string): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/hermes/sessions${query ? `?${query}` : ''}`)
  return res.sessions
}

/**
 * Fetch Hermes sessions only (exclude api_server source)
 */
export async function fetchHermesSessions(source?: string, limit?: number, profile?: string | null): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/hermes/sessions/hermes${query ? `?${query}` : ''}`)
  return res.sessions
}

export async function searchSessions(q: string, source?: string, limit?: number, profile?: string): Promise<SessionSearchResult[]> {
  const params = new URLSearchParams()
  params.set('q', q)
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  if (profile) params.set('profile', profile)
  const query = params.toString()
  const res = await request<{ results: SessionSearchResult[] }>(`/api/hermes/search/sessions?${query}`)
  return res.results
}

export async function fetchSession(id: string, profile?: string | null): Promise<SessionDetail | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const res = await request<{ session: SessionDetail }>(`/api/hermes/sessions/${id}${query ? `?${query}` : ''}`)
    return res.session
  } catch {
    return null
  }
}

export async function fetchWorkspaceRunChanges(
  id: string,
  profile?: string | null,
): Promise<WorkspaceRunChangeSummary[]> {
  const res = await request<{ changes: WorkspaceRunChangeSummary[] }>(
    `/api/hermes/sessions/${encodeURIComponent(id)}/workspace-run-changes${profileQuery(profile)}`,
  )
  return res.changes
}

export async function fetchWorkspaceRunChange(
  id: string,
  changeId: string,
  profile?: string | null,
): Promise<WorkspaceRunChangeSummary | null> {
  try {
    const res = await request<{ change: WorkspaceRunChangeSummary }>(
      `/api/hermes/sessions/${encodeURIComponent(id)}/workspace-run-changes/${encodeURIComponent(changeId)}${profileQuery(profile)}`,
    )
    return res.change
  } catch {
    return null
  }
}

export async function fetchWorkspaceRunChangeFile(
  id: string,
  changeId: string,
  fileId: number,
  profile?: string | null,
): Promise<WorkspaceRunChangeFileDetail | null> {
  try {
    const res = await request<{ file: WorkspaceRunChangeFileDetail }>(
      `/api/hermes/sessions/${encodeURIComponent(id)}/workspace-run-changes/${encodeURIComponent(changeId)}/files/${encodeURIComponent(String(fileId))}${profileQuery(profile)}`,
    )
    return res.file
  } catch {
    return null
  }
}

export async function fetchSessionMessagesPage(
  id: string,
  offset: number,
  limit = 150,
  profile?: string | null,
): Promise<PaginatedSessionMessages | null> {
  try {
    const params = new URLSearchParams()
    params.set('offset', String(offset))
    params.set('limit', String(limit))
    if (profile) params.set('profile', profile)
    const res = await request<PaginatedSessionMessages>(
      `/api/hermes/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?${params}`,
      { signal: AbortSignal.timeout(15_000) },
    )
    return res
  } catch (err) {
    console.error('Failed to fetch paginated session messages:', err)
    return null
  }
}

/**
 * Fetch Hermes session detail only (exclude api_server source)
 */
export async function fetchHermesSession(id: string, profile?: string | null): Promise<SessionDetail | null> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const res = await request<{ session: SessionDetail }>(`/api/hermes/sessions/hermes/${id}${query ? `?${query}` : ''}`)
    return res.session
  } catch {
    return null
  }
}

export async function deleteSession(id: string, profile?: string | null): Promise<boolean> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    await request(`/api/hermes/sessions/${id}${query ? `?${query}` : ''}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

export async function setSessionArchived(id: string, archived: boolean, profile?: string | null): Promise<boolean> {
  try {
    const params = new URLSearchParams()
    if (profile) params.set('profile', profile)
    const query = params.toString()
    const action = archived ? 'archive' : 'unarchive'
    await request(`/api/hermes/sessions/${id}/${action}${query ? `?${query}` : ''}`, { method: 'POST' })
    return true
  } catch {
    return false
  }
}

/**
 * Cross-device session pin. Unlike setSessionArchived this rejects instead of
 * returning false: the caller has to tell a refused pin (403/404) apart from a
 * transport failure so the one-shot localStorage migration can decide whether
 * the legacy key is safe to drop.
 */
export async function setSessionPinned(id: string, pinned: boolean, profile?: string | null): Promise<{ ok: boolean; is_pinned: boolean }> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return request<{ ok: boolean; is_pinned: boolean }>(
    `/api/hermes/sessions/${encodeURIComponent(id)}/pin${query ? `?${query}` : ''}`,
    { method: 'POST', body: JSON.stringify({ is_pinned: pinned }) },
  )
}

export async function importHermesSession(id: string, profile?: string | null): Promise<{ ok: boolean; imported: boolean; session?: SessionDetail }> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return request<{ ok: boolean; imported: boolean; session?: SessionDetail }>(
    `/api/hermes/sessions/hermes/${encodeURIComponent(id)}/import${query ? `?${query}` : ''}`,
    { method: 'POST' },
  )
}

export interface BatchDeleteSessionTarget {
  id: string
  profile?: string | null
}

export async function batchDeleteSessions(targets: Array<string | BatchDeleteSessionTarget>): Promise<{ deleted: number; failed: number; errors: Array<{ id: string; error: string }> }> {
  try {
    const sessions = targets.map(target =>
      typeof target === 'string'
        ? { id: target }
        : { id: target.id, profile: target.profile || undefined },
    )
    const res = await request<{ deleted: number; failed: number; errors: Array<{ id: string; error: string }> }>(
      '/api/hermes/sessions/batch-delete',
      {
        method: 'POST',
        body: JSON.stringify({
          ids: sessions.map(session => session.id),
          sessions,
        }),
      }
    )
    return res
  } catch (err: any) {
    throw err
  }
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
    return true
  } catch {
    return false
  }
}

export async function setSessionWorkspace(id: string, workspace: string | null): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${id}/workspace`, {
      method: 'POST',
      body: JSON.stringify({ workspace: workspace || '' }),
    })
    return true
  } catch {
    return false
  }
}

export interface SessionExpertSaveError {
  status: number | null
  message: string
}

/**
 * The BFF's reason for refusing an expert save — 409 `Expert is fixed once the
 * session has messages` is the one users hit — lives only on the thrown Error,
 * and `setSessionExpert` has to keep its boolean contract for the chat store.
 * Park the reason under the session id the request was made for so the caller
 * reads THIS request's failure instead of re-deriving one from whatever session
 * happens to be active by the time it renders a toast.
 */
const sessionExpertSaveErrors = new Map<string, SessionExpertSaveError>()

function sessionExpertErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number') return status
  const match = /API Error (\d{3})/.exec((err as Error | null)?.message || '')
  return match ? Number(match[1]) : null
}

/** Returns and clears the recorded failure for that session id, if any. */
export function consumeSessionExpertSaveError(sessionId: string): SessionExpertSaveError | null {
  const failure = sessionExpertSaveErrors.get(sessionId)
  if (!failure) return null
  sessionExpertSaveErrors.delete(sessionId)
  return failure
}

export async function setSessionExpert(
  id: string,
  expertId: string | null,
  executionEngine: 'hermes' | 'harness',
  profile?: string,
): Promise<boolean> {
  try {
    const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
    await request(`/api/hermes/sessions/${id}/expert${query}`, {
      method: 'POST',
      body: JSON.stringify({ expert_id: expertId, execution_engine: executionEngine, profile }),
    })
    sessionExpertSaveErrors.delete(id)
    return true
  } catch (err) {
    sessionExpertSaveErrors.set(id, {
      status: sessionExpertErrorStatus(err),
      message: (err as Error | null)?.message || String(err),
    })
    return false
  }
}

/**
 * `familySwitchNotice` is decided by the BFF (it owns the session row that
 * holds the outgoing model, the message count and the one-shot marker) and is
 * true at most once per session — see setModel in
 * packages/server/src/controllers/hermes/sessions.ts.
 */
export async function setSessionModel(id: string, model: string, provider: string, apiMode?: ProviderApiMode): Promise<{ ok: boolean; familySwitchNotice: boolean }> {
  try {
    const res = await request<{ ok?: boolean; family_switch_notice?: boolean }>(`/api/hermes/sessions/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({ model, provider, apiMode }),
    })
    return { ok: true, familySwitchNotice: !!res?.family_switch_notice }
  } catch {
    return { ok: false, familySwitchNotice: false }
  }
}

/**
 * Persist the per-session reasoning-effort override. Pass '' to clear it and
 * fall back to the profile default. Resolves false on any transport or
 * validation failure so the caller can roll the optimistic UI back.
 */
export async function setSessionReasoningEffort(id: string, reasoningEffort: string): Promise<boolean> {
  try {
    await request(`/api/hermes/sessions/${encodeURIComponent(id)}/reasoning-effort`, {
      method: 'POST',
      body: JSON.stringify({ reasoningEffort }),
    })
    return true
  } catch {
    return false
  }
}

export async function exportSession(id: string, mode: 'full' | 'compressed' = 'full', ext: 'json' | 'txt' = 'json'): Promise<void> {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const url = `${baseUrl}/api/hermes/sessions/${id}/export?mode=${mode}&ext=${ext}&token=${encodeURIComponent(token)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Export failed')
  if (isForeignResponse(res)) throw foreignResponseError('导出')
  const blob = await res.blob()
  const filename = filenameFromContentDisposition(res) || `session_${id}.${ext}`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export interface UsageStatsResponse {
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_reasoning_tokens: number
  total_sessions: number
  total_cost: number
  total_api_calls?: number
  period_days?: number
  model_usage: Array<{
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    sessions: number
  }>
  daily_usage: Array<{
    date: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    sessions: number
    errors: number
    cost: number
  }>
}

export async function fetchUsageStats(days = 30): Promise<UsageStatsResponse> {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 30
  const params = new URLSearchParams()
  params.set('days', String(safeDays))
  return request<UsageStatsResponse>(`/api/hermes/usage/stats?${params}`)
}

export async function fetchSessionUsage(ids: string[]): Promise<Record<string, { input_tokens: number; output_tokens: number }>> {
  if (ids.length === 0) return {}
  const params = new URLSearchParams()
  params.set('ids', ids.join(','))
  return request(`/api/hermes/sessions/usage?${params}`)
}

export async function fetchSessionUsageSingle(id: string): Promise<{ input_tokens: number; output_tokens: number } | null> {
  try {
    return await request<{ input_tokens: number; output_tokens: number }>(`/api/hermes/sessions/${id}/usage`)
  } catch {
    return null
  }
}

export async function fetchContextLength(profile?: string, provider?: string, model?: string): Promise<number> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  if (provider) params.set('provider', provider)
  if (model) params.set('model', model)
  const query = params.toString()
  const res = await request<{ context_length: number }>(`/api/hermes/sessions/context-length${query ? `?${query}` : ''}`)
  return res.context_length
}
