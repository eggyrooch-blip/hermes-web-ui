import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbState = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '' }))
const effects = vi.hoisted(() => ({
  calcUsage: vi.fn(),
  flush: vi.fn(),
  updateUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbState.db,
  getStoragePath: () => dbState.appHome,
  isSqliteAvailable: () => Boolean(dbState.db),
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: effects.updateUsage,
}))
vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/lib/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  countTokens: vi.fn(() => 0),
}))
vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: vi.fn(() => ''),
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/compression', () => ({
  buildCompressedHistory: vi.fn(async () => []),
  buildDbHistory: vi.fn(async () => []),
  buildSnapshotAwareHistory: vi.fn(async (_sid, _profile, history) => history),
  getOrCreateSession: (sessionMap: Map<string, any>, sessionId: string) => {
    let state = sessionMap.get(sessionId)
    if (!state) {
      state = { messages: [], isWorking: false, events: [], queue: [] }
      sessionMap.set(sessionId, state)
    }
    return state
  },
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/usage', () => ({
  calcAndUpdateUsage: effects.calcUsage,
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
}))
vi.mock('../../packages/server/src/services/hermes/run-chat/response-stream', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/services/hermes/run-chat/response-stream')>(),
  flushResponseRunToDb: effects.flush,
}))

import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import {
  createSession,
  deleteSession,
  getSessionDetail,
  getSessionIncarnation,
  getSessionRowId,
} from '../../packages/server/src/db/hermes/session-store'
import { handleApiRun } from '../../packages/server/src/services/hermes/run-chat/handle-api-run'
import { bindSessionGeneration, readSessionGeneration } from '../../packages/server/src/services/hermes/run-chat/session-generation'
import type { SessionState } from '../../packages/server/src/services/hermes/run-chat/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function controlledSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: value => { controller = value } })
  return {
    stream,
    send(event: string, data: Record<string, unknown>) {
      controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    },
    close() {
      controller.close()
    },
  }
}

function makeState(message: string): SessionState {
  const state: SessionState = {
    messages: [{ id: 1, role: 'user', content: message, timestamp: 1 }],
    isWorking: true,
    events: [],
    queue: [],
    activeRunMarker: `marker-${message}`,
    profile: 'research',
  }
  bindSessionGeneration(state, readSessionGeneration('same-id'))
  return state
}

function harness() {
  const roomEvents: Array<{ event: string; payload: any }> = []
  const peerEvents: Array<{ event: string; payload: any }> = []
  const roomTarget = {
    emit: (event: string, payload: any) => roomEvents.push({ event, payload }),
    except: vi.fn(() => roomTarget),
  }
  const peerTarget = {
    emit: (event: string, payload: any) => peerEvents.push({ event, payload }),
  }
  const nsp = { to: vi.fn(() => roomTarget) }
  const socket = {
    id: 'socket-api-generation',
    connected: true,
    data: {},
    join: vi.fn(),
    emit: vi.fn(),
    to: vi.fn(() => peerTarget),
  }
  return { nsp: nsp as any, peerEvents, roomEvents, socket: socket as any }
}

