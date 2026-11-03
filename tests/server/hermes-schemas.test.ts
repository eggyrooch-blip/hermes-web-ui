import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Hermes schema initialization', () => {
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

  it('initializes all tables with correct schemas', async () => {
    const { initAllHermesTables, USAGE_TABLE, SESSIONS_TABLE, MESSAGES_TABLE, MESSAGE_FEEDBACK_TABLE, GC_ROOMS_TABLE, USERS_TABLE, USER_PROFILES_TABLE, DEVICES_TABLE } =
      await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify core tables exist
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain(USAGE_TABLE)
    expect(tables.map(t => t.name)).toContain(SESSIONS_TABLE)
    expect(tables.map(t => t.name)).toContain(MESSAGES_TABLE)
    expect(tables.map(t => t.name)).toContain(MESSAGE_FEEDBACK_TABLE)
    expect(tables.map(t => t.name)).toContain(GC_ROOMS_TABLE)
    expect(tables.map(t => t.name)).toContain(USERS_TABLE)
    expect(tables.map(t => t.name)).toContain(USER_PROFILES_TABLE)
    expect(tables.map(t => t.name)).toContain(DEVICES_TABLE)

    // Verify USAGE_TABLE structure
    const usageCols = db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string }>
    expect(usageCols.some(c => c.name === 'id')).toBe(true)
    expect(usageCols.some(c => c.name === 'session_id')).toBe(true)
    expect(usageCols.some(c => c.name === 'input_tokens')).toBe(true)
    expect(usageCols.some(c => c.name === 'output_tokens')).toBe(true)

    const sessionCols = db.prepare(`PRAGMA table_info("${SESSIONS_TABLE}")`).all() as Array<{ name: string }>
    expect(sessionCols.some(c => c.name === 'source')).toBe(true)
    expect(sessionCols.some(c => c.name === 'agent')).toBe(true)
    expect(sessionCols.some(c => c.name === 'expert_id')).toBe(true)
    expect(sessionCols.some(c => c.name === 'expert_label')).toBe(true)
    expect(sessionCols.some(c => c.name === 'expert_avatar')).toBe(true)

    const feedbackCols = db.prepare(`PRAGMA table_info("${MESSAGE_FEEDBACK_TABLE}")`).all() as Array<{ name: string; pk: number }>
    expect(feedbackCols.map(c => c.name)).toEqual(expect.arrayContaining([
      'principal_subject', 'session_id', 'run_id', 'expert_id', 'rating', 'reason', 'created_at', 'updated_at',
    ]))
    expect(feedbackCols.filter(c => c.pk > 0)).toHaveLength(3)

    const userCols = db.prepare(`PRAGMA table_info("${USERS_TABLE}")`).all() as Array<{ name: string }>
    expect(userCols.some(c => c.name === 'id')).toBe(true)
    expect(userCols.some(c => c.name === 'username')).toBe(true)
    expect(userCols.some(c => c.name === 'password_hash')).toBe(true)
    expect(userCols.some(c => c.name === 'role')).toBe(true)

    const profileCols = db.prepare(`PRAGMA table_info("${USER_PROFILES_TABLE}")`).all() as Array<{ name: string }>
    expect(profileCols.some(c => c.name === 'user_id')).toBe(true)
    expect(profileCols.some(c => c.name === 'profile_name')).toBe(true)
    expect(profileCols.some(c => c.name === 'is_default')).toBe(true)

    const deviceCols = db.prepare(`PRAGMA table_info("${DEVICES_TABLE}")`).all() as Array<{ name: string }>
    expect(deviceCols.some(c => c.name === 'id')).toBe(true)
    expect(deviceCols.some(c => c.name === 'status')).toBe(true)
    expect(deviceCols.some(c => c.name === 'device_public_key')).toBe(true)
  })

  it('preserves existing data when adding safe schema columns', async () => {
    const { initAllHermesTables, USAGE_TABLE, USAGE_SCHEMA } =
      await import('../../packages/server/src/db/hermes/schemas')

    // Create table with minimal schema
    db.exec(`CREATE TABLE "${USAGE_TABLE}" (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)`)

    // Insert test data
    db.prepare(`INSERT INTO "${USAGE_TABLE}" (session_id, created_at) VALUES (?, ?)`).run('test-session', Date.now())

    // Run initialization (should add safe missing columns)
    expect(() => initAllHermesTables()).not.toThrow()

    // Verify data is preserved
    const row = db.prepare(`SELECT * FROM "${USAGE_TABLE}" WHERE session_id = ?`).get('test-session')
    expect(row).toBeTruthy()
    expect(row.session_id).toBe('test-session')

    // Verify safe new columns were added
    const cols = db.prepare(`PRAGMA table_info("${USAGE_TABLE}")`).all() as Array<{ name: string }>
    expect(cols.some(c => c.name === 'input_tokens')).toBe(true)
    expect(cols.some(c => c.name === 'output_tokens')).toBe(true)
  })

  it('upserts and deletes one feedback row idempotently for a principal/session/run', async () => {
    const { initAllHermesTables, MESSAGE_FEEDBACK_TABLE, MESSAGES_TABLE } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    const feedback = await import('../../packages/server/src/db/hermes/feedback-store')

    const addAssistant = db.prepare(
      `INSERT INTO "${MESSAGES_TABLE}" (session_id, role, content, timestamp, finish_reason, tool_calls, run_id)
       VALUES (?, 'assistant', ?, ?, ?, ?, ?)`,
    )
    addAssistant.run('session-a', 'draft', 1, null, null, 'run-draft')
    addAssistant.run('session-a', 'calling a tool', 2, 'tool_calls', '[{"id":"call-1"}]', 'run-tool')
    addAssistant.run('session-a', 'failed', 3, 'error', null, 'run-error')
    addAssistant.run('session-a', 'final answer', 4, 'stop', null, 'run-final')
    expect(feedback.hasFinalAnswer('session-a', 'run-draft')).toBe(false)
    expect(feedback.hasFinalAnswer('session-a', 'run-tool')).toBe(false)
    expect(feedback.hasFinalAnswer('session-a', 'run-error')).toBe(false)
    expect(feedback.hasFinalAnswer('session-a', 'run-final')).toBe(true)
    addAssistant.run('session-a', 'later failure', 5, 'error', null, 'run-final')
    expect(feedback.hasFinalAnswer('session-a', 'run-final')).toBe(false)

    const first = feedback.upsertFeedback({
      principalSubject: 'feishu:principal-a', sessionId: 'session-a', runId: 'run-1', expertId: 'expert-x', rating: 'up', reason: null,
    })
    const retry = feedback.upsertFeedback({
      principalSubject: 'feishu:principal-a', sessionId: 'session-a', runId: 'run-1', expertId: 'expert-x', rating: 'up', reason: null,
    })
    expect(retry).toEqual(first)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM "${MESSAGE_FEEDBACK_TABLE}"`).get() as { count: number }).count).toBe(1)

    const changed = feedback.upsertFeedback({
      principalSubject: 'feishu:principal-a', sessionId: 'session-a', runId: 'run-1', expertId: 'expert-x', rating: 'down', reason: 'inaccurate',
    })
    expect(changed).toMatchObject({ rating: 'down', reason: 'inaccurate' })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM "${MESSAGE_FEEDBACK_TABLE}"`).get() as { count: number }).count).toBe(1)
    expect(feedback.deleteFeedback('feishu:principal-a', 'session-a', 'run-1')).toBeUndefined()
    expect(feedback.deleteFeedback('feishu:principal-a', 'session-a', 'run-1')).toBeUndefined()
    expect((db.prepare(`SELECT COUNT(*) AS count FROM "${MESSAGE_FEEDBACK_TABLE}"`).get() as { count: number }).count).toBe(0)
  })

  it('handles single-column primary key tables correctly', async () => {
    const { initAllHermesTables, GC_ROOM_AGENTS_TABLE } =
      await import('../../packages/server/src/db/hermes/schemas')

    expect(() => initAllHermesTables()).not.toThrow()

    // Verify table has primary key and required columns
    const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(GC_ROOM_AGENTS_TABLE) as { sql: string }
    expect(tableInfo.sql).toContain('PRIMARY KEY')
    expect(tableInfo.sql).toContain('id')
    expect(tableInfo.sql).toContain('roomId')
    expect(tableInfo.sql).toContain('agentId')

    // Verify we can insert multiple entries with unique id
    db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1', '', 0)
    db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('agent-2', 'room-1', 'agent-2', 'default', 'Agent 2', '', 0)

    const count = db.prepare(`SELECT COUNT(*) as count FROM "${GC_ROOM_AGENTS_TABLE}"`).get() as { count: number }
    expect(count.count).toBe(2)

    // Verify duplicate primary key is rejected
    expect(() => {
      db.prepare(`INSERT INTO "${GC_ROOM_AGENTS_TABLE}" (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('agent-1', 'room-1', 'agent-1', 'default', 'Agent 1 Duplicate', '', 0)
    }).toThrow()
  })
})
