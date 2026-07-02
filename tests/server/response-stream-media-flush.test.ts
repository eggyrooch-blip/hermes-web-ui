import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// run-chat/response-stream.flushResponseRunToDb must publish MEDIA: artifacts
// (rewriteAssistantMediaDirectives) before persisting, like the
// broker-controller flush already does. Without it the DB keeps the raw
// absolute-path MEDIA line and reloaded history renders no file card.

const addMessageMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const profileDir = mkdtempSync(join(tmpdir(), 'rs-flush-'))
const homeDir = join(profileDir, 'home')

vi.mock('../../packages/server/src/services/hermes/hermes-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/hermes/hermes-profile')>()
  return { ...actual, getProfileDir: () => profileDir }
})

import { flushResponseRunToDb } from '../../packages/server/src/services/hermes/run-chat/response-stream'

mkdirSync(homeDir, { recursive: true })
writeFileSync(join(homeDir, 'a.pptx'), 'PPTX-BYTES')

afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

function makeState(content: string): any {
  return {
    messages: [{
      id: 1,
      session_id: 's1',
      role: 'assistant',
      content,
      runMarker: 'r1',
      timestamp: 1,
    }],
    isWorking: false,
    events: [],
    queue: [],
    profile: 'songtingting',
    responseRun: { runMarker: 'r1', insertedKeys: new Set<string>(), toolCalls: new Map() },
  }
}

beforeEach(() => {
  addMessageMock.mockClear()
})

describe('flushResponseRunToDb media publishing', () => {
  it('persists the rewritten /workspace/ link instead of the raw MEDIA line', () => {
    const state = makeState(`PPT 已生成完毕\n\nMEDIA:${join(homeDir, 'a.pptx')}`)
    flushResponseRunToDb(state, 's1')

    expect(addMessageMock).toHaveBeenCalledTimes(1)
    const persisted = addMessageMock.mock.calls[0][0]
    expect(persisted.content).toContain('[a.pptx](/workspace/Downloads/a.pptx)')
    expect(persisted.content).not.toContain('MEDIA:')
    // The artifact is published into the workspace for the download route.
    expect(existsSync(join(profileDir, 'workspace', 'Downloads', 'a.pptx'))).toBe(true)
  })

  it('leaves content without MEDIA lines untouched', () => {
    const state = makeState('plain answer')
    flushResponseRunToDb(state, 's1')
    expect(addMessageMock.mock.calls[0][0].content).toBe('plain answer')
  })
})
