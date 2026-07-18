import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const workspaceDiffMocks = vi.hoisted(() => ({
  start: vi.fn(),
  discard: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/run-chat/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: workspaceDiffMocks.start,
  discardWorkspaceRunCheckpoint: workspaceDiffMocks.discard,
  completeWorkspaceRunCheckpoint: workspaceDiffMocks.complete,
}))

import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  providerEndpointUrl,
  responsesUrl,
} from '../../packages/server/src/services/agent-runner/endpoint-resolver'
import { parseSseFrame, readSseFrames, readSseFrameTexts, sseEvent } from '../../packages/server/src/services/agent-runner/sse'
import { AgentTargetRegistry, type AgentTargetInput } from '../../packages/server/src/services/agent-runner/target-registry'
import { teeAsyncIterable } from '../../packages/server/src/services/agent-runner/stream-tee'
import { CodingAgentRunManager, sanitizeCodingAgentTerminalOutput } from '../../packages/server/src/services/agent-runner/coding-agent-run-manager'
import { mapCodingAgentResponseEvent } from '../../packages/server/src/services/agent-runner/coding-agent-event-mapper'
import { applyResponseStreamEvent } from '../../packages/server/src/services/hermes/run-chat/response-stream'
import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import {
  addMessage,
  createSession,
  deleteSession,
  getSession,
  getSessionDetail,
  getSessionIncarnation,
  getSessionRowId,
  listSessions,
} from '../../packages/server/src/db/hermes/session-store'

beforeEach(() => {
  workspaceDiffMocks.start.mockReset()
  workspaceDiffMocks.discard.mockReset()
  workspaceDiffMocks.complete.mockReset()
  workspaceDiffMocks.complete.mockReturnValue(null)
})

describe('agent runner endpoint resolver', () => {
  it('adds v1 for provider hosts without an API root path', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(responsesUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/responses')
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('does not duplicate existing OpenAI-compatible API roots', () => {
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(chatCompletionsUrl('https://api.z.ai/api/paas/v4')).toBe('https://api.z.ai/api/paas/v4/chat/completions')
    expect(responsesUrl('https://api.apikey.fun/v1/')).toBe('https://api.apikey.fun/v1/responses')
  })

  it('does not duplicate existing endpoint paths', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(responsesUrl('https://api.example.com/v1/responses')).toBe('https://api.example.com/v1/responses')
    expect(anthropicMessagesUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/messages')
  })

  it('handles Anthropic-compatible roots', () => {
    expect(anthropicMessagesUrl('https://api.apikey.fun')).toBe('https://api.apikey.fun/v1/messages')
    expect(anthropicMessagesUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(providerEndpointUrl('anthropic_messages', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/messages')
  })
})

describe('agent runner SSE utilities', () => {
  it('parses event and multi-line data fields', () => {
    expect(parseSseFrame('event: response.output_text.delta\ndata: {"delta":"a"}\ndata: {"delta":"b"}')).toEqual({
      event: 'response.output_text.delta',
      data: '{"delta":"a"}\n{"delta":"b"}',
    })
  })

  it('splits LF and CRLF SSE frame boundaries', () => {
    expect(readSseFrameTexts('data: one\n\ndata: two\r\n\r\ndata: three')).toEqual({
      frames: ['data: one', 'data: two'],
      rest: 'data: three',
    })
  })

  it('reads chunked SSE streams with CRLF boundaries', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: first\r\ndata: {"a":'))
        controller.enqueue(encoder.encode('1}\r\n\r\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })

    const frames = []
    for await (const frame of readSseFrames(stream)) frames.push(frame)

    expect(frames).toEqual([
      { event: 'first', data: '{"a":1}' },
      { data: '{"b":2}' },
    ])
  })

  it('serializes named SSE events', () => {
    expect(sseEvent('response.completed', { ok: true })).toBe('event: response.completed\ndata: {"ok":true}\n\n')
  })
})

describe('agent runner target registry', () => {
  it('reuses route credentials for the same normalized target', () => {
    const registry = new AgentTargetRegistry<AgentTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl],
    )

    const first = registry.register({
      provider: ' deepseek ',
      model: ' deepseek-chat ',
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-first',
    })
    const second = registry.register({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-second',
    })

    expect(second.routeKey).toBe(first.routeKey)
    expect(second.token).toBe(first.token)
    expect(second.apiKey).toBe('sk-second')
    expect(registry.find(first.routeKey)?.apiKey).toBe('sk-second')
  })

  it('separates route credentials by API mode and upstream URL', () => {
    const registry = new AgentTargetRegistry<AgentTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl],
    )

    const chat = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-chat',
      apiMode: 'chat_completions',
    })
    const responses = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-responses',
      apiMode: 'codex_responses',
    })
    const secondUrl = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-two.example.com/v1',
      apiKey: 'sk-second-url',
      apiMode: 'chat_completions',
    })

    expect(chat.routeKey).not.toBe(responses.routeKey)
    expect(chat.token).not.toBe(responses.token)
    expect(chat.routeKey).not.toBe(secondUrl.routeKey)
    expect(chat.token).not.toBe(secondUrl.token)
  })
})

