// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(), getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(), onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()), onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onAuthResolved: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default', getActiveExpertId: () => null,
  setActiveExpertId: vi.fn(), hasApiKey: () => false, canAccessProtectedRoutes: () => true,
}))
vi.mock('@/api/hermes/sessions', () => ({
  deleteSession: vi.fn(), fetchSession: vi.fn(), fetchSessions: vi.fn(), setSessionModel: vi.fn(),
}))
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: vi.fn() }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))

import { fetchSessions } from '@/api/hermes/sessions'
import { useChatStore, type Session } from '@/stores/hermes/chat'

describe('chat store Project selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(fetchSessions).mockReset().mockResolvedValue([])
  })

  it('creates a fresh session when a bound task switches Project', () => {
    const store = useChatStore()
    const bound: Session = {
      id: 'bound', title: 'bound', messages: [], createdAt: 1, updatedAt: 1,
      projectId: 'project-a', projectName: 'A', projectBound: true, workspace: 'a',
    }
    store.sessions = [bound]
    store.activeSessionId = bound.id
    store.activeSession = bound

    const nextId = store.setSessionProject(bound.id, { id: 'project-b', name: 'B', primary_folder: 'b' })
    const next = store.sessions.find(session => session.id === nextId)
    expect(nextId).not.toBe(bound.id)
    expect(next).toMatchObject({ projectId: 'project-b', projectName: 'B', workspace: null })
    expect(bound).toMatchObject({ projectId: 'project-a', projectBound: true, workspace: 'a' })
  })

  it('keeps Project metadata current during session list refresh', async () => {
    const store = useChatStore()
    const existing: Session = { id: 'session-a', title: 'Task', messages: [], createdAt: 1, updatedAt: 1 }
    store.sessions = [existing]
    store.activeSessionId = existing.id
    store.activeSession = existing
    vi.mocked(fetchSessions).mockImplementation(async source => source === 'global_agent' ? [] : [{
      id: 'session-a', source: 'cli', model: 'test', title: 'Task', started_at: 1, ended_at: null,
      message_count: 2, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0,
      actual_cost_usd: null, cost_status: 'ok', workspace: 'reports/alpha', project_id: 'project-a',
      project_name: 'Alpha', project_bound: true,
    }])

    await store.refreshSessionListOnly('default')

    expect(existing).toMatchObject({ projectId: 'project-a', projectName: 'Alpha', projectBound: true })
  })
})
