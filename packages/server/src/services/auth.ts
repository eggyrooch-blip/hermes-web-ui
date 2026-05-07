import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { homedir } from 'os'
import { config, isAuthDisabled } from '../config'
import { trustedFeishuAuth } from './request-context'
import { feishuOAuthAuth } from './feishu-oauth'

const APP_HOME = join(homedir(), '.hermes-web-ui')
const TOKEN_FILE = join(APP_HOME, '.token')

/**
 * Name of the HttpOnly session cookie set by /api/auth/login.
 * Verified by requireAuth() before the bearer-token fallback. Browsers that
 * support cookies cannot read this from JS, which closes the localStorage
 * exfiltration vector that XSS would otherwise have.
 */
export const HERMES_SESSION_COOKIE = 'hermes_session'
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Get or create the auth token. Returns null if auth is disabled.
 */
export async function getToken(): Promise<string | null> {
  if (config.authMode === 'trusted-feishu' || config.authMode === 'feishu-oauth-dev') {
    return null
  }

  if (isAuthDisabled()) {
    return null
  }

  if (process.env.AUTH_TOKEN) {
    return process.env.AUTH_TOKEN
  }

  try {
    const token = await readFile(TOKEN_FILE, 'utf-8')
    return token.trim()
  } catch {
    const token = generateToken()
    await mkdir(APP_HOME, { recursive: true })
    await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 })
    return token
  }
}

/**
 * Koa middleware: check Authorization header or query token.
 * No path whitelisting — applied globally after public routes.
 */
export function requireAuth(token: string | null) {
  return async (ctx: any, next: () => Promise<void>) => {
    if (config.authMode === 'trusted-feishu') {
      await trustedFeishuAuth(ctx, next)
      return
    }
    if (config.authMode === 'feishu-oauth-dev') {
      await feishuOAuthAuth(ctx, next)
      return
    }

    if (!token) {
      await next()
      return
    }

    const auth = ctx.headers.authorization || ''
    // Auth source priority: HttpOnly cookie (preferred) → Bearer header →
    // ?token= query (DEPRECATED, kept for <img src>/<a href> downloads until
    // v0.7.0). The pino redact config in services/logger.ts strips the query
    // form from log entries; see Plans/token-cookie-migration.md for the
    // long-term plan that retires Bearer + query entirely.
    const cookieValue = ctx.cookies?.get?.(HERMES_SESSION_COOKIE) || ''
    const headerValue = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const provided = cookieValue || headerValue || (ctx.query.token as string) || ''

    // Constant-time comparison so attackers cannot probe the token by timing
    // a fast-failing `===`. Mismatched length short-circuits before the buffer
    // compare to avoid throwing on Buffer.from of unequal sizes.
    const providedBuf = Buffer.from(provided)
    const tokenBuf = Buffer.from(token)
    const isAuthed =
      provided.length > 0 &&
      providedBuf.length === tokenBuf.length &&
      timingSafeEqual(providedBuf, tokenBuf)

    if (!isAuthed) {
      // Skip auth for non-API paths (SPA static files)
      const lowerPath = ctx.path.toLowerCase()
      if (!lowerPath.startsWith('/api') && !lowerPath.startsWith('/v1') && !lowerPath.startsWith('/upload')) {
        await next()
        return
      }
      ctx.status = 401
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: 'Unauthorized' }
      return
    }

    await next()
  }
}