describe('direct API run generation ownership', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'hermes-api-generation-'))
    dbState.appHome = root
    dbState.db = new DatabaseSync(join(root, 'sessions.db'))
    initAllHermesTables()
    createSession({ id: 'same-id', profile: 'research', source: 'api_server' })
    effects.calcUsage.mockResolvedValue({ inputTokens: 3, outputTokens: 5 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    dbState.db?.close()
    dbState.db = null
    rmSync(root, { recursive: true, force: true })
  })

  function replaceSession(sessionMap: Map<string, SessionState>) {
    const oldIncarnation = getSessionIncarnation('same-id')
    expect(deleteSession('same-id')).toBe(true)
    createSession({ id: 'same-id', profile: 'research', source: 'api_server' })
    expect(getSessionIncarnation('same-id')).not.toBe(oldIncarnation)
    const replacement = makeState('replacement')
    replacement.queue.push({ queue_id: 'replacement-queued', input: 'keep queued' })
    sessionMap.set('same-id', replacement)
    return replacement
  }

  async function startControlledRun() {
    const upstream = controlledSse()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal || undefined
      return Promise.resolve({ ok: true, status: 200, body: upstream.stream })
    }))
    const sessionMap = new Map<string, SessionState>()
    const oldState = makeState('old')
    oldState.isWorking = false
    oldState.activeRunMarker = undefined
    sessionMap.set('same-id', oldState)
    const { nsp, roomEvents, socket } = harness()
    const dequeue = vi.fn()
    const running = handleApiRun(
      nsp,
      socket,
      { input: 'old request', session_id: 'same-id', source: 'api_server' },
      'research',
      sessionMap,
      false,
      dequeue,
    )
    await vi.waitFor(() => expect(signal).toBeDefined())
    return { dequeue, nsp, oldState, roomEvents, running, sessionMap, signal: () => signal, socket, upstream }
  }

  it.each([
    ['content', 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'stale text' }],
    ['tool', 'response.output_item.added', {
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'stale-call', name: 'terminal', arguments: '{}' },
    }],
    ['terminal', 'response.completed', {
      type: 'response.completed',
      response: {
        id: 'stale-response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'stale final' }] }],
        usage: { input_tokens: 9, output_tokens: 9 },
      },
    }],
  ] as const)('drops stale %s frames after SQLite delete and same-id recreate', async (_kind, event, frame) => {
    const run = await startControlledRun()
    const replacement = replaceSession(run.sessionMap)

    run.upstream.send(event, frame)
    run.upstream.close()
    await run.running

    expect(run.signal()?.aborted).toBe(true)
    expect(run.sessionMap.get('same-id')).toBe(replacement)
    expect(replacement).toMatchObject({
      isWorking: true,
      activeRunMarker: 'marker-replacement',
      profile: 'research',
      messages: [{ content: 'replacement' }],
      queue: [{ queue_id: 'replacement-queued' }],
    })
    expect(run.roomEvents).toEqual([])
    expect(getSessionDetail('same-id')?.messages).toEqual([])
    expect(effects.flush).not.toHaveBeenCalled()
    expect(effects.calcUsage).not.toHaveBeenCalled()
    expect(effects.updateUsage).not.toHaveBeenCalled()
    expect(run.dequeue).not.toHaveBeenCalled()
  })

  it('aborts only the captured upstream when a newer run reuses the same state object', async () => {
    const run = await startControlledRun()
    const replacementAbort = new AbortController()
    const messagesBefore = structuredClone(run.oldState.messages)
    run.oldState.activeRunMarker = 'same-generation-replacement'
    run.oldState.abortController = replacementAbort

    run.upstream.send('response.output_text.delta', {
      type: 'response.output_text.delta',
      delta: 'stale text',
    })
    run.upstream.close()
    await run.running

    expect(run.signal()?.aborted).toBe(true)
    expect(replacementAbort.signal.aborted).toBe(false)
    expect(run.oldState).toMatchObject({
      isWorking: true,
      activeRunMarker: 'same-generation-replacement',
      abortController: replacementAbort,
      messages: messagesBefore,
    })
    expect(run.roomEvents).toEqual([])
  })

  it('releases the completed API owner before handing its queue to the dequeuer', async () => {
    const run = await startControlledRun()
    run.oldState.queue.push({ queue_id: 'next', input: 'next request', profile: 'research' })

    run.upstream.send('response.completed', {
      type: 'response.completed',
      response: { id: 'old-response', status: 'completed', output: [], usage: {} },
    })
    await run.running

    expect(run.dequeue).toHaveBeenCalledWith(run.socket, 'same-id')
    expect(run.oldState).toMatchObject({
      isWorking: false,
      activeRunMarker: undefined,
      abortController: undefined,
      queue: [{ queue_id: 'next' }],
    })
  })

  it('fences terminal side effects when replacement happens during completion await', async () => {
    const usageStarted = deferred<void>()
    const usageRelease = deferred<void>()
    effects.calcUsage.mockImplementationOnce(async (_sid, _state, emit) => {
      usageStarted.resolve()
      await usageRelease.promise
      emit('usage.updated', { event: 'usage.updated', inputTokens: 3, outputTokens: 5 })
      return { inputTokens: 3, outputTokens: 5 }
    })
    const run = await startControlledRun()
    run.upstream.send('response.completed', {
      type: 'response.completed',
      response: { id: 'old-response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 5 } },
    })
    await usageStarted.promise
    const replacement = replaceSession(run.sessionMap)

    usageRelease.resolve()
    await run.running

    expect(run.signal()?.aborted).toBe(true)
    expect(run.sessionMap.get('same-id')).toBe(replacement)
    expect(replacement).toMatchObject({
      isWorking: true,
      activeRunMarker: 'marker-replacement',
      messages: [{ content: 'replacement' }],
      queue: [{ queue_id: 'replacement-queued' }],
    })
    expect(effects.flush).toHaveBeenCalledTimes(1)
    expect(effects.flush).toHaveBeenCalledWith(run.oldState, 'same-id')
    expect(effects.updateUsage).not.toHaveBeenCalled()
    expect(getSessionDetail('same-id')?.messages).toEqual([])
    expect(run.roomEvents).toEqual([])
    expect(run.dequeue).not.toHaveBeenCalled()
  })

  it('awaits and reports API failure finalization errors instead of detaching a rejection', async () => {
    effects.calcUsage.mockRejectedValueOnce(new Error('usage finalization failed'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('upstream failed') }))
    const sessionMap = new Map<string, SessionState>()
    const state = makeState('old')
    state.isWorking = false
    state.activeRunMarker = undefined
    sessionMap.set('same-id', state)
    const { nsp, roomEvents, socket } = harness()

    await handleApiRun(
      nsp,
      socket,
      { input: 'old request', session_id: 'same-id', source: 'api_server' },
      'research',
      sessionMap,
      false,
      vi.fn(),
    )

    expect(roomEvents).toEqual([
      expect.objectContaining({
        event: 'run.failed',
        payload: expect.objectContaining({
          error: expect.stringContaining('usage finalization failed'),
        }),
      }),
    ])
    expect(state).toMatchObject({ isWorking: false, activeRunMarker: undefined, abortController: undefined })
  })
})
