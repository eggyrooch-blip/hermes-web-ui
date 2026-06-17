/**
 * Feishu → user-store compatibility plane.
 *
 * Upstream multi-tenant controllers (kanban / group-chat / jobs / files /
 * user-mode …) enforce isolation off `ctx.state.user.id` +
 * `listUserProfiles(user.id)` from db/hermes/users-store. Our Feishu auth, by
 * contrast, produces a `WebUser` keyed on `{ openid, profile }` with NO `.id`,
 * so those controllers would call `listUserProfiles(undefined)` and the
 * isolation collapses.
 *
 * `ensureWebUserForFeishu` bridges the gap: it idempotently upserts a synthetic
 * user-store row for the Feishu identity and re-syncs that row's owned profiles
 * from the multitenancy DB, then returns a real `AuthenticatedUser` (with a true
 * numeric `.id`). Upstream controllers stay untouched — they just see a normal
 * user-store user whose profile set is the Feishu owner's owned profiles.
 *
 * Synthetic users authenticate ONLY via the signed Feishu session cookie; the
 * random password they carry is never used for password login.
 */

import { randomUUID } from 'crypto'
import {
  createUser,
  findUserByUsername,
  replaceUserProfiles,
  type UserRole,
} from '../db/hermes/users-store'
import { toAuthenticatedUser, type AuthenticatedUser } from '../middleware/user-auth'
import { listOwnedProfileNames } from './hermes/agent-ownership'
import { resolveProfileForOpenId } from './request-context'

/** Username namespace for synthetic Feishu-backed user-store rows. */
export function feishuUsernameForOpenId(openid: string): string {
  return `feishu:${openid}`
}

/**
 * Idempotently bridge a Feishu identity into the upstream user-store and return
 * an `AuthenticatedUser` carrying a real numeric `.id`.
 *
 * Repeated logins only upsert the user row + re-sync its owned profiles; no
 * duplicate users are ever created (findUserByUsername short-circuits create).
 */
export function ensureWebUserForFeishu(
  openid: string,
  _metadata?: { name?: string; avatarUrl?: string },
): AuthenticatedUser {
  const username = feishuUsernameForOpenId(openid)

  // 1. Upsert the synthetic user-store row (random password — never used for
  //    password login; these users authenticate via the Feishu session cookie).
  const user =
    findUserByUsername(username) ??
    createUser({
      username,
      password: randomUUID(),
      // The user-store `role` column is free-text; 'user' is the fork's canonical
      // non-privileged role. Any non-'super_admin' role keeps isolation enforced
      // (toAuthenticatedUser + resolveUserProfile scope by profile for these),
      // which is exactly what these synthetic Feishu users need.
      role: 'user' as UserRole,
      status: 'active',
    })

  if (!user) {
    // createUser only returns null when the user-store DB is unavailable
    // (getDb() === null). The server initializes all stores at boot, so this is
    // a hard environment fault — fail closed rather than hand back an id-less
    // user that would silently defeat the isolation this bridge exists to keep.
    throw new Error(`ensureWebUserForFeishu: user-store unavailable for ${username}`)
  }

  // 2. Re-sync the owned profile set from the multitenancy DB on every login so
  //    profile ownership changes propagate without a manual rebind.
  const owned = [...listOwnedProfileNames(openid)]
  const defaultProfile = resolveProfileForOpenId(openid) ?? undefined
  replaceUserProfiles(user.id, owned, defaultProfile)

  // 3. Hand back a real AuthenticatedUser (toAuthenticatedUser re-reads the
  //    freshly-synced profiles for non-super-admin roles).
  return toAuthenticatedUser(user)
}
