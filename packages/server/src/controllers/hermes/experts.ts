import type { Context } from 'koa'
import { logger } from '../../services/logger'
import { getRequestProfile } from '../../services/request-context'
import {
  fetchExpertCatalog,
  emptyCatalog,
} from '../../services/hermes/expert-registry-client'

interface WebUser {
  openid?: string
  profile?: string
}

/**
 * GET /api/hermes/experts — proxy the expert catalog from the Run Broker.
 *
 * Mirrors the skills/connectors BFF pattern. Profile is resolved through the
 * shared request-context (chat-plane isolation honoured). When the broker is
 * unavailable the catalog is served EMPTY — never a fabricated expert.
 */
export async function list(ctx: Context): Promise<void> {
  const profileName = getRequestProfile(ctx)
  const user = ctx.state?.user as WebUser | undefined
  try {
    ctx.body = await fetchExpertCatalog({ profileName, userKey: user?.openid })
  } catch (err: any) {
    logger.warn(
      { profile: profileName, err: err?.message || String(err) },
      'Expert broker unavailable; serving empty catalog',
    )
    ctx.body = emptyCatalog(profileName)
  }
}
