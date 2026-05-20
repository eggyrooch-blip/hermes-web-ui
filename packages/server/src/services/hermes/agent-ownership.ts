/**
 * US-07 ownership: a Feishu user may only attach profiles they own.
 * Older multitenancy DBs may lack owner_open_id/provenance, so ownership
 * detection must drop missing-column predicates instead of throwing.
 */

import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../../config'

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function candidateMultitenancyDbs(): string[] {
    const configured = config.multitenancyDb
    const base = resolve(homedir(), '.hermes')
    return Array.from(new Set([
        configured,
        resolve(base, 'multitenancy.db'),
        resolve(base, 'multitenancy_routing.db'),
    ].filter(isNonEmptyString)))
}

export function ownerOwnsProfile(openid: string, profileName: string): boolean {
    if (!isNonEmptyString(openid) || !isNonEmptyString(profileName)) return false

    const normalizedOpenid = openid.trim()
    const normalizedProfileName = profileName.trim()

    for (const dbPath of candidateMultitenancyDbs()) {
        try {
            if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
                const columns = new Set((db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(column => column.name))
                const disjuncts: string[] = []
                const params: string[] = [normalizedProfileName]

                if (columns.has('owner_open_id')) {
                    disjuncts.push('owner_open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (columns.has('provenance')) {
                    disjuncts.push("(open_id = ? AND provenance = 'sync')")
                    params.push(normalizedOpenid)
                } else {
                    disjuncts.push('open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (disjuncts.length === 0) return false

                const row = db.prepare(
                    `SELECT 1
                     FROM multitenancy_routing
                     WHERE profile_name = ?
                       AND active = 1
                       AND (${disjuncts.join(' OR ')})
                     LIMIT 1`
                ).get(...params)

                if (row) return true
            } finally {
                db.close()
            }
        } catch {
            // Try the next candidate DB.
        }
    }

    return false
}

export function listOwnedProfileNames(openid: string): Set<string> {
    const owned = new Set<string>()
    if (!isNonEmptyString(openid)) return owned

    const normalizedOpenid = openid.trim()

    for (const dbPath of candidateMultitenancyDbs()) {
        try {
            if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
                const columns = new Set((db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(column => column.name))
                const disjuncts: string[] = []
                const params: string[] = []

                if (columns.has('owner_open_id')) {
                    disjuncts.push('owner_open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (columns.has('provenance')) {
                    disjuncts.push("(open_id = ? AND provenance = 'sync')")
                    params.push(normalizedOpenid)
                } else {
                    disjuncts.push('open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (disjuncts.length === 0) continue

                const rows = db.prepare(
                    `SELECT profile_name
                     FROM multitenancy_routing
                     WHERE active = 1
                       AND (${disjuncts.join(' OR ')})`
                ).all(...params) as Array<{ profile_name?: string }>

                for (const row of rows) {
                    if (isNonEmptyString(row.profile_name)) owned.add(row.profile_name.trim())
                }
            } finally {
                db.close()
            }
        } catch {
            // Try the next candidate DB.
        }
    }

    return owned
}

export type OwnedProfileMetadata = {
    profileName: string
    kind?: string
    displayLabel?: string
    ownerOpenId?: string
    agentId?: string
}

export function listOwnedProfileMetadata(openid: string): Map<string, OwnedProfileMetadata> {
    const profiles = new Map<string, OwnedProfileMetadata>()
    if (!isNonEmptyString(openid)) return profiles

    const normalizedOpenid = openid.trim()

    for (const dbPath of candidateMultitenancyDbs()) {
        try {
            if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
                const columns = new Set((db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(column => column.name))
                const disjuncts: string[] = []
                const params: string[] = []

                if (columns.has('owner_open_id')) {
                    disjuncts.push('owner_open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (columns.has('provenance')) {
                    disjuncts.push("(open_id = ? AND provenance = 'sync')")
                    params.push(normalizedOpenid)
                } else {
                    disjuncts.push('open_id = ?')
                    params.push(normalizedOpenid)
                }

                if (disjuncts.length === 0) continue

                const selectColumns = [
                    'profile_name',
                    columns.has('kind') ? 'kind' : 'NULL AS kind',
                    columns.has('display_label') ? 'display_label' : 'NULL AS display_label',
                    columns.has('owner_open_id') ? 'owner_open_id' : 'NULL AS owner_open_id',
                    columns.has('agent_id') ? 'agent_id' : 'NULL AS agent_id',
                ]
                const rows = db.prepare(
                    `SELECT ${selectColumns.join(', ')}
                     FROM multitenancy_routing
                     WHERE active = 1
                       AND (${disjuncts.join(' OR ')})`
                ).all(...params) as Array<{ profile_name?: string; kind?: string; display_label?: string; owner_open_id?: string; agent_id?: string }>

                for (const row of rows) {
                    if (!isNonEmptyString(row.profile_name)) continue
                    profiles.set(row.profile_name.trim(), {
                        profileName: row.profile_name.trim(),
                        ...(isNonEmptyString(row.kind) ? { kind: row.kind.trim() } : {}),
                        ...(isNonEmptyString(row.display_label) ? { displayLabel: row.display_label.trim() } : {}),
                        ...(isNonEmptyString(row.owner_open_id) ? { ownerOpenId: row.owner_open_id.trim() } : {}),
                        ...(isNonEmptyString(row.agent_id) ? { agentId: row.agent_id.trim() } : {}),
                    })
                }
            } finally {
                db.close()
            }
        } catch {
            // Try the next candidate DB.
        }
    }

    return profiles
}

export function resolveOwnedProfileAgentId(openid: string, profileName: string): string | undefined {
    if (!isNonEmptyString(openid) || !isNonEmptyString(profileName)) return undefined
    return listOwnedProfileMetadata(openid).get(profileName.trim())?.agentId
}

export function registerOwnedProfile(openid: string, profileName: string, upstreamProfile?: string): boolean {
    if (!isNonEmptyString(openid) || !isNonEmptyString(profileName)) return false

    const normalizedOpenid = openid.trim()
    const normalizedProfileName = profileName.trim()
    const normalizedUpstream = isNonEmptyString(upstreamProfile) ? upstreamProfile.trim() : null

    for (const dbPath of candidateMultitenancyDbs()) {
        try {
            if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
            const db = new DatabaseSync(dbPath)
            try {
                const columns = new Set((db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(column => column.name))
                if (!columns.has('user_id') || !columns.has('profile_name') || !columns.has('open_id')) continue

                const now = Date.now()
                const userId = `webui:${normalizedOpenid}:${normalizedProfileName}`
                const values = new Map<string, string | number | null>([
                    ['user_id', userId],
                    ['profile_name', normalizedProfileName],
                    ['open_id', normalizedOpenid],
                ])
                if (columns.has('active')) values.set('active', 1)
                if (columns.has('owner_open_id')) values.set('owner_open_id', normalizedOpenid)
                if (columns.has('kind')) values.set('kind', 'agent')
                if (columns.has('provenance')) values.set('provenance', 'webui-agent')
                if (columns.has('display_label')) values.set('display_label', normalizedProfileName)
                if (columns.has('upstream_profile')) values.set('upstream_profile', normalizedUpstream)
                if (columns.has('synced_at')) values.set('synced_at', now)
                if (columns.has('version')) values.set('version', 1)
                if (columns.has('created_at')) values.set('created_at', now)
                if (columns.has('updated_at')) values.set('updated_at', now)
                if (columns.has('deleted_at')) values.set('deleted_at', null)

                const insertColumns = Array.from(values.keys()).filter(column => columns.has(column))
                const placeholders = insertColumns.map(() => '?').join(', ')
                const updateColumns = insertColumns.filter(column => column !== 'user_id' && column !== 'created_at')
                const updates = updateColumns.map(column => `${column} = excluded.${column}`).join(', ')
                const sql = `INSERT INTO multitenancy_routing (${insertColumns.join(', ')}) VALUES (${placeholders})
                             ON CONFLICT(user_id) DO UPDATE SET ${updates}`
                db.prepare(sql).run(...insertColumns.map(column => values.get(column) ?? null))
                return true
            } finally {
                db.close()
            }
        } catch {
            // Try the next candidate DB.
        }
    }

    return false
}
