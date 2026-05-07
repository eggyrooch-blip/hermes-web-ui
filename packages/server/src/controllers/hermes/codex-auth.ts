import { randomBytes, randomUUID } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { logger } from '../../services/logger'

// --- OAuth Constants ---
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_DEVICE_AUTH_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const CODEX_VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const CODEX_HOME = join(homedir(), '.codex')
const POLL_MAX_DURATION = 15 * 60 * 1000
const POLL_DEFAULT_INTERVAL = 5000

// --- Session Store ---
interface CodexSession {
  id: string; userCode: string; deviceAuthId: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  error?: string; accessToken?: string; refreshToken?: string; createdAt: number
  /** Stable identity of the caller that started this device flow.
   *  Used to gate poll() so a session id leak does not let a different
   *  caller observe the login state of someone else. */
  ownerPrincipal: string
}

const sessions = new Map<string, CodexSession>()

function cleanupExpiredSessions() {
  const now = Date.now()
  sessions.forEach((session, id) => { if (now - session.createdAt > POLL_MAX_DURATION + 60000) { sessions.delete(id) } })
}

// Periodic cleanup so abandoned sessions don't accumulate even when no
// new login starts. (Previously cleanupExpiredSessions only ran inside start().)
setInterval(cleanupExpiredSessions, 5 * 60 * 1000).unref?.()

/**
 * Derive a stable principal for the current request. We don't expose the raw
 * Bearer token; a short HMAC-style suffix is enough to bind a session to its
 * caller. For Feishu modes we use the openid that already lives on ctx.state.user.
 */
function getCallerPrincipal(ctx: any): string {
  const user = ctx?.state?.user
  if (user?.openid) return `feishu:${user.openid}`
  const auth = (ctx?.headers?.authorization || '') as string
  if (auth.startsWith('Bearer ')) return `token:${auth.slice(-8)}`
  const queryToken = ctx?.query?.token
  if (typeof queryToken === 'string' && queryToken) return `token:${queryToken.slice(-8)}`
  // Fall back to the remote address; better than nothing if auth is disabled.
  return `addr:${ctx?.ip || 'unknown'}`
}

// --- Auth file helpers ---
interface AuthJson { version?: number; active_provider?: string; providers?: Record<string, any>; credential_pool?: Record<string, any[]>; updated_at?: string }

function loadAuthJson(authPath: string): AuthJson {
  try { return JSON.parse(readFileSync(authPath, 'utf-8')) as AuthJson } catch { return { version: 1 } }
}

/**
 * Atomic write: stage the new bytes in a sibling temp file with the right
 * mode, then rename onto the target. A crash between `writeFileSync` and
 * `renameSync` leaves the original auth.json intact instead of half-written.
 */
