import type { Context } from 'koa'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'

/**
 * Console RBAC — the parallel role layer for the /console admin plane.
 *
 * hermes-web-ui hardcodes Feishu users to `role: 'user'` (request-context.ts),
 * so the built-in superadmin is structurally dead in the Feishu plane. The
 * console therefore carries its own admin allowlist keyed on `union_id`:
 *
 *   - Every logged-in Feishu user is a **developer** (self-scoped: only sees
 *     their own agents/keys/releases). No allowlist needed — safe for all 1359.
 *   - A union_id listed in `console-admins.json` is additionally an **admin**
 *     (unlocks the ops plane). Bootstrap seeds the first admin at deploy time.
 *
 * Fail-closed: a missing / empty / malformed / non-array admins file yields
 * ZERO admins — never a fall-through to "everyone admin". Read fresh on every
 * call so deleting the file immediately drops admins back to developer (the
 * spec's hot-reload requirement; admin endpoints are low-traffic).
 */

export type ConsoleRole = 'admin' | 'developer'

function adminsFilePath(): string {
  const override = process.env.HERMES_CONSOLE_ADMINS_FILE
  if (override && override.trim()) return override
  const sharedHome = process.env.HERMES_SHARED_HOME || resolve(homedir(), '.hermes')
  return resolve(sharedHome, 'console-admins.json')
}

/** The set of admin union_ids, read fresh from disk. Fail-closed to empty. */
export function loadConsoleAdminUnionIds(): Set<string> {
  const path = adminsFilePath()
  if (!existsSync(path)) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return new Set() // malformed JSON → no admins (fail-closed)
  }
  const admins = (parsed as { admins?: unknown } | null)?.admins
  if (!Array.isArray(admins)) return new Set() // missing / non-array → no admins
  const out = new Set<string>()
  for (const entry of admins) {
    if (typeof entry !== 'string') continue // drop numbers / null / objects
    const trimmed = entry.trim()
    if (trimmed) out.add(trimmed)
  }
  return out
}

function multitenancyDbPath(): string {
  return process.env.HERMES_MULTITENANCY_DB || resolve(homedir(), '.hermes', 'multitenancy.db')
}

/**
 * Fallback: derive union_id from the routing DB when the session object didn't
 * carry one (older sessions). Read-only, best-effort — returns undefined on any
 * failure so the caller degrades to developer rather than throwing.
 */
export function resolveUnionIdForOpenId(openId: string): string | undefined {
  if (!openId) return undefined
  const dbPath = multitenancyDbPath()
  if (!existsSync(dbPath)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db
      .prepare(
        "SELECT union_id FROM multitenancy_routing WHERE open_id = ? AND kind = 'user'" +
          ' ORDER BY active DESC LIMIT 1',
      )
      .get(openId) as { union_id?: string } | undefined
    const unionId = row?.union_id
    return typeof unionId === 'string' && unionId ? unionId : undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Server-authoritative role decision. The session's union_id (or, failing that,
 * the one derived from the routing DB) must be in the admin allowlist for
 * 'admin'; everyone else is 'developer'. Never trusts client input.
 */
export function resolveConsoleRole(ctx: Context): ConsoleRole {
  const user = (ctx?.state?.user ?? null) as { openid?: string; unionId?: string } | null
  if (!user) return 'developer'
  const unionId =
    (typeof user.unionId === 'string' && user.unionId ? user.unionId : undefined) ??
    (user.openid ? resolveUnionIdForOpenId(user.openid) : undefined)
  if (!unionId) return 'developer'
  return loadConsoleAdminUnionIds().has(unionId) ? 'admin' : 'developer'
}
