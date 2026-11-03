import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalEnv = process.env

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'console-rbac-'))
}

function writeAdminsFile(dir: string, body: string): string {
  const file = join(dir, 'console-admins.json')
  writeFileSync(file, body, 'utf8')
  return file
}

function createRoutingDb(dbPath: string, rows: Array<{ openId: string; unionId: string; kind: string; active: number }>): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        open_id TEXT,
        union_id TEXT,
        kind TEXT,
        active INTEGER
      )
    `)
    const insert = db.prepare(
      'INSERT INTO multitenancy_routing (open_id, union_id, kind, active) VALUES (?, ?, ?, ?)',
    )
    for (const row of rows) {
      insert.run(row.openId, row.unionId, row.kind, row.active)
    }
  } finally {
    db.close()
  }
}

async function loadConsoleRbac(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  process.env = { ...originalEnv, ...env }
  const consoleRbac = await import('../../packages/server/src/services/console-rbac')
  const requestContext = await import('../../packages/server/src/services/request-context')
  return { ...consoleRbac, ...requestContext }
}

function makeCtx(user: Record<string, unknown> | null): any {
  return { state: { user } }
}

describe('console RBAC', () => {
  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it.each([
    {
      name: 'missing file',
      setup: (dir: string) => join(dir, 'missing.json'),
    },
    {
      name: 'empty object',
      setup: (dir: string) => writeAdminsFile(dir, '{}'),
    },
    {
      name: 'empty admins array',
      setup: (dir: string) => writeAdminsFile(dir, '{"admins":[]}'),
    },
    {
      name: 'malformed json',
      setup: (dir: string) => writeAdminsFile(dir, '{"admins":'),
    },
    {
      name: 'non-array admins',
      setup: (dir: string) => writeAdminsFile(dir, '{"admins":"ou_admin"}'),
    },
  ])('fails closed for $name', async ({ setup }) => {
    const dir = makeTempDir()
    const adminsFile = setup(dir)
    const { loadConsoleAdminUnionIds, resolveConsoleRole } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
    })

    expect(Array.from(loadConsoleAdminUnionIds())).toEqual([])
    expect(resolveConsoleRole(makeCtx({ openid: 'ou-open', unionId: 'ou-admin' }))).toBe('developer')

    rmSync(dir, { recursive: true, force: true })
  })

  it('returns admin when the union id is listed in the admins file', async () => {
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":[" ou-admin ","",42,null]}')
    const { loadConsoleAdminUnionIds, resolveConsoleRole } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
    })

    expect(Array.from(loadConsoleAdminUnionIds())).toEqual(['ou-admin'])
    expect(resolveConsoleRole(makeCtx({ openid: 'open-1', unionId: 'ou-admin' }))).toBe('admin')

    rmSync(dir, { recursive: true, force: true })
  })

  it('returns developer when the union id is not listed in the admins file', async () => {
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":["ou-admin"]}')
    const { resolveConsoleRole } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
    })

    expect(resolveConsoleRole(makeCtx({ openid: 'open-1', unionId: 'ou-other' }))).toBe('developer')

    rmSync(dir, { recursive: true, force: true })
  })

  it('honors HERMES_CONSOLE_ADMINS_FILE over the shared-home default path', async () => {
    const dir = makeTempDir()
    const sharedHome = join(dir, 'shared-home')
    mkdirSync(sharedHome, { recursive: true })
    writeAdminsFile(sharedHome, '{"admins":["ou-shared"]}')
    const overrideFile = join(dir, 'override-admins.json')
    writeFileSync(overrideFile, '{"admins":["ou-override"]}', 'utf8')
    const { resolveConsoleRole } = await loadConsoleRbac({
      HERMES_SHARED_HOME: sharedHome,
      HERMES_CONSOLE_ADMINS_FILE: overrideFile,
    })

    expect(resolveConsoleRole(makeCtx({ openid: 'open-1', unionId: 'ou-override' }))).toBe('admin')
    expect(resolveConsoleRole(makeCtx({ openid: 'open-1', unionId: 'ou-shared' }))).toBe('developer')

    rmSync(dir, { recursive: true, force: true })
  })

  it('drops an admin back to developer after the admins file is deleted', async () => {
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":["ou-admin"]}')
    const { resolveConsoleRole } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
    })
    const ctx = makeCtx({ openid: 'open-1', unionId: 'ou-admin' })

    expect(resolveConsoleRole(ctx)).toBe('admin')
    rmSync(adminsFile, { force: true })
    expect(resolveConsoleRole(ctx)).toBe('developer')

    rmSync(dir, { recursive: true, force: true })
  })

  it('picks the sync row with a real union_id over an auto NULL-union_id row', async () => {
    // The exact prod shape: an open_id with TWO active user rows — a provenance='sync'
    // row carrying the real union_id, and a provenance='auto' row with union_id NULL.
    // Without the provenance filter + IS NOT NULL guard, SQLite sorts NULL first and
    // the admin is demoted. This DB carries the provenance column (createRoutingDb's
    // minimal schema does not), so it exercises that predicate.
    const { DatabaseSync } = await import('node:sqlite')
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":["ou-admin"]}')
    const dbPath = join(dir, 'multitenancy.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('CREATE TABLE multitenancy_routing (open_id TEXT, union_id TEXT, kind TEXT, active INTEGER, provenance TEXT)')
      const ins = db.prepare('INSERT INTO multitenancy_routing VALUES (?,?,?,?,?)')
      ins.run('open-1', null, 'user', 1, 'auto')      // NULL union_id, auto
      ins.run('open-1', 'ou-admin', 'user', 1, 'sync') // real union_id, sync
    } finally {
      db.close()
    }
    const { resolveConsoleRole, resolveUnionIdForOpenId } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
      HERMES_MULTITENANCY_DB: dbPath,
    })
    expect(resolveUnionIdForOpenId('open-1')).toBe('ou-admin') // sync row, not NULL
    expect(resolveConsoleRole(makeCtx({ openid: 'open-1' }))).toBe('admin')
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not negatively cache a missing union_id — re-resolves after backfill', async () => {
    // The exact regression: an admin's row exists but union_id is NULL at first
    // /auth/me. If we cached the undefined, they'd stay 'developer' forever even
    // after an operator backfills the union_id — until a process restart.
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":["ou-admin"]}')
    const dbPath = join(dir, 'multitenancy.db')
    createRoutingDb(dbPath, [
      { openId: 'open-1', unionId: null as any, kind: 'user', active: 1 }, // union_id NULL initially
    ])
    const { resolveConsoleRole } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
      HERMES_MULTITENANCY_DB: dbPath,
    })
    const ctx = makeCtx({ openid: 'open-1' })
    expect(resolveConsoleRole(ctx)).toBe('developer') // no union_id yet → developer

    // operator backfills union_id (same open_id row)
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare("UPDATE multitenancy_routing SET union_id = 'ou-admin' WHERE open_id = 'open-1'").run()
    } finally {
      db.close()
    }
    // must re-query (not serve a cached undefined) and now resolve admin
    expect(resolveConsoleRole(ctx)).toBe('admin')
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves an admin whose routing row has NULL/empty kind (prod trusted-header)', async () => {
    // The exact prod bug: trusted-header sessions carry no unionId → fall back to
    // the DB, and prod rows may have NULL kind. A strict kind='user' would miss it
    // and silently demote the admin to developer (404 the whole ops plane).
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":["ou-admin"]}')
    const dbPath = join(dir, 'multitenancy.db')
    createRoutingDb(dbPath, [
      { openId: 'open-1', unionId: 'ou-admin', kind: null as any, active: 1 }, // NULL kind
    ])
    const { resolveConsoleRole, resolveUnionIdForOpenId } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
      HERMES_MULTITENANCY_DB: dbPath,
    })
    expect(resolveUnionIdForOpenId('open-1')).toBe('ou-admin')
    expect(resolveConsoleRole(makeCtx({ openid: 'open-1' }))).toBe('admin')
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to the routing db when the session lacks a union id', async () => {
    const dir = makeTempDir()
    const adminsFile = writeAdminsFile(dir, '{"admins":["ou-admin"]}')
    const dbPath = join(dir, 'multitenancy.db')
    createRoutingDb(dbPath, [
      { openId: 'open-1', unionId: 'ou-admin', kind: 'user', active: 1 },
      { openId: 'open-1', unionId: 'ou-agent', kind: 'agent', active: 1 },
    ])
    const { resolveConsoleRole, resolveUnionIdForOpenId } = await loadConsoleRbac({
      HERMES_CONSOLE_ADMINS_FILE: adminsFile,
      HERMES_MULTITENANCY_DB: dbPath,
    })

    expect(resolveUnionIdForOpenId('open-1')).toBe('ou-admin')
    expect(resolveConsoleRole(makeCtx({ openid: 'open-1' }))).toBe('admin')

    rmSync(dir, { recursive: true, force: true })
  })
})
