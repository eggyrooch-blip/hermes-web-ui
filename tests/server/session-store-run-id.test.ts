import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session message run identity', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('returns the persisted run id from paginated session messages', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { addMessage, createSession, getSessionDetailPaginated } =
      await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    createSession({ id: 'session-1', profile: 'default', source: 'cli' })

    addMessage({
      session_id: 'session-1',
      role: 'assistant',
      content: 'Changed app.ts',
      timestamp: 100,
      run_id: 'run-1',
      client_id: 'client-message-1',
    } as any)

    expect(getSessionDetailPaginated('session-1')?.messages).toEqual([
      expect.objectContaining({ run_id: 'run-1', client_id: 'client-message-1' }),
    ])
  })

  it('adds a backward-compatible empty run id to an existing messages table', async () => {
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL
      )
    `)
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`)
      .run('legacy-session', 'assistant', 'legacy answer', 100)

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    const row = db.prepare('SELECT content, run_id, client_id FROM messages WHERE session_id = ?')
      .get('legacy-session') as { content: string; run_id: string; client_id: string }
    expect(row).toEqual({ content: 'legacy answer', run_id: '', client_id: '' })
  })
})