function atomicWriteFile(targetPath: string, content: string, mode = 0o600): void {
  const dir = targetPath.substring(0, targetPath.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = `${targetPath}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, content, { mode })
    renameSync(tmpPath, targetPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* tmp may already be gone */ }
    throw err
  }
}

function saveAuthJson(authPath: string, data: AuthJson): void {
  data.updated_at = new Date().toISOString()
  atomicWriteFile(authPath, JSON.stringify(data, null, 2) + '\n')
}

function saveCodexCliTokens(accessToken: string, refreshToken: string): void {
  const codexHome = process.env.CODEX_HOME || CODEX_HOME
  const codexAuthPath = join(codexHome, 'auth.json')
  const payload = JSON.stringify({ tokens: { access_token: accessToken, refresh_token: refreshToken }, last_refresh: new Date().toISOString() }, null, 2) + '\n'
  atomicWriteFile(codexAuthPath, payload)
}

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    const claims = JSON.parse(payload)
    return typeof claims.exp === 'number' ? claims.exp : null
  } catch { return null }
}

// --- Background login worker ---
async function codexLoginWorker(session: CodexSession, authPath: string): Promise<void> {
  const startTime = Date.now()
  const interval = POLL_DEFAULT_INTERVAL
  while (Date.now() - startTime < POLL_MAX_DURATION) {
    await new Promise(resolve => setTimeout(resolve, interval))
    if (session.status !== 'pending') return
    try {
      const pollRes = await fetch(CODEX_DEVICE_TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
        signal: AbortSignal.timeout(10000),
      })
      if (pollRes.status === 200) {
        const pollData = await pollRes.json() as { authorization_code: string; code_verifier: string }
        const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: pollData.authorization_code, redirect_uri: CODEX_REDIRECT_URI, client_id: CODEX_CLIENT_ID, code_verifier: pollData.code_verifier }).toString(),
          signal: AbortSignal.timeout(15000),
        })
        if (!tokenRes.ok) { const errText = await tokenRes.text(); logger.error('Token exchange failed: %d %s', tokenRes.status, errText); session.status = 'error'; session.error = `Token exchange failed: ${tokenRes.status}`; return }
        const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string }
        const refreshToken = tokenData.refresh_token || ''
        session.accessToken = tokenData.access_token; session.refreshToken = refreshToken; session.status = 'approved'
        const auth = loadAuthJson(authPath)
        if (!auth.providers) auth.providers = {}
        auth.providers['openai-codex'] = { tokens: { access_token: tokenData.access_token, refresh_token: refreshToken }, last_refresh: new Date().toISOString(), auth_mode: 'chatgpt' }
        if (!auth.credential_pool) auth.credential_pool = {}
        auth.credential_pool['openai-codex'] = [{ id: `openai-codex-${Date.now()}`, label: 'OpenAI Codex', base_url: CODEX_DEFAULT_BASE_URL, access_token: tokenData.access_token, last_status: null }]
        saveAuthJson(authPath, auth)
        saveCodexCliTokens(tokenData.access_token, refreshToken)
        logger.info('Login successful')
        return
      }
      if (pollRes.status === 403 || pollRes.status === 404) { continue }
      logger.error('Poll failed: %d', pollRes.status); session.status = 'error'; session.error = `Poll failed: ${pollRes.status}`; return
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') { continue }
      logger.error(err, 'Poll error'); session.status = 'error'; session.error = err.message; return
    }
  }
  session.status = 'expired'
}

// --- Controller functions ---

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const res = await fetch(CODEX_DEVICE_AUTH_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'node-fetch' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }), signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      let errorBody: any = null; try { errorBody = await res.json() } catch { }
      logger.error('Device code request failed: %d %s', res.status, errorBody)
      let errorMessage = `Device code request failed: ${res.status}`
      if (errorBody?.error?.code === 'unsupported_country_region_territory') { errorMessage = 'OpenAI does not support your region. You may need to use a proxy or VPN to access Codex.' }
      ctx.status = 502; ctx.body = { error: errorMessage, code: errorBody?.error?.code }; return
    }
    const data = await res.json() as { user_code: string; device_auth_id: string; interval?: string }
    const sessionId = randomUUID()
    const session: CodexSession = {
      id: sessionId,
      userCode: data.user_code,
      deviceAuthId: data.device_auth_id,
      status: 'pending',
      createdAt: Date.now(),
      ownerPrincipal: getCallerPrincipal(ctx),
    }
    sessions.set(sessionId, session)
    const authPath = getActiveAuthPath()
    codexLoginWorker(session, authPath).catch(err => { logger.error(err, 'Worker error'); session.status = 'error'; session.error = err.message })
    ctx.body = { session_id: sessionId, user_code: data.user_code, verification_url: CODEX_VERIFICATION_URL, expires_in: 900 }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function poll(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return }
  // SECURITY: only the principal that created the session may observe its
  // status. Returning 404 for foreign callers (rather than 403) avoids
  // leaking that a session id is valid.
  if (session.ownerPrincipal !== getCallerPrincipal(ctx)) {
    ctx.status = 404; ctx.body = { error: 'Session not found' }; return
  }
  ctx.body = { status: session.status, error: session.error || null }
}

export async function status(ctx: any) {
  try {
    const authPath = getActiveAuthPath()
    const auth = loadAuthJson(authPath)
    const tokens = auth.providers?.['openai-codex']?.tokens
    if (!tokens?.access_token || !auth.providers) { ctx.body = { authenticated: false }; return }
    const codexProvider = auth.providers['openai-codex']!
    const exp = decodeJwtExp(tokens.access_token)
    if (exp && exp <= Date.now() / 1000 + 120) {
      if (tokens.refresh_token) {
        try {
          const refreshRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CODEX_CLIENT_ID }).toString(),
            signal: AbortSignal.timeout(15000),
          })
          if (refreshRes.ok) {
            const newTokens = await refreshRes.json() as { access_token: string; refresh_token?: string }
            codexProvider.tokens.access_token = newTokens.access_token
            if (newTokens.refresh_token) { codexProvider.tokens.refresh_token = newTokens.refresh_token }
            codexProvider.last_refresh = new Date().toISOString()
            saveAuthJson(authPath, auth)
            saveCodexCliTokens(newTokens.access_token, newTokens.refresh_token || tokens.refresh_token)
            if (auth.credential_pool?.['openai-codex']?.[0]) { auth.credential_pool['openai-codex'][0].access_token = newTokens.access_token; saveAuthJson(authPath, auth) }
            ctx.body = { authenticated: true, last_refresh: codexProvider.last_refresh }; return
          }
        } catch { }
      }
      ctx.body = { authenticated: false }; return
    }
    ctx.body = { authenticated: true, last_refresh: codexProvider.last_refresh }
  } catch { ctx.body = { authenticated: false } }
}
