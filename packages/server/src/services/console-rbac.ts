import type { Context } from 'koa'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { candidateMultitenancyDbs } from './request-context'

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

/**
 * Fallback: derive union_id from the routing DB when the session object didn't
 * carry one (the trusted-header Feishu path never puts unionId on the session,
 * so this is the COMMON path in prod, not an edge case). Read-only, best-effort.
 *
 * Mirrors the proven resolveProfileForOpenId (request-context.ts): tries every
 * candidate DB (multitenancy.db AND multitenancy_routing.db), and tolerates
 * NULL/empty `kind` rows — prod routing rows may carry NULL kind for real users,
 * and a strict `kind = 'user'` here would silently demote a seeded admin to
 * developer and 404 the whole ops plane. Same DB list, same kind tolerance.
 */
// openid → union_id is immutable per user, so memoize SUCCESSFUL resolutions —
// without this, trusted-header sessions (which never carry unionId) would open+
// query+close a sqlite DB synchronously on EVERY /api/auth/me (DatabaseSync
// blocks the event loop). We do NOT negative-cache `undefined`: a NULL/unsynced
// union_id, a transient DB lock, or a later backfill must be re-queried, else a
// seeded admin whose row lacked union_id at first touch would stay 'developer'
// until process restart. Only positive hits are cached; a cap bounds memory.
const _unionIdCache = new Map<string, string>()
const _UNION_CACHE_CAP = 5000

export function resolveUnionIdForOpenId(openId: string): string | undefined {
  if (!openId) return undefined
  const cached = _unionIdCache.get(openId)
  if (cached !== undefined) return cached
  const resolved = _resolveUnionIdUncached(openId)
  if (resolved !== undefined) {
    if (_unionIdCache.size >= _UNION_CACHE_CAP) _unionIdCache.clear() // simple bound; re-warms lazily
    _unionIdCache.set(openId, resolved)
  }
  return resolved
}

function _resolveUnionIdUncached(openId: string): string | undefined {
  for (const dbPath of candidateMultitenancyDbs()) {
    try {
      if (!existsSync(dbPath) || statSync(dbPath).size === 0) continue
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const columns = new Set(
          (db.prepare('PRAGMA table_info(multitenancy_routing)').all() as Array<{ name: string }>).map(
            (c) => c.name,
          ),
        )
        if (!columns.has('union_id') || !columns.has('open_id')) continue
        // Mirror resolveProfileForOpenId (request-context.ts) so both resolvers
        // pick the SAME row: active=1, provenance='sync', kind-priority ordering.
        // Plus union_id IS NOT NULL — we SELECT union_id, and without this a NULL
        // union_id row (SQLite sorts NULLs first) would be picked and rejected,
        // returning undefined and demoting a seeded admin. (Kept in sync by hand;
        // a shared helper is a deferred cleanup — see NOTE.)
        const predicates = ['open_id = ?', 'union_id IS NOT NULL']
        if (columns.has('active')) predicates.push('active = 1')
        if (columns.has('provenance')) predicates.push("provenance = 'sync'")
        if (columns.has('kind')) predicates.push("(kind = 'user' OR kind IS NULL OR kind = '')")
        const orderBy = columns.has('kind')
          ? "CASE WHEN kind = 'user' THEN 0 WHEN kind IS NULL OR kind = '' THEN 1 ELSE 2 END, union_id"
          : 'union_id'
        const row = db
          .prepare(
            `SELECT union_id FROM multitenancy_routing WHERE ${predicates.join(' AND ')}` +
              ` ORDER BY ${orderBy} LIMIT 1`,
          )
          .get(openId) as { union_id?: string } | undefined
        const unionId = row?.union_id
        if (typeof unionId === 'string' && unionId.trim()) return unionId.trim()
      } finally {
        db.close()
      }
    } catch {
      // try the next candidate DB
    }
  }
  return undefined
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
