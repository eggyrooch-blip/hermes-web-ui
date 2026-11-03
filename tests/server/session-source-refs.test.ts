import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { handleMessage } from '../../packages/server/src/services/hermes/run-chat/message-format'

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/digital_employee_source_refs.json', import.meta.url),
  'utf8',
))

describe('message source refs persistence', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('stores the fixed D envelope only on the final assistant message and restores it', async () => {
    const db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const store = await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    store.createSession({ id: 's1', profile: 'default' })
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'tool', run_id: 'run-1' })
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'final', run_id: 'run-1', source_refs: fixture.final_event.source_refs as any })
    expect(store.getSessionDetail('s1')?.messages.map(m => m.source_refs)).toEqual([null, fixture.final_event.source_refs])
    db.close()
  })

  it('preserves the raw envelope for authorization after a cold database load', () => {
    const sourceRefs = fixture.final_event.source_refs as any

    expect(handleMessage([{
      id: 1,
      session_id: 's1',
      role: 'assistant',
      content: 'final',
      timestamp: 1,
      run_id: 'run-1',
      source_refs: sourceRefs,
    }], 's1')).toEqual([
      expect.objectContaining({ source_refs: sourceRefs }),
    ])
  })
})