describe('agent runner stream tee', () => {
  it('allows two consumers to receive the same chunks', async () => {
    async function* source() {
      yield 'a'
      yield 'b'
    }
    const [left, right] = teeAsyncIterable(source())
    const collect = async (iterable: AsyncIterable<string>) => {
      const values: string[] = []
      for await (const value of iterable) values.push(value)
      return values
    }

    await expect(Promise.all([collect(left), collect(right)])).resolves.toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ])
  })
})

describe('coding agent terminal output sanitizer', () => {
  it('strips terminal control codes and redacts provider credentials', () => {
    const output = sanitizeCodingAgentTerminalOutput(
      '\u001b[31mError\u001b[0m\r\nAuthorization: Bearer sk-test-secret-token\napi_key = sk-proj-secret-token',
    )

    expect(output).toContain('Error\nAuthorization: Bearer [redacted]')
    expect(output).toContain('api_key = [redacted-api-key]')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('sk-test-secret-token')
    expect(output).not.toContain('sk-proj-secret-token')
  })
})

describe('coding agent run state', () => {
  it('persists the client message id for coding-agent user turns', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const run: any = {
      id: `agent-client-id-${Date.now()}`,
      runMarker: 'coding-run-marker',
      launch: {
        agentSessionId: 'agent-client-id',
        agentId: 'codex',
        mode: 'scoped',
        profile: 'default',
        sessionId: `chat-client-id-${Date.now()}`,
        workspaceDir: process.cwd(),
      },
      state,
    }

    ;(manager as any).ensureDbSession(run)
    ;(manager as any).addUserMessage(run, 'hello', 'client-prompt-1')

    expect(state.messages[0]).toEqual(expect.objectContaining({ id: 'client-prompt-1' }))
    expect(getSessionDetail(run.launch.sessionId)?.messages[0]).toEqual(expect.objectContaining({
      client_id: 'client-prompt-1',
    }))
    manager.shutdown()
  })

  it('marks existing scoped Codex runners incompatible when Hermes MCP config is missing', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'hwui-codex-mcp-compat-'))
    try {
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-test"\n')
      const manager = new CodingAgentRunManager()
      ;(manager as any).ensureDbSession = () => {}
      ;(manager as any).emitToChat = () => {}

      manager.start({
        agentSessionId: 'agent-session-1',
        agentId: 'codex',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'gpt-test',
        sessionId: 'chat-session-1',
        command: 'codex',
        args: [],
        shellCommand: 'codex',
        workspaceDir: process.cwd(),
        env: { CODEX_HOME: codexHome },
        state: { messages: [], isWorking: false, events: [], queue: [] },
      })

      expect(manager.isSessionLaunchCompatible('chat-session-1', {
        agentId: 'codex',
        mode: 'scoped',
        provider: 'test-provider',
        model: 'gpt-test',
      })).toBe(false)

      writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.hermes-studio]\ncommand = "node"\n')
      expect(manager.isSessionLaunchCompatible('chat-session-1', {
        agentId: 'codex',
        mode: 'scoped',
        provider: 'test-provider',
        model: 'gpt-test',
      })).toBe(true)

      manager.shutdown()
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it('updates the shared chat session state during streaming', () => {
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.created',
      data: { response: { id: 'resp-1', status: 'in_progress' } },
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.output_text.delta',
      data: { delta: 'hello' },
    })

    expect(state).toEqual(expect.objectContaining({
      isWorking: true,
      source: 'coding_agent',
      profile: 'default',
      runId: 'agent-session-1',
    }))
    expect(state.messages).toEqual([
      expect.objectContaining({
        session_id: 'chat-session-1',
        role: 'assistant',
        content: 'hello',
      }),
    ])
    expect(emitted.map(event => event.event)).toContain('message.delta')
    manager.shutdown()
  })

  it('clears shared chat session run state when a print turn completes', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.created',
      data: { response: { id: 'resp-1', status: 'in_progress' } },
    })
    state.events.push({ event: 'tool.started', data: { event: 'tool.started' } })

    manager.handleResponseEvent('agent-session-1', {
      type: 'response.completed',
      data: {
        response: {
          id: 'resp-1',
          status: 'completed',
          output: [],
        },
      },
    })

    await vi.waitFor(() => {
      expect(state).toEqual(expect.objectContaining({
        isWorking: false,
        runId: undefined,
        activeRunMarker: undefined,
        events: [],
      }))
    })
    manager.shutdown()
  })

  it('leaves coding agent session titles empty for the existing fallback title logic', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-empty-title-${suffix}`
    const chatSessionId = `chat-session-empty-title-${suffix}`
    const run: any = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'claude-code',
        profile: 'default',
        provider: 'test-provider',
        model: 'glm-5-turbo',
        sessionId: chatSessionId,
        command: 'claude',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    ;(manager as any).ensureDbSession(run)

    expect(getSession(chatSessionId)?.title).toBeNull()
    manager.shutdown()
  })

  it('uses the first coding agent user message as the listed session title when title and preview are empty', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-title-fallback-${suffix}`
    const chatSessionId = `chat-session-title-fallback-${suffix}`
    const run: any = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'codex',
        mode: 'global',
        profile: 'default',
        provider: 'global',
        model: '',
        sessionId: chatSessionId,
        command: 'codex',
        args: [],
        shellCommand: 'codex',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    ;(manager as any).ensureDbSession(run)
    addMessage({
      session_id: chatSessionId,
      role: 'user',
      content: 'Explain why global Codex should not show GLM',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const session = listSessions('default', 'coding_agent').find(item => item.id === chatSessionId)
    expect(session?.preview).toBe('Explain why global Codex should not show GLM')
    expect(session?.title).toBe('Explain why global Codex should not show...')
    manager.shutdown()
  })

  it('starts Codex chat runner without a hidden PTY process', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const result = manager.start({
      agentSessionId: `agent-session-codex-${suffix}`,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: `chat-session-codex-${suffix}`,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    expect(result.pid).toBe(0)
    expect(getSession(`chat-session-codex-${suffix}`)).toEqual(expect.objectContaining({
      source: 'coding_agent',
      agent: 'codex',
      model: 'gpt-5-codex',
    }))
    manager.shutdown()
  })

  it('maps Codex exec JSONL assistant deltas into chat messages', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-jsonl-${suffix}`
    const chatSessionId = `chat-session-codex-jsonl-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_1'
    run.printMessageId = 'msg_resp_codex_1'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_1', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'I am GPT-5-Codex' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages).toContainEqual(expect.objectContaining({
      session_id: chatSessionId,
      role: 'assistant',
      content: 'I am GPT-5-Codex',
      finish_reason: 'stop',
    }))
    await vi.waitFor(() => expect(state.isWorking).toBe(false))
    expect(emitted.map(event => event.event)).toContain('message.delta')
    expect(emitted.map(event => event.event)).not.toContain('usage.updated')
    expect(emitted.find(event => event.event === 'run.completed')?.payload).not.toHaveProperty('usage')
    manager.shutdown()
  })

  it('does not duplicate replayed Codex assistant message text', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-dedupe-${suffix}`
    const chatSessionId = `chat-session-codex-dedupe-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_dedupe'
    run.printMessageId = 'msg_resp_codex_dedupe'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_dedupe', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const text = '好的，你想查看 🐸 Meme币排行！让我先读取 Meme Rank API 的详细说明。'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      msg: { content: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'assistant_message', text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages).toContainEqual(expect.objectContaining({
      session_id: chatSessionId,
      role: 'assistant',
      content: text,
      finish_reason: 'stop',
    }))
    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(text)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([text])
    manager.shutdown()
  })

  it('deduplicates repeated full Codex streaming deltas', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-full-delta-dedupe-${suffix}`
    const chatSessionId = `chat-session-codex-full-delta-dedupe-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_full_delta_dedupe'
    run.printMessageId = 'msg_resp_codex_full_delta_dedupe'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_full_delta_dedupe', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const text = 'It seems like you are sending numbers without additional context. I am not sure what you are looking for.\n\nCould you describe what you need in a sentence or two?'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(text)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([text])
    manager.shutdown()
  })

  it('keeps repeated short Codex markdown chunks while deduplicating final replay', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-markdown-${suffix}`
    const chatSessionId = `chat-session-codex-markdown-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_markdown'
    run.printMessageId = 'msg_resp_codex_markdown'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_markdown', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    for (const delta of ['```', 'ts', '\n', 'const value = 1', '\n', '```']) {
      ;(manager as any).handleCodexExecLine(run, JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { delta },
      }))
    }
    const text = ['```ts', 'const value = 1', '```'].join('\n')
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'assistant_message', text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(text)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([
      '```',
      'ts',
      '\n',
      'const value = 1',
      '\n',
      '```',
    ])
    manager.shutdown()
  })

  it('normalizes Codex full-text snapshot deltas before emitting chat deltas', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-snapshot-${suffix}`
    const chatSessionId = `chat-session-codex-snapshot-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_snapshot'
    run.printMessageId = 'msg_resp_codex_snapshot'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_snapshot', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const first = 'Hello! How can I help you today?'
    const snapshot = 'Hello! How can I help you today? Please describe what you need.'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: first },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: snapshot },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(snapshot)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([
      first,
      ' Please describe what you need.',
    ])
    manager.shutdown()
  })

  it('stores Codex reasoning items in the response run state', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-reasoning-${suffix}`
    const chatSessionId = `chat-session-codex-reasoning-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_reasoning'
    run.printMessageId = 'msg_resp_codex_reasoning'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_reasoning', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', summary: [{ text: 'Need inspect. ' }, { text: 'Then answer.' }] },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: ' From response item.' }] },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/reasoning/delta',
      params: { delta: ' Extra.' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'Done.' },
    }))

    expect(emitted.filter(event => event.event === 'reasoning.delta').map(event => event.payload.delta)).toEqual([
      'Need inspect. Then answer.',
      ' From response item.',
      ' Extra.',
    ])
    expect(state.messages.find((message: any) => message.role === 'assistant')).toMatchObject({
      content: 'Done.',
      reasoning: 'Need inspect. Then answer. From response item. Extra.',
      reasoning_content: 'Need inspect. Then answer. From response item. Extra.',
    })
    manager.shutdown()
  })

  it('does not append unrelated Codex final text without a tool boundary', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-no-tool-final-${suffix}`
    const chatSessionId = `chat-session-codex-no-tool-final-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_no_tool_final'
    run.printMessageId = 'msg_resp_codex_no_tool_final'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_no_tool_final', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Initial assistant text.' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Different final text without tools.' },
    }))
    ;(manager as any).completeCodexExecTurn(run)

    const textMessages = state.messages.filter((message: any) => message.role === 'assistant' && !message.tool_calls?.length)
    expect(textMessages.map((message: any) => message.content)).toEqual(['Initial assistant text.'])
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual(['Initial assistant text.'])
    manager.shutdown()
  })

  it('keeps repeated short Codex streaming deltas', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-short-deltas-${suffix}`
    const chatSessionId = `chat-session-codex-short-deltas-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_short_deltas'
    run.printMessageId = 'msg_resp_codex_short_deltas'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_short_deltas', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: '\n' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: '\n' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe('\n\n')
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual(['\n', '\n'])
    manager.shutdown()
  })

  it('waits for Codex process exit before flushing final text after tools', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-tool-final-${suffix}`
    const chatSessionId = `chat-session-codex-tool-final-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_tool_final'
    run.printMessageId = 'msg_resp_codex_tool_final'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_tool_final', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const openingText = '我会先查看你的桌面目录。'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: openingText },
    }))
    expect(state.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: openingText,
    }))

    manager.handleResponseEvent(agentSessionId, {
      type: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          id: 'call-proxy',
          call_id: 'call-proxy',
          name: 'exec_command',
          arguments: '{"cmd":"ls ~/Desktop"}',
        },
      },
    })
    manager.handleResponseEvent(agentSessionId, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call',
          id: 'call-proxy',
          call_id: 'call-proxy',
          name: 'exec_command',
          arguments: '{"cmd":"ls ~/Desktop"}',
        },
      },
    })
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        name: 'exec_command',
        arguments: { cmd: 'ls ~/Desktop' },
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        name: 'exec_command',
        arguments: { cmd: 'ls ~/Desktop' },
        output: 'ai素材\ncache\ngit',
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd-1', command: 'ls ~/Desktop' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'cmd-1',
        command: 'ls ~/Desktop',
        aggregated_output: 'ai素材\ncache\ngit',
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    run.currentChild = { exitCode: null, signalCode: null, killed: false } as any
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: {
        response: {
          id: 'resp_codex_tool_final',
          status: 'completed',
          model: 'gpt-5-codex',
          output: [],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    })

    expect(emitted.map(event => event.event)).not.toContain('run.completed')
    expect(state.isWorking).toBe(true)
    expect(getSessionDetail(chatSessionId)?.messages || []).not.toContainEqual(expect.objectContaining({
      role: 'assistant',
      tool_calls: expect.any(Array),
    }))

    const finalText = '你的桌面上有以下 3 个目录：ai素材、cache、git。'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: finalText },
    }))
    run.currentChild = undefined
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    const textMessages = state.messages.filter((message: any) => message.role === 'assistant' && !message.tool_calls?.length)
    expect(textMessages.map((message: any) => message.content)).toEqual([openingText, finalText])
    expect(textMessages.at(-1)).toEqual(expect.objectContaining({ finish_reason: 'stop' }))
    const dbMessages = getSessionDetail(chatSessionId)?.messages || []
    expect(dbMessages.filter(message => message.role === 'assistant' && message.tool_calls?.length)).toHaveLength(1)
    expect(dbMessages).toContainEqual(expect.objectContaining({
      role: 'tool',
      content: 'ai素材\ncache\ngit',
      tool_call_id: 'cmd-1',
    }))
    expect(dbMessages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: finalText,
    }))
    await vi.waitFor(() => expect(emitted.map(event => event.event)).toContain('run.completed'))
    manager.shutdown()
  })

  it('truncates large coding-agent tool outputs before emitting and flushing to SQLite', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-large-tool-${suffix}`
    const chatSessionId = `chat-session-codex-large-tool-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    const largeOutput = `HEAD-${'a'.repeat(80 * 1024)}-TAIL`

    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_large_tool', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          id: 'call_large',
          call_id: 'call_large',
          name: 'read_file',
          arguments: '{"path":"big.log"}',
        },
      },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call',
          id: 'call_large',
          call_id: 'call_large',
          name: 'read_file',
          arguments: '{"path":"big.log"}',
        },
      },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call_output',
          id: 'call_large',
          call_id: 'call_large',
          output: largeOutput,
        },
      },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: { response: { id: 'resp_large_tool', status: 'completed', model: 'gpt-5-codex', output: [] } },
    })

    const toolMessage = state.messages.find((message: any) => message.role === 'tool')
    const completedPayload = emitted.find(event => event.event === 'tool.completed')?.payload as any
    const dbToolMessage = (getSessionDetail(chatSessionId)?.messages || []).find(message => message.role === 'tool')
    for (const output of [toolMessage?.content, completedPayload?.output, dbToolMessage?.content]) {
      expect(output).toContain('HEAD-')
      expect(output).toContain('-TAIL')
      expect(output).toContain('coding-agent tool output truncated for storage')
      expect(output.length).toBeLessThan(largeOutput.length)
      expect(output.length).toBeLessThan(34 * 1024)
    }
    manager.shutdown()
  })

  it('records Codex thread id so follow-up turns can resume the native session', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-thread-${suffix}`
    const chatSessionId = `chat-session-codex-thread-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    const run = (manager as any).runs.get(agentSessionId)

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'thread.started',
      thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    }))

    expect(getSession(chatSessionId)?.agent_native_session_id).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53')
    manager.shutdown()
  })

  it('does not report a completed idle coding-agent session cleanup as a run failure', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-idle-cleanup-${suffix}`
    const chatSessionId = `chat-session-idle-cleanup-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.state.isWorking = false
    run.currentChild = undefined

    ;(manager as any).cleanupRun(run, { kill: true })

    expect(emitted).toEqual([])
  })

  it('does not emit run.failed when a print coding-agent session is stopped by abort', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-user-stop-${suffix}`
    const chatSessionId = `chat-session-user-stop-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: true, events: [], queue: [] },
    })

    expect(manager.stop(chatSessionId, { reportClosed: false })).toBe(true)

    expect(emitted).toEqual([])
  })

  it('starts a workspace diff checkpoint when sending a coding-agent turn with a workspace', async () => {
    const manager = new CodingAgentRunManager()
    const agentSessionId = `agent-session-diff-start-${Date.now()}`
    const chatSessionId = `chat-session-diff-start-${Date.now()}`
    const workspaceDir = process.cwd()
    const run = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'terminal-agent',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'test-model',
        sessionId: chatSessionId,
        command: 'agent',
        args: [],
        shellCommand: 'agent',
        workspaceDir,
        workspaceExplicit: true,
      },
      pty: { write: vi.fn() },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }
    ;(manager as any).runs.set(agentSessionId, run)
    ;(manager as any).sessionIndex.set(chatSessionId, agentSessionId)
    ;(manager as any).ensureDbSession(run)
    ;(manager as any).bindSessionIdentity(run)
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).touch = () => {}
    ;(manager as any).emitTerminalStatus = () => {}

    await manager.send(chatSessionId, 'please change files')

    expect(workspaceDiffMocks.start).toHaveBeenCalledWith({
      sessionId: chatSessionId,
      runId: agentSessionId,
      workspace: workspaceDir,
    })
    expect(run.pty.write).toHaveBeenCalledWith('please change files\r')
  })

  it('does not launch a coding-agent turn after deletion during checkpoint startup', async () => {
    const manager = new CodingAgentRunManager()
    const agentSessionId = `agent-session-diff-delete-${Date.now()}`
    const chatSessionId = `chat-session-diff-delete-${Date.now()}`
    const workspaceDir = process.cwd()
    const run = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'terminal-agent',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'test-model',
        sessionId: chatSessionId,
        command: 'agent',
        args: [],
        shellCommand: 'agent',
        workspaceDir,
        workspaceExplicit: true,
      },
      pty: { write: vi.fn() },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }
    ;(manager as any).runs.set(agentSessionId, run)
    ;(manager as any).sessionIndex.set(chatSessionId, agentSessionId)
    ;(manager as any).ensureDbSession(run)
    ;(manager as any).bindSessionIdentity(run)
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).touch = () => {}
    ;(manager as any).emitTerminalStatus = () => {}
    let resolveCheckpoint!: (value: { key: string }) => void
    workspaceDiffMocks.start.mockReturnValue(new Promise(resolve => {
      resolveCheckpoint = resolve
    }))

    const pending = manager.send(chatSessionId, 'please change files')
    await vi.waitFor(() => expect(workspaceDiffMocks.start).toHaveBeenCalled())
    expect(manager.stop(chatSessionId, { reportClosed: false })).toBe(true)
    resolveCheckpoint({ key: 'deleted-session-checkpoint' })

    await expect(pending).rejects.toThrow('Coding agent session no longer exists')
    expect(workspaceDiffMocks.discard).toHaveBeenCalledWith({
      sessionId: chatSessionId,
      runId: agentSessionId,
    })
    expect(run.pty.write).not.toHaveBeenCalled()
  })

  it('does not start a workspace diff checkpoint when the workspace was defaulted', async () => {
    const manager = new CodingAgentRunManager()
    const agentSessionId = `agent-session-diff-default-${Date.now()}`
    const chatSessionId = `chat-session-diff-default-${Date.now()}`
    const run = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'terminal-agent',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'test-model',
        sessionId: chatSessionId,
        command: 'agent',
        args: [],
        shellCommand: 'agent',
        workspaceDir: process.cwd(),
      },
      pty: { write: vi.fn() },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }
    ;(manager as any).runs.set(agentSessionId, run)
    ;(manager as any).sessionIndex.set(chatSessionId, agentSessionId)
    ;(manager as any).ensureDbSession(run)
    ;(manager as any).bindSessionIdentity(run)
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).touch = () => {}
    ;(manager as any).emitTerminalStatus = () => {}

    await manager.send(chatSessionId, 'please change files')

    expect(workspaceDiffMocks.start).not.toHaveBeenCalled()
    expect(run.pty.write).toHaveBeenCalledWith('please change files\r')
  })

  it('emits workspace diff summary before coding-agent run completion', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    workspaceDiffMocks.complete.mockReturnValue({
      change_id: 'change-coding',
      session_id: 'chat-session-diff-complete',
      run_id: 'agent-session-diff-complete',
      source: 'run',
      workspace: 'workspace',
      workspace_kind: 'git',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 10,
      created_at: 2,
      files: [{
        id: 1,
        change_id: 'change-coding',
        session_id: 'chat-session-diff-complete',
        path: 'file.txt',
        old_path: null,
        change_type: 'modified',
        additions: 1,
        deletions: 0,
        size_before: 1,
        size_after: 2,
        patch_bytes: 10,
        truncated: false,
        binary: false,
        created_at: 2,
      }],
    })
    const run = {
      id: 'agent-session-diff-complete',
      launch: {
        sessionId: 'chat-session-diff-complete',
        workspaceDir: process.cwd(),
        workspaceExplicit: true,
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
    }

    await (manager as any).emitAndMarkPrintChatRunCompleted(run, 'run.completed', {
      event: 'run.completed',
      run_id: 'resp-1',
    })

    expect(workspaceDiffMocks.complete).toHaveBeenCalledWith({
      sessionId: 'chat-session-diff-complete',
      runId: 'agent-session-diff-complete',
      workspace: process.cwd(),
    })
    expect(emitted[0]).toEqual({
      event: 'workspace.diff.completed',
      payload: expect.objectContaining({
        event: 'workspace.diff.completed',
        change_id: 'change-coding',
        files_changed: 1,
      }),
    })
    expect(emitted[1]).toEqual(expect.objectContaining({ event: 'run.completed' }))
  })

  it('ignores a killed coding-agent callback after its SQLite session is deleted and recreated', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const roomEmit = vi.fn()
    const namespace = {
      adapter: { rooms: new Map() },
      sockets: new Map(),
      to: vi.fn(() => ({ emit: roomEmit })),
    }
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { setChatRunServer } = await import('../../packages/server/src/routes/hermes/chat-run')
    const chatRunServer = new ChatRunSocket({ of: vi.fn(() => namespace) } as any)
    setChatRunServer(chatRunServer)
    let resolveStaleCallback!: () => void
    const staleCallbackSettled = new Promise<void>(resolve => {
      resolveStaleCallback = resolve
    })
    ;(manager as any).emitToChat = (sessionId: string, event: string, payload: any, identity: any) => {
      ;(chatRunServer as any).emitExternalEvent(sessionId, event, payload, identity)
    }
    ;(manager as any).markChatRunCompleted = (sessionId: string, event: string, identity: any) => {
      const marked = (chatRunServer as any).markExternalRunCompleted(sessionId, event, identity)
      resolveStaleCallback()
      return marked
    }

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-stale-callback-${suffix}`
    const chatSessionId = `chat-session-stale-callback-${suffix}`
    const oldState = { messages: [], isWorking: false, events: [], queue: [] }
    manager.start({
      agentSessionId,
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      workspaceExplicit: true,
      state: oldState,
    })
    const oldGeneration = {
      rowId: getSessionRowId(chatSessionId),
      incarnation: getSessionIncarnation(chatSessionId),
    }

    let resolveDiff!: (change: any) => void
    workspaceDiffMocks.complete.mockReturnValue(new Promise(resolve => {
      resolveDiff = resolve
    }))
    expect(manager.stop(chatSessionId)).toBe(true)
    await vi.waitFor(() => expect(workspaceDiffMocks.complete).toHaveBeenCalled())

    expect(deleteSession(chatSessionId)).toBe(true)
    createSession({
      id: chatSessionId,
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      agent_session_id: 'replacement-agent-run',
      model: 'gpt-5-codex',
      provider: 'test-provider',
      workspace: process.cwd(),
    })
    const replacementState = {
      messages: [],
      isWorking: true,
      events: [{ event: 'replacement.started', data: { event: 'replacement.started' } }],
      queue: [],
      runId: 'replacement-agent-run',
      activeRunMarker: 'replacement-marker',
      sessionRowId: getSessionRowId(chatSessionId),
      sessionIncarnation: getSessionIncarnation(chatSessionId),
      profile: 'default',
    }
    expect({
      rowId: replacementState.sessionRowId,
      incarnation: replacementState.sessionIncarnation,
    }).not.toEqual(oldGeneration)
    ;(chatRunServer as any).sessionMap.set(chatSessionId, replacementState)

    resolveDiff({
      change_id: 'stale-coding-agent-change',
      session_id: chatSessionId,
      run_id: agentSessionId,
      source: 'run',
      workspace: process.cwd(),
      workspace_kind: 'filesystem',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 10,
      created_at: 2,
      files: [],
    })

    await staleCallbackSettled
    expect(roomEmit).not.toHaveBeenCalled()
    expect((chatRunServer as any).sessionMap.get(chatSessionId)).toBe(replacementState)
    expect(replacementState).toEqual(expect.objectContaining({
      isWorking: true,
      runId: 'replacement-agent-run',
      activeRunMarker: 'replacement-marker',
      profile: 'default',
    }))
    expect(replacementState.events).toEqual([
      { event: 'replacement.started', data: { event: 'replacement.started' } },
    ])
  })

  it('does not let a delayed completion from one turn clear the next turn in the same coding-agent run', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const roomEmit = vi.fn()
    const namespace = {
      adapter: { rooms: new Map() },
      sockets: new Map(),
      to: vi.fn(() => ({ emit: roomEmit })),
    }
    const { ChatRunSocket } = await import('../../packages/server/src/services/hermes/run-chat')
    const { setChatRunServer } = await import('../../packages/server/src/routes/hermes/chat-run')
    const chatRunServer = new ChatRunSocket({ of: vi.fn(() => namespace) } as any)
    setChatRunServer(chatRunServer)

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-turn-fence-${suffix}`
    const chatSessionId = `chat-session-turn-fence-${suffix}`
    const state = { messages: [], isWorking: false, events: [], queue: [] } as any
    manager.start({
      agentSessionId,
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      workspaceExplicit: true,
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    ;(chatRunServer as any).sessionMap.set(chatSessionId, state)

    let resolveDiff!: (change: any) => void
    workspaceDiffMocks.complete.mockReturnValue(new Promise(resolve => {
      resolveDiff = resolve
    }))

    run.runMarker = 'turn-1'
    state.isWorking = true
    state.runId = agentSessionId
    state.activeRunMarker = 'turn-1'
    const firstCompletion = (manager as any).emitAndMarkPrintChatRunCompleted(run, 'run.completed', {
      event: 'run.completed',
      run_id: 'response-turn-1',
    })
    await vi.waitFor(() => expect(workspaceDiffMocks.complete).toHaveBeenCalled())

    run.runMarker = 'turn-2'
    state.isWorking = true
    state.runId = agentSessionId
    state.activeRunMarker = 'turn-2'
    state.events = [{ event: 'turn-2.started', data: { event: 'turn-2.started' } }]
    roomEmit.mockClear()
    resolveDiff({
      change_id: 'change-turn-1',
      session_id: chatSessionId,
      run_id: agentSessionId,
      source: 'run',
      workspace: process.cwd(),
      workspace_kind: 'filesystem',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 10,
      created_at: 2,
      files: [],
    })

    try {
      await firstCompletion
      expect(roomEmit).not.toHaveBeenCalled()
      expect(state).toEqual(expect.objectContaining({
        isWorking: true,
        runId: agentSessionId,
        activeRunMarker: 'turn-2',
      }))
      expect(state.events).toEqual([
        { event: 'turn-2.started', data: { event: 'turn-2.started' } },
      ])
      expect(run.runMarker).toBe('turn-2')
    } finally {
      manager.stop(chatSessionId, { reportClosed: false })
      setChatRunServer(undefined as any)
    }
  })

  it('does not complete or emit a workspace diff when the coding-agent workspace was defaulted', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    workspaceDiffMocks.complete.mockReturnValue({
      change_id: 'change-default',
      session_id: 'chat-session-diff-default',
      run_id: 'agent-session-diff-default',
      source: 'run',
      workspace: 'workspace',
      workspace_kind: 'filesystem',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 10,
      created_at: 2,
      files: [],
    })
    const run = {
      id: 'agent-session-diff-default',
      launch: {
        sessionId: 'chat-session-diff-default',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
    }

    await (manager as any).emitAndMarkPrintChatRunCompleted(run, 'run.completed', {
      event: 'run.completed',
      run_id: 'resp-1',
    })

    expect(workspaceDiffMocks.complete).not.toHaveBeenCalled()
    expect(emitted.map(event => event.event)).toEqual(['run.completed', 'run.completed'])
  })

  it('cleans up coding-agent workspace diff checkpoints on user abort without run.failed', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    workspaceDiffMocks.complete.mockReturnValue({
      change_id: 'change-abort',
      session_id: 'chat-session-diff-abort',
      run_id: 'agent-session-diff-abort',
      source: 'run',
      workspace: 'workspace',
      workspace_kind: 'filesystem',
      started_at: 1,
      finished_at: 2,
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      total_patch_bytes: 10,
      created_at: 2,
      files: [],
    })
    const run = {
      id: 'agent-session-diff-abort',
      launch: {
        sessionId: 'chat-session-diff-abort',
        workspaceDir: process.cwd(),
        workspaceExplicit: true,
      },
      state: { messages: [], isWorking: true, events: [], queue: [] },
      currentChild: undefined,
      exited: false,
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)

    ;(manager as any).cleanupRun(run, { kill: true, reportClosed: false })

    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(emitted.map(event => event.event)).toEqual(['workspace.diff.completed'])
    expect(emitted[0].payload).toEqual(expect.objectContaining({
      event: 'workspace.diff.completed',
      change_id: 'change-abort',
    }))
  })

  it('defers queued-run release until a print coding-agent child exits', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [{ queue_id: 'queued-1', input: 'next' }] }
    const completed = vi.fn()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = completed
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-defer-complete-${suffix}`
    const chatSessionId = `chat-session-defer-complete-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.currentChild = { exitCode: null, signalCode: null, killed: false }

    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: { response: { id: 'resp-defer', status: 'completed', output: [] } },
    })

    expect(completed).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(true)
    expect(run.pendingChatCompletionEvent).toBe('run.completed')
    expect(run.pendingChatCompletionPayload).toEqual(expect.objectContaining({
      event: 'run.completed',
      response_id: 'resp-defer',
    }))

    run.currentChild = undefined
    await (manager as any).emitAndMarkPrintChatRunCompleted(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)

    expect(completed).toHaveBeenCalledWith(chatSessionId, 'run.completed', expect.objectContaining({
      state,
      runId: agentSessionId,
      turnMarker: expect.any(String),
      sessionRowId: expect.any(Number),
      sessionIncarnation: expect.any(Number),
    }))
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.completed',
      payload: expect.objectContaining({
        response_id: 'resp-defer',
        queue_remaining: 1,
      }),
    }))
    expect(state.isWorking).toBe(false)
    expect(run.pendingChatCompletionEvent).toBeUndefined()
    expect(run.pendingChatCompletionPayload).toBeUndefined()
  })
})

