// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/hermes/profiles', () => ({
  fetchProfiles: vi.fn().mockResolvedValue([]),
  fetchProfileDetail: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  switchProfile: vi.fn(),
  switchHermesProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  updateProfileAvatar: vi.fn(),
  deleteProfileAvatar: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/hermes/sessions')>()),
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChanges: vi.fn().mockResolvedValue([]),
  setSessionExpert: vi.fn(),
  setSessionModel: vi.fn(),
}))

import { fetchSessionMessagesPage, fetchSessions, setSessionExpert, setSessionModel } from '@/api/hermes/sessions'
import { useAppStore } from '@/stores/hermes/app'
import { CODEX_MODEL_UNAVAILABLE, isCodexModel, useChatStore } from '@/stores/hermes/chat'

describe('chat store execution engine binding', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(setSessionExpert).mockReset()
    vi.mocked(setSessionExpert).mockResolvedValue(true)
    vi.mocked(setSessionModel).mockReset()
    vi.mocked(setSessionModel).mockResolvedValue({ ok: true, familySwitchNotice: false })
    vi.mocked(fetchSessions).mockReset()
    vi.mocked(fetchSessions).mockResolvedValue([])
    vi.mocked(fetchSessionMessagesPage).mockReset()
  })

  it('binds Codex only to the new expert session and selects an explicit GPT model', () => {
    const app = useAppStore()
    app.selectedModel = 'auto'
    app.selectedProvider = 'custom:litellm-sre'
    app.modelGroups = [{
      provider: 'custom:litellm-sre',
      label: 'LiteLLM',
      base_url: '',
      api_key: '',
      models: ['auto', 'claude-sonnet-5', 'GPT-5.5-priority'],
    }]
    const chat = useChatStore()

    const harness = chat.newChatWithExpert({ id: 'server-dev', name: 'Server Dev' }, 'harness')
    const ordinary = chat.newChatWithExpert({ id: 'other', name: 'Other' })

    expect(harness.executionEngine).toBe('harness')
    expect(harness.model).toBe('GPT-5.5-priority')
    expect(ordinary.executionEngine).toBe('hermes')
    expect(ordinary.model).toBe('auto')

    chat.activeSessionId = harness.id
    chat.workflowStages.set(harness.id, {
      sessionId: harness.id,
      stage: 'pre_deploy',
      status: 'waiting',
      summary: 'Gate E',
      relatedIds: { mr: '123' },
      auditId: 'audit-1',
    })
    expect(chat.activeWorkflowStage?.stage).toBe('pre_deploy')
  })

  it('persists a pre-first-message Codex expert model switch', async () => {
    const app = useAppStore()
    app.selectedModel = 'auto'
    app.selectedProvider = 'custom:litellm-sre'
    app.modelGroups = [{
      provider: 'custom:litellm-sre',
      label: 'LiteLLM',
      base_url: '',
      api_key: '',
      models: ['auto', 'GPT-5.5-priority', 'gpt-5.4'],
    }]
    const chat = useChatStore()
    const session = chat.newChatWithExpert({ id: 'server-dev' }, 'harness')

    await expect(chat.switchSessionModel('gpt-5.4', 'custom:litellm-sre', session.id))
      .resolves.toEqual({ ok: true, familySwitchNotice: false })
    expect(session.model).toBe('gpt-5.4')
    expect(setSessionModel).toHaveBeenCalledWith(session.id, 'gpt-5.4', 'custom:litellm-sre', undefined)
  })

  it('persists an expert before switching a new Hermes session model', async () => {
    let finishExpertSave!: (ok: boolean) => void
    vi.mocked(setSessionExpert).mockReturnValueOnce(new Promise(resolve => { finishExpertSave = resolve }))
    const chat = useChatStore()
    const session = chat.newChatWithExpert({ id: 'server-dev', name: 'Server Dev' })

    const switching = chat.switchSessionModel('gpt-5.4', 'custom:litellm-sre', session.id)
    await Promise.resolve()

    expect(setSessionExpert).toHaveBeenCalledWith(session.id, 'server-dev', 'hermes', 'default')
    expect(setSessionModel).not.toHaveBeenCalled()

    finishExpertSave(true)
    await expect(switching).resolves.toEqual({ ok: true, familySwitchNotice: false })
    expect(setSessionModel).toHaveBeenCalledWith(session.id, 'gpt-5.4', 'custom:litellm-sre', undefined)
  })

  it('waits for expert persistence before applying a session-list refresh', async () => {
    let finishExpertSave!: (ok: boolean) => void
    let serverHasExpert = false
    vi.mocked(setSessionExpert).mockReturnValueOnce(new Promise(resolve => { finishExpertSave = resolve }))
    vi.mocked(fetchSessions).mockImplementation(async source => source === 'global_agent' ? [] : [{
      id: 'expert-draft', profile: 'default', source: 'cli', model: '', title: null,
      started_at: 1, ended_at: null, message_count: 0, tool_call_count: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0,
      actual_cost_usd: null, cost_status: '',
      expert_id: serverHasExpert ? 'expert-a' : null,
      expert_label: serverHasExpert ? 'Expert A' : null,
    }])
    const chat = useChatStore()
    const session = chat.newChat()
    session.id = 'expert-draft'
    chat.activeSessionId = session.id
    chat.activeSession = session

    const selecting = chat.selectActiveExpert('expert-a', { label: 'Expert A' })
    const refreshing = chat.refreshSessionListOnly()
    await Promise.resolve()
    expect(fetchSessions).not.toHaveBeenCalled()

    serverHasExpert = true
    finishExpertSave(true)
    await selecting
    await refreshing

    expect(chat.activeExpertId).toBe('expert-a')
    expect(chat.activeSession?.expertId).toBe('expert-a')
  })

  it('does not let an older in-flight session list clear a newer expert selection', async () => {
    let finishList!: (sessions: any[]) => void
    vi.mocked(fetchSessions).mockImplementation(source => source === 'global_agent'
      ? Promise.resolve([])
      : new Promise(resolve => { finishList = resolve }))
    const chat = useChatStore()
    const session = chat.newChat()
    const refreshing = chat.refreshSessionListOnly()
    await vi.waitFor(() => expect(fetchSessions).toHaveBeenCalled())

    await chat.selectActiveExpert('expert-a', { label: 'Expert A' })
    finishList([{
      id: session.id, profile: 'default', source: 'cli', model: '', title: null,
      started_at: 1, ended_at: null, message_count: 0, tool_call_count: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0,
      actual_cost_usd: null, cost_status: '', expert_id: null, expert_label: null,
    }])
    await refreshing

    expect(chat.activeExpertId).toBe('expert-a')
    expect(chat.activeSession?.expertId).toBe('expert-a')
  })

  it('restores the selected expert from session detail hydration', async () => {
    const chat = useChatStore()
    const session = chat.newChat()
    chat.activeSessionId = session.id
    vi.mocked(fetchSessionMessagesPage).mockResolvedValue({
      session: {
        id: session.id,
        title: 'Expert session',
        expert_id: 'expert-a',
        expert_label: 'Expert A',
        expert_avatar: '/expert-a.png',
      } as any,
      messages: [{
        id: 1,
        session_id: session.id,
        role: 'user',
        content: 'hello',
        timestamp: 1,
      } as any],
      total: 1,
      offset: 0,
      limit: 150,
      hasMore: false,
    })

    await expect(chat.refreshActiveSession()).resolves.toBe(true)
    expect(chat.activeExpertId).toBe('expert-a')
    expect(chat.activeSession).toMatchObject({
      expertId: 'expert-a',
      expertLabel: 'Expert A',
      expertAvatar: '/expert-a.png',
    })
  })

  it('retries a transient expert persistence failure before switching models', async () => {
    vi.mocked(setSessionExpert).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const chat = useChatStore()
    const session = chat.newChatWithExpert({ id: 'server-dev', name: 'Server Dev' })

    await expect(chat.switchSessionModel('gpt-5.4', 'custom:litellm-sre', session.id))
      .resolves.toEqual({ ok: true, familySwitchNotice: false })
    expect(setSessionExpert).toHaveBeenCalledTimes(2)
    expect(setSessionExpert).toHaveBeenLastCalledWith(session.id, 'server-dev', 'hermes', 'default')
    expect(setSessionModel).toHaveBeenCalledWith(session.id, 'gpt-5.4', 'custom:litellm-sre', undefined)
  })

  it('carries the current workspace into either expert engine', () => {
    const app = useAppStore()
    app.selectedModel = 'GPT-5.5-priority'
    app.selectedProvider = 'custom:litellm-sre'
    app.modelGroups = [{
      provider: 'custom:litellm-sre', label: 'LiteLLM', base_url: '', api_key: '',
      models: ['GPT-5.5-priority'],
    }]
    const chat = useChatStore()
    const draft = chat.newChat({ workspace: 'team/project-a' })
    chat.activeSessionId = draft.id

    const harness = chat.newChatWithExpert({ id: 'server-dev' }, 'harness')
    chat.activeSessionId = draft.id
    const hermes = chat.newChatWithExpert({ id: 'server-dev' }, 'hermes')

    expect(harness.workspace).toBe('team/project-a')
    expect(hermes.workspace).toBe('team/project-a')
  })

  it('does not create a Codex session without a compatible model', () => {
    const app = useAppStore()
    app.selectedModel = 'auto'
    app.selectedProvider = 'custom:litellm-sre'
    app.modelGroups = [{
      provider: 'custom:litellm-sre', label: 'LiteLLM', base_url: '', api_key: '',
      models: ['auto', 'claude-sonnet-5', 'anthropic/gpt-4o-mini'],
    }]
    const chat = useChatStore()

    expect(() => chat.newChatWithExpert({ id: 'server-dev' }, 'harness'))
      .toThrow(CODEX_MODEL_UNAVAILABLE)
    expect(chat.sessions).toHaveLength(0)
    expect(isCodexModel('anthropic/gpt-4o-mini')).toBe(false)
  })
})
