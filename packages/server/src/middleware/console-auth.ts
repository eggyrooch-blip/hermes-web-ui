import type { Context, Next } from 'koa'
import { resolveConsoleRole } from '../services/console-rbac'

/**
 * Console auth middleware.
 *
 * CRITICAL (design §8c A1): the webui chat-plane blocklist (`forbiddenInChatPlane`)
 * only guards `/api/hermes/*`. A fresh `/api/console/*` prefix defaults to ALLOWED
 * for every logged-in user, so authorization CANNOT rest on the plane gate — it
 * MUST live here, on the route. Two guards for the two planes:
 *
 *   - requireConsoleUser  — developer plane: any logged-in Feishu user. Handlers
 *     stay self-scoped (owner derived from the session, never the client).
 *   - requireConsoleAdmin — ops plane: union_id must be in console-admins.json.
 *     Non-admins get 404 (not 403) so the ops surface is invisible to them.
 */

export async function requireConsoleUser(ctx: Context, next: Next): Promise<void> {
  const openid = (ctx.state?.user as { openid?: string } | undefined)?.openid
  if (!openid) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  await next()
}

export async function requireConsoleAdmin(ctx: Context, next: Next): Promise<void> {
  const openid = (ctx.state?.user as { openid?: string } | undefined)?.openid
  if (!openid) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  if (resolveConsoleRole(ctx) !== 'admin') {
    ctx.status = 404 // hide the ops plane's existence from non-admins
    ctx.body = { error: 'Not found' }
    return
  }
  await next()
}