describe('coding agent chat event mapper', () => {
  it('does not surface raw provider stream events as chat agent events', () => {
    const mapped = mapCodingAgentResponseEvent({
      type: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'hello' },
    })

    expect(mapped).toEqual([])
  })

  it('maps reasoning deltas to chat reasoning deltas', () => {
    expect(mapCodingAgentResponseEvent({
      type: 'response.reasoning.delta',
      data: { type: 'response.reasoning.delta', delta: 'thinking' },
    })).toEqual([{
      event: 'reasoning.delta',
      payload: expect.objectContaining({
        event: 'reasoning.delta',
        delta: 'thinking',
      }),
    }])
  })
})

describe('response stream tool detail events', () => {
  it('emits updated tool.started payloads as function-call arguments stream in', () => {
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    const started = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '' },
    })
    const withCommand = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.function_call_arguments.delta', {
      item_id: 'call-1',
      delta: '{"command":"pwd"',
    })
    const withFinalArgs = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.function_call_arguments.delta', {
      item_id: 'call-1',
      delta: '}',
    })

    expect(started).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'call-1',
        tool: 'Bash',
      }),
    }))
    expect(withCommand).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        arguments: '{"command":"pwd"',
      }),
    }))
    expect(withFinalArgs).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        arguments: '{"command":"pwd"}',
      }),
    }))
  })
})

describe('Claude Code stream-json mapping', () => {
  it('maps top-level tool_result messages to tool.completed', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    const run = {
      id: 'agent-session-1',
      launch: {
        agentSessionId: 'agent-session-1',
        agentId: 'claude-code',
        profile: 'default',
        provider: 'test',
        model: 'claude-test',
        sessionId: 'chat-session-1',
        command: 'claude',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      printResponseId: 'resp_1',
      printMessageId: 'msg_resp_1',
      printToolBlocks: new Map(),
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).ensureDbSession(run)
    ;(manager as any).bindSessionIdentity(run)
    ;(manager as any).ensureDbSession = () => {}

    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
      },
    }))
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/project' }],
      },
    }))

    expect(emitted.map(event => event.event)).toContain('tool.started')
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'tool.completed',
      payload: expect.objectContaining({
        tool_call_id: 'toolu_1',
        output: '/tmp/project',
      }),
    }))
  })
})
