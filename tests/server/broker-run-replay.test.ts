import { afterEach, describe, expect, it, vi } from 'vitest'

// config.runBrokerUrl / runBrokerKey drive the fetch target.
vi.mock('../../packages/server/src/config', () => ({
  config: { runBrokerUrl: 'http://broker.test', runBrokerKey: 'k' },
}))
// Keep DB + input builders inert — replay mode doesn't touch them.
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  getSession: () => null,
}))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: () => '/tmp',
}))

import { handleBrokerRun } from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

function sseStream(...frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

function fakeContext() {
  return {
    sessionMap: new Map(),
    getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined }),
    getResponseRunState: () => ({ responseId: undefined }),
    markCompleted: vi.fn(async () => {}),
    dequeueNextQueuedRun: vi.fn(),
    buildInput: (x: any) => x,
  } as any
}

const socket = { data: { user: { openid: 'ou_alice' } }, join: vi.fn(), connected: true } as any

afterEach(() => vi.restoreAllMocks())

describe('handleBrokerRun replay mode', () => {
  it('POSTs the broker replay endpoint (not /runs) when replay_run_id is set', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(String(url))
      return { ok: true, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n'), status: 200 } as any
    })
    vi.stubGlobal('fetch', fetchMock)

    const emit = vi.fn()
    await handleBrokerRun(socket, { input: '', session_id: 's1', replay_run_id: 'sig-42' }, 'default', 'rm', emit, fakeContext())

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('http://broker.test/api/run-broker/credentials/replay/sig-42')
    expect(seen[0]).not.toContain('/api/run-broker/runs')
  })

  it('POSTs /runs (not replay) for a normal run', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(String(url))
      return { ok: true, body: sseStream('event: done\ndata: {"kind":"done","run_id":"r"}\n\n'), status: 200 } as any
    })
    vi.stubGlobal('fetch', fetchMock)

    const emit = vi.fn()
    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', emit, fakeContext())

    expect(seen[0]).toBe('http://broker.test/api/run-broker/runs')
    expect(seen[0]).not.toContain('/replay/')
  })

  it('attaches the broker run id to live session messages', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [], runId: undefined, abortController: undefined } as any
    const run = { runMarker: 'rm', responseId: undefined, insertedKeys: new Set<string>(), toolCalls: new Map() }
    const context = {
      sessionMap: new Map([['s1', state]]),
      getOrCreateSession: () => state,
      getResponseRunState: () => run,
      markCompleted: vi.fn(async () => {}),
      dequeueNextQueuedRun: vi.fn(),
      buildInput: (value: any) => value,
    } as any
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream(
        'event: content\ndata: {"kind":"content","run_id":"run-live","text":"hello"}\n\n',
        'event: done\ndata: {"kind":"done","run_id":"run-live","output":"hello"}\n\n',
      ),
    })))

    await handleBrokerRun(socket, { input: 'hi', session_id: 's1' }, 'default', 'rm', vi.fn(), context)

    expect(state.runId).toBe('run-live')
    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'hello', run_id: 'run-live' }),
    ])
  })
})
