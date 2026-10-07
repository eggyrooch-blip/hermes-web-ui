import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRunReasoningEffort } from '../../packages/server/src/services/hermes/run-chat/reasoning-effort'

/**
 * The reasoning-effort slider is only per-session and cross-device if the
 * choice lands on the session row. These tests pin the storage half: the
 * column exists on a fresh table, migrates onto an old one, round-trips
 * through create/update, and stays independent per session.
 */
describe('session reasoning effort persistence', () => {
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

  async function store() {
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()
    return sessionStore
  }

  it('defaults to no override and keeps what createSession was given', async () => {
    const { createSession, getSession } = await store()

    createSession({ id: 'plain', profile: 'default', source: 'cli' })
    createSession({ id: 'seeded', profile: 'default', source: 'cli', reasoning_effort: 'high' })

    expect(getSession('plain')?.reasoning_effort).toBe('')
    expect(getSession('seeded')?.reasoning_effort).toBe('high')
  })

  it('round-trips an update and clears back to the config default', async () => {
    const { createSession, getSession, updateSession } = await store()
    createSession({ id: 's1', profile: 'default', source: 'cli' })

    updateSession('s1', { reasoning_effort: 'xhigh' })
    expect(getSession('s1')?.reasoning_effort).toBe('xhigh')

    updateSession('s1', { reasoning_effort: '' })
    expect(getSession('s1')?.reasoning_effort).toBe('')
  })

  // "Cleared" is stored as SQL NULL, and readers normalize NULL back to ''.
  it('stores NULL for a cleared override and still reads it as an empty string', async () => {
    const { createSession, getSession, updateSession } = await store()
    createSession({ id: 'cleared', profile: 'default', source: 'cli', reasoning_effort: 'high' })

    updateSession('cleared', { reasoning_effort: null })

    const raw = db.prepare('SELECT reasoning_effort FROM sessions WHERE id = ?').get('cleared')
    expect(raw.reasoning_effort).toBeNull()
    expect(getSession('cleared')?.reasoning_effort).toBe('')
  })

  it('keeps the override on its own session', async () => {
    const { createSession, getSession, updateSession } = await store()
    createSession({ id: 'a', profile: 'default', source: 'cli' })
    createSession({ id: 'b', profile: 'default', source: 'cli' })

    updateSession('a', { reasoning_effort: 'max' })

    expect(getSession('a')?.reasoning_effort).toBe('max')
    expect(getSession('b')?.reasoning_effort).toBe('')
  })

  // Every deployed database predates this column, so the ALTER path is the one
  // that actually runs in production — a table rebuild would lose sessions.
  it('adds the column to a sessions table created before it existed', async () => {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL DEFAULT 'default',
        source TEXT NOT NULL DEFAULT 'api_server',
        model TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        title TEXT,
        started_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      )
    `)
    db.prepare('INSERT INTO sessions (id, profile, source, title, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy', 'default', 'cli', 'legacy session', 100, 100)

    const { getSession, updateSession } = await store()

    // The pre-existing row survives and reads as "no override".
    expect(getSession('legacy')?.reasoning_effort).toBe('')
    updateSession('legacy', { reasoning_effort: 'medium' })
    expect(getSession('legacy')?.reasoning_effort).toBe('medium')
  })
})

/**
 * The write endpoint. Anything outside the slider's vocabulary is refused
 * rather than stored: an unrecognized string reaches the agent, gets dropped
 * there, and leaves the slider claiming a depth the run never used.
 */
describe('POST /api/hermes/sessions/:id/reasoning-effort', () => {
  const localGetSessionMock = vi.fn()
  const localUpdateSessionMock = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    localGetSessionMock.mockReset()
    localUpdateSessionMock.mockReset()
  })

  async function controller() {
    vi.doMock('../../packages/server/src/db/hermes/session-store', () => ({
      getSession: localGetSessionMock,
      updateSession: localUpdateSessionMock,
      getSessionDetail: vi.fn(),
      getSessionDetailPaginated: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      setSessionArchived: vi.fn(),
      listSessions: vi.fn(),
      listSessionsByAgent: vi.fn(),
      searchSessions: vi.fn(),
      searchSessionsByAgent: vi.fn(),
      addMessages: vi.fn(),
      updateSessionStats: vi.fn(),
      getSessionRowId: vi.fn(),
      getSessionIncarnation: vi.fn(),
      claimFamilySwitchNotice: vi.fn(),
      clearSessionMessages: vi.fn(),
      addMessage: vi.fn(),
      getMessageCount: vi.fn(),
      isSessionStorageAvailable: vi.fn(() => true),
    }))
    return import('../../packages/server/src/controllers/hermes/sessions')
  }

  function ctx(id: string, body: unknown) {
    return { params: { id }, query: {}, request: { body }, state: {}, headers: {} } as any
  }

  it('stores a valid level and echoes it back', async () => {
    localGetSessionMock.mockReturnValue({ id: 's1', profile: 'default', source: 'cli' })
    const { setReasoningEffort } = await controller()

    const c = ctx('s1', { reasoningEffort: 'high' })
    await setReasoningEffort(c)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('s1', { reasoning_effort: 'high' })
    expect(c.body).toEqual({ ok: true, reasoning_effort: 'high' })
  })

  it('accepts an empty string as "clear the override" and writes NULL', async () => {
    localGetSessionMock.mockReturnValue({ id: 's1', profile: 'default', source: 'cli' })
    const { setReasoningEffort } = await controller()

    const c = ctx('s1', { reasoningEffort: '' })
    await setReasoningEffort(c)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('s1', { reasoning_effort: null })
    expect(c.body).toEqual({ ok: true, reasoning_effort: '' })
  })

  it('rejects a level the slider has no stop for', async () => {
    localGetSessionMock.mockReturnValue({ id: 's1', profile: 'default', source: 'cli' })
    const { setReasoningEffort } = await controller()

    const c = ctx('s1', { reasoningEffort: 'ludicrous' })
    await setReasoningEffort(c)

    expect(c.status).toBe(400)
    expect(localUpdateSessionMock).not.toHaveBeenCalled()
  })

  it('rejects a non-string body value', async () => {
    localGetSessionMock.mockReturnValue({ id: 's1', profile: 'default', source: 'cli' })
    const { setReasoningEffort } = await controller()

    const c = ctx('s1', { reasoningEffort: 3 })
    await setReasoningEffort(c)

    expect(c.status).toBe(400)
    expect(localUpdateSessionMock).not.toHaveBeenCalled()
  })

  it('404s for a session that does not exist', async () => {
    localGetSessionMock.mockReturnValue(null)
    const { setReasoningEffort } = await controller()

    const c = ctx('missing', { reasoningEffort: 'high' })
    await setReasoningEffort(c)

    expect(c.status).toBe(404)
    expect(localUpdateSessionMock).not.toHaveBeenCalled()
  })
})

/**
 * Precedence the two run handlers apply when deciding what depth a turn runs
 * at. The rule is `??`, not `||`: '' is the user saying "cleared" and has to
 * beat the row, while undefined means the caller never had the slider (a
 * resumed or queued run) and should read the row.
 */
describe('run reasoning-effort precedence', () => {
  // The real helper both run handlers call, not a copy of its logic.
  const effectiveReasoningEffort = resolveRunReasoningEffort

  it("lets a cleared override beat the value still on the row", () => {
    // REVIEW unset-falls-back-to-stale-value#p1: with `||` this returned the
    // stale 'medium' and the turn kept thinking at the old depth.
    expect(effectiveReasoningEffort('', 'medium')).toBe('')
  })

  it('reads the row only when the request never mentioned the field', () => {
    expect(effectiveReasoningEffort(undefined, 'medium')).toBe('medium')
  })

  it("prefers this turn's explicit pick over the row", () => {
    expect(effectiveReasoningEffort('xhigh', 'medium')).toBe('xhigh')
  })

  it('is empty when neither the request nor the row has one', () => {
    expect(effectiveReasoningEffort(undefined, undefined)).toBe('')
    expect(effectiveReasoningEffort('', undefined)).toBe('')
  })
})
