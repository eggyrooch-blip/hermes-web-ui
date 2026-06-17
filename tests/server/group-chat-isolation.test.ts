import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Upstream-rebaseline note (2026-06-17)
//
// The fork used to enforce group-chat isolation with a per-room `owner_open_id`
// column on `gc_rooms` plus route-level ownership guards (403 on adding an
// un-owned agent profile, 404 on non-owner room read/delete/config/clone, and an
// owner-scoped room list keyed on the requester's Feishu openid).
//
// The upstream EKKOLearnAI rebaseline REPLACED that model:
//   - `gc_rooms` (packages/server/src/db/hermes/schemas.ts) has NO owner_open_id.
//   - `ChatStorage` (packages/server/src/services/hermes/group-chat/index.ts)
//     exposes `getAllRooms()` + `getRoomsForProfiles(profiles)` — there is no
//     `getRoomsByOwner` and `saveRoom` takes no owner argument.
//   - The group-chat routes (packages/server/src/routes/hermes/group-chat.ts)
//     carry NO ownership guards: create/get/delete/config/clone/add-agent never
//     consult openid and never return 403/404-for-non-owner; the room list is
//     scoped by `ctx.state.user.profiles` / `role === 'super_admin'` via
//     `getRoomsForProfiles`, not by openid ownership.
//
// The 8 fork-era cases (room owner_open_id persistence, 403 add-agent, 404
// non-owner read/delete/config/clone, owner-scoped list, regression sentinel)
// therefore tested a feature that no longer exists, via a `createStorage`
// helper that reimplemented the deleted owner_open_id column. They were deleted
// rather than rewritten because the route deliberately implements a different
// isolation model — there is no behaviour left for them to assert.
//
// What survives is the profile-ownership service `agent-ownership.ts`, which is
// still wired into the upstream isolation path (broker-controller / slash /
// request-context). The one real, still-meaningful isolation assertion is kept
// below: ownerOwnsProfile must enforce profile ownership across multitenancy
// schemas both with and without the optional owner_open_id/provenance columns.
// ---------------------------------------------------------------------------

const originalEnv = process.env

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createRoutingDbWithOwnerColumns(): string {
  const dir = makeTempDir('gc-routing-owner-')
  const dbPath = join(dir, 'multitenancy.db')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        user_id TEXT PRIMARY KEY NOT NULL,
        profile_name TEXT NOT NULL,
        open_id TEXT NOT NULL,
        owner_open_id TEXT,
        provenance TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
    `)

    db.prepare(`
      INSERT INTO multitenancy_routing (user_id, profile_name, open_id, owner_open_id, provenance, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-ouA', 'profA', 'ouA', 'ouA', 'sync', 1)
  } finally {
    db.close()
  }

  return dbPath
}

function createRoutingDbWithoutOwnerColumns(): string {
  const dir = makeTempDir('gc-routing-legacy-')
  const dbPath = join(dir, 'multitenancy.db')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        user_id TEXT PRIMARY KEY NOT NULL,
        profile_name TEXT NOT NULL,
        open_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
    `)

    db.prepare(`
      INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active)
      VALUES (?, ?, ?, ?)
    `).run('legacy-ouA', 'profA', 'ouA', 1)
  } finally {
    db.close()
  }

  return dbPath
}

async function loadOwnerOwnsProfile(multitenancyDbPath: string) {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env = { ...originalEnv, HERMES_MULTITENANCY_DB: multitenancyDbPath }
  return import('../../packages/server/src/services/hermes/agent-ownership')
}

describe('group-chat isolation', () => {
  afterEach(() => {
    process.env = originalEnv
  })

  it('degrades ownerOwnsProfile across multitenancy schemas with and without owner columns', async () => {
    const legacyDbPath = createRoutingDbWithoutOwnerColumns()
    const { ownerOwnsProfile: legacyOwnerOwnsProfile } = await loadOwnerOwnsProfile(legacyDbPath)

    expect(legacyOwnerOwnsProfile('ouA', 'profA')).toBe(true)
    expect(legacyOwnerOwnsProfile('ouA', 'profMissing')).toBe(false)

    const currentDbPath = createRoutingDbWithOwnerColumns()
    const { ownerOwnsProfile: currentOwnerOwnsProfile } = await loadOwnerOwnsProfile(currentDbPath)

    expect(currentOwnerOwnsProfile('ouA', 'profA')).toBe(true)
    expect(currentOwnerOwnsProfile('ouA', 'profB')).toBe(false)

    rmSync(join(legacyDbPath, '..'), { recursive: true, force: true })
    rmSync(join(currentDbPath, '..'), { recursive: true, force: true })
  })
})
