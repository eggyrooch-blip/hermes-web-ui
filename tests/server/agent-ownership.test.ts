import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env
const roots: string[] = []

function createRoutingDb(options: { withKind?: boolean; withProvenance?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-agent-ownership-'))
  roots.push(dir)
  const dbPath = join(dir, 'multitenancy.db')
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE multitenancy_routing (
      user_id TEXT PRIMARY KEY NOT NULL,
      profile_name TEXT NOT NULL,
      open_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      owner_open_id TEXT
      ${options.withKind ? ", kind TEXT" : ""}
      ${options.withProvenance ? ", provenance TEXT" : ""}
      ${options.withKind ? ", display_label TEXT, agent_id TEXT" : ""}
    );
  `)
  return { db, dbPath }
}

async function loadOwnership(dbPath: string) {
  vi.resetModules()
  process.env = { ...originalEnv, HERMES_MULTITENANCY_DB: dbPath }
  return import('../../packages/server/src/services/hermes/agent-ownership')
}

describe('agent ownership helpers', () => {
  afterEach(() => {
    process.env = originalEnv
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps legacy schemas without kind/provenance compatible', async () => {
    const { db, dbPath } = createRoutingDb()
    try {
      db.prepare(`
        INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id)
        VALUES ('sunke', 'feishu_sunke', 'ou_sunke', 1, 'ou_sunke')
      `).run()
    } finally {
      db.close()
    }

    const { ownerOwnsProfile, listOwnedProfileNames, listOwnedProfileMetadata } = await loadOwnership(dbPath)

    expect(ownerOwnsProfile('ou_sunke', 'feishu_sunke')).toBe(true)
    expect(listOwnedProfileNames('ou_sunke')).toEqual(new Set(['feishu_sunke']))
    expect(Array.from(listOwnedProfileMetadata('ou_sunke').keys())).toEqual(['feishu_sunke'])
  })

  it('does not treat an agent row that reuses the owner open_id as an open_id-owned root profile', async () => {
    const { db, dbPath } = createRoutingDb({ withKind: true, withProvenance: true })
    try {
      const stmt = db.prepare(`
        INSERT INTO multitenancy_routing
          (user_id, profile_name, open_id, active, owner_open_id, kind, provenance, display_label, agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run('root', 'feishu_sunke', 'ou_sunke', 1, 'ou_sunke', 'user', 'sync', null, null)
      stmt.run('bad-agent', 'bad_agent', 'ou_sunke', 1, 'ou_other', 'agent', 'sync', 'Bad Agent', 'bad-agent')
    } finally {
      db.close()
    }

    const { ownerOwnsProfile, listOwnedProfileNames, listOwnedProfileMetadata } = await loadOwnership(dbPath)

    expect(ownerOwnsProfile('ou_sunke', 'bad_agent')).toBe(false)
    expect(listOwnedProfileNames('ou_sunke')).toEqual(new Set(['feishu_sunke']))
    expect(Array.from(listOwnedProfileMetadata('ou_sunke').keys())).toEqual(['feishu_sunke'])
  })

  it('applies kind filtering even when a schema has kind but not provenance', async () => {
    const { db, dbPath } = createRoutingDb({ withKind: true })
    try {
      const stmt = db.prepare(`
        INSERT INTO multitenancy_routing
          (user_id, profile_name, open_id, active, owner_open_id, kind, display_label, agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run('root', 'feishu_sunke', 'ou_sunke', 1, 'ou_sunke', 'user', null, null)
      stmt.run('bad-agent', 'bad_agent', 'ou_sunke', 1, 'ou_other', 'agent', 'Bad Agent', 'bad-agent')
    } finally {
      db.close()
    }

    const { ownerOwnsProfile, listOwnedProfileNames, listOwnedProfileMetadata } = await loadOwnership(dbPath)

    expect(ownerOwnsProfile('ou_sunke', 'bad_agent')).toBe(false)
    expect(listOwnedProfileNames('ou_sunke')).toEqual(new Set(['feishu_sunke']))
    expect(Array.from(listOwnedProfileMetadata('ou_sunke').keys())).toEqual(['feishu_sunke'])
  })

  it('still lists owner-scoped agent child profiles through owner_open_id', async () => {
    const { db, dbPath } = createRoutingDb({ withKind: true, withProvenance: true })
    try {
      const stmt = db.prepare(`
        INSERT INTO multitenancy_routing
          (user_id, profile_name, open_id, active, owner_open_id, kind, provenance, display_label, agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run('root', 'feishu_sunke', 'ou_sunke', 1, 'ou_sunke', 'user', 'sync', null, null)
      stmt.run('webui:ou_sunke:coder', 'coder_profile', 'webui:ou_sunke:coder', 1, 'ou_sunke', 'agent', 'webui-agent', 'Coder', 'webui:ou_sunke:coder')
    } finally {
      db.close()
    }

    const { ownerOwnsProfile, listOwnedProfileNames, listOwnedProfileMetadata } = await loadOwnership(dbPath)
    const metadata = listOwnedProfileMetadata('ou_sunke')

    expect(ownerOwnsProfile('ou_sunke', 'coder_profile')).toBe(true)
    expect(listOwnedProfileNames('ou_sunke')).toEqual(new Set(['feishu_sunke', 'coder_profile']))
    expect(metadata.get('coder_profile')).toMatchObject({
      profileName: 'coder_profile',
      kind: 'agent',
      displayLabel: 'Coder',
      ownerOpenId: 'ou_sunke',
      agentId: 'webui:ou_sunke:coder',
    })
  })

  it('keeps migrated sync user rows with null kind visible', async () => {
    const { db, dbPath } = createRoutingDb({ withKind: true, withProvenance: true })
    try {
      db.prepare(`
        INSERT INTO multitenancy_routing
          (user_id, profile_name, open_id, active, owner_open_id, kind, provenance, display_label, agent_id)
        VALUES ('root', 'feishu_sunke', 'ou_sunke', 1, 'ou_sunke', NULL, 'sync', NULL, NULL)
      `).run()
    } finally {
      db.close()
    }

    const { ownerOwnsProfile, listOwnedProfileNames, listOwnedProfileMetadata } = await loadOwnership(dbPath)

    expect(ownerOwnsProfile('ou_sunke', 'feishu_sunke')).toBe(true)
    expect(listOwnedProfileNames('ou_sunke')).toEqual(new Set(['feishu_sunke']))
    expect(Array.from(listOwnedProfileMetadata('ou_sunke').keys())).toEqual(['feishu_sunke'])
  })

  it('keeps migrated sync user rows with empty kind visible', async () => {
    const { db, dbPath } = createRoutingDb({ withKind: true, withProvenance: true })
    try {
      db.prepare(`
        INSERT INTO multitenancy_routing
          (user_id, profile_name, open_id, active, owner_open_id, kind, provenance, display_label, agent_id)
        VALUES ('root', 'feishu_sunke', 'ou_sunke', 1, 'ou_sunke', '', 'sync', NULL, NULL)
      `).run()
    } finally {
      db.close()
    }

    const { ownerOwnsProfile, listOwnedProfileNames, listOwnedProfileMetadata } = await loadOwnership(dbPath)

    expect(ownerOwnsProfile('ou_sunke', 'feishu_sunke')).toBe(true)
    expect(listOwnedProfileNames('ou_sunke')).toEqual(new Set(['feishu_sunke']))
    expect(Array.from(listOwnedProfileMetadata('ou_sunke').keys())).toEqual(['feishu_sunke'])
  })
})
