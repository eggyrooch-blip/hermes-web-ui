import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  ensureOpenBridgeAssistantMessage,
  flushBridgePendingToDb,
  recordBridgeToolCompleted,
  recordBridgeToolStarted,
} from '../../packages/server/src/services/hermes/run-chat/bridge-message'

function state() {
  return {
    messages: [],
    isWorking: true,
    events: [],
    queue: [],
    runId: 'run-1',
    bridgePendingAssistantContent: 'Changed app.ts',
  } as any
}

describe('bridge message run identity', () => {
  beforeEach(() => {
    addMessageMock.mockReset()
  })

  it('keeps the active run id on in-memory and persisted assistant text', () => {
    const target = state()
    const message = ensureOpenBridgeAssistantMessage(target, 'session-1', 'marker-1')

    flushBridgePendingToDb(target, 'session-1', 'marker-1')

    expect(message.run_id).toBe('run-1')
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      run_id: 'run-1',
    }))
  })

  it('keeps the active run id on assistant tool-call messages', () => {
    const target = state()
    target.bridgePendingAssistantContent = ''

    recordBridgeToolStarted(target, 'session-1', 'marker-1', 'terminal', { command: 'pwd' }, 'call-1')

    expect(target.messages[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      run_id: 'run-1',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      run_id: 'run-1',
    }))
  })

  it('keeps the active run id on persisted tool results', () => {
    const target = state()
    target.bridgePendingAssistantContent = ''
    recordBridgeToolStarted(target, 'session-1', 'marker-1', 'terminal', { command: 'pwd' }, 'call-1')
    addMessageMock.mockClear()

    recordBridgeToolCompleted(target, 'session-1', 'marker-1', 'terminal', {
      tool_call_id: 'call-1',
      output: '/workspace',
    })

    expect(target.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'tool',
      run_id: 'run-1',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'tool',
      run_id: 'run-1',
    }))
  })
})
