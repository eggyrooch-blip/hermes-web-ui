import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session pins stored on the sessions row', () => {
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

  it('persists a pin on the session row and clears it again', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { createSession, getSession, setSessionPinned } =
      await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    createSession({ id: 'session-1', profile: 'default' })

    expect(getSession('session-1')?.is_pinned).toBe(false)

    expect(setSessionPinned('session-1', true)).toBe(true)
    expect(db.prepare('SELECT is_pinned FROM sessions WHERE id = ?').get('session-1').is_pinned).toBe(1)
    expect(getSession('session-1')?.is_pinned).toBe(true)

    expect(setSessionPinned('session-1', false)).toBe(true)
    expect(db.prepare('SELECT is_pinned FROM sessions WHERE id = ?').get('session-1').is_pinned).toBe(0)
    expect(getSession('session-1')?.is_pinned).toBe(false)
  })

  it('reports no write for a session id that does not exist', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { setSessionPinned } = await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()

    expect(setSessionPinned('missing', true)).toBe(false)
  })

  it('keeps a pin separate from the expert, project and archive columns', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { createSession, getSession, setSessionArchived, setSessionPinned, updateSession } =
      await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    createSession({ id: 'session-1', profile: 'default', expert_id: 'expert-7', expert_label: 'Chenshier' })
    updateSession('session-1', { project_id: 'p-1', project_name: 'Keep', project_bound: true } as any)

    expect(setSessionPinned('session-1', true)).toBe(true)
    expect(getSession('session-1')).toMatchObject({
      is_pinned: true,
      is_archived: false,
      expert_id: 'expert-7',
      expert_label: 'Chenshier',
      project_id: 'p-1',
      project_name: 'Keep',
      project_bound: true,
    })

    expect(setSessionArchived('session-1', true)).toBe(true)
    expect(getSession('session-1')).toMatchObject({ is_pinned: true, is_archived: true })
  })

  it('adds the column to a sessions table created before the pin feature', async () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL DEFAULT 'default',
        source TEXT NOT NULL DEFAULT 'api_server',
        title TEXT,
        started_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.prepare('INSERT INTO sessions (id, profile, title, started_at, last_active) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-session', 'default', 'legacy', 10, 10)

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()

    const { getSession, setSessionPinned } = await import('../../packages/server/src/db/hermes/session-store')
    expect(getSession('legacy-session')?.is_pinned).toBe(false)
    expect(setSessionPinned('legacy-session', true)).toBe(true)
    expect(getSession('legacy-session')?.is_pinned).toBe(true)
  })

  it('lists pinned sessions first and filters on the pin', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { createSession, listSessions, setSessionPinned } =
      await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    createSession({ id: 'old', profile: 'default' })
    createSession({ id: 'new', profile: 'default' })
    createSession({ id: 'other-profile', profile: 'work' })
    db.prepare('UPDATE sessions SET last_active = 1 WHERE id = ?').run('old')
    db.prepare('UPDATE sessions SET last_active = 100 WHERE id = ?').run('new')

    expect(listSessions('default').map(s => s.id)).toEqual(['new', 'old'])

    expect(setSessionPinned('old', true)).toBe(true)
    // A pinned session outranks a more recent one, so a truncating limit keeps it.
    expect(listSessions('default').map(s => s.id)).toEqual(['old', 'new'])
    expect(listSessions('default', undefined, 1).map(s => s.id)).toEqual(['old'])

    expect(listSessions('default', undefined, 100, { pinned: true }).map(s => s.id)).toEqual(['old'])
    expect(listSessions('default', undefined, 100, { pinned: false }).map(s => s.id)).toEqual(['new'])
    // The pin never leaks across profiles.
    expect(listSessions('work', undefined, 100, { pinned: true })).toEqual([])

    expect(setSessionPinned('old', false)).toBe(true)
    expect(listSessions('default', undefined, 100, { pinned: true })).toEqual([])
    expect(listSessions('default').map(s => s.id)).toEqual(['new', 'old'])
  })

  it('still hides an archived session from the default listing when it is pinned', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const { createSession, listSessions, setSessionArchived, setSessionPinned } =
      await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    createSession({ id: 'pinned-archived', profile: 'default' })
    createSession({ id: 'plain', profile: 'default' })
    setSessionPinned('pinned-archived', true)
    setSessionArchived('pinned-archived', true)

    expect(listSessions('default').map(s => s.id)).toEqual(['plain'])
    expect(listSessions('default', undefined, 100, { includeArchived: true }).map(s => s.id))
      .toEqual(['pinned-archived', 'plain'])
  })
})
