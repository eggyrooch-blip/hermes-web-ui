import type { Context } from 'koa'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { updateUsage } from '../../db/hermes/usage-store'
import { getRequestProfile, isChatPlaneRequest, type WebUser } from '../../services/request-context'
import { isAllowedUpstreamHost } from '../../services/hermes/gateway-manager'
import { logger } from '../../services/logger'

function getGatewayManager() { return getGatewayManagerInstance() }

// --- run_id → session_id mapping (in-memory, ephemeral) ---

const runSessionMap = new Map<string, string>()

export function setRunSession(runId: string, sessionId: string): void {
  runSessionMap.set(runId, sessionId)
  // Auto-cleanup after 30 minutes
  setTimeout(() => runSessionMap.delete(runId), 30 * 60 * 1000)
}

export function getSessionForRun(runId: string): string | undefined {
  return runSessionMap.get(runId)
}

// --- Helpers ---

function isTransientGatewayError(err: any): boolean {
  const msg = String(err?.message || '')
  const causeCode = String(err?.cause?.code || '')
  return (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  )
}

async function waitForGatewayReady(upstream: string, timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${upstream}/health`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(1200),
      })
      if (res.ok) return true
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/** Resolve profile name from request */
function resolveProfile(ctx: Context): string {
  return getRequestProfile(ctx)
}

/** Resolve upstream URL for a request based on profile header/query.
 *
 * SECURITY: defence-in-depth check. The primary SSRF gate lives in
 * gateway-manager.readProfilePort() — it filters out non-allowlisted hosts
 * before the URL ever reaches us. We re-parse the URL here and reject again,
 * so a future code path that builds upstreams differently still fails closed.
 */
function resolveUpstream(ctx: Context): string {
  const mgr = getGatewayManager()
  if (!mgr) {
    throw new Error('GatewayManager not initialized')
  }
  const profile = resolveProfile(ctx)
  const raw = profile && profile !== 'default' ? mgr.getUpstream(profile) : mgr.getUpstream()
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    throw new Error('Invalid upstream URL')
  }
  if (!isAllowedUpstreamHost(host)) {
    logger.warn('Rejecting upstream %s: host not in allowlist', raw)
    throw new Error('Upstream host is not allowed')
  }
  return raw
}

function buildProxyHeaders(ctx: Context, upstream: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (value == null) continue
    const lower = key.toLowerCase()
    if (lower === 'host') {
      headers['host'] = new URL(upstream).host
    } else if (
      lower === 'origin' ||
      lower === 'referer' ||
      lower === 'connection' ||
      lower === 'authorization' ||
      lower === 'x-hermes-feishu-openid'
    ) {
      continue
    } else {
      const v = Array.isArray(value) ? value[0] : value
      if (v) headers[key] = v
    }
  }

  const mgr = getGatewayManager()
  if (mgr) {
    const apiKey = mgr.getApiKey(resolveProfile(ctx))
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`
    }
  }

  if (isChatPlaneRequest(ctx)) {
    const user = ctx.state?.user as WebUser | undefined
    const openid = user?.openid?.trim()
    if (openid) headers['X-Hermes-Feishu-OpenId'] = openid
  }

  return headers
}

// --- SSE stream interception ---

const SSE_EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/

// RFC 7230 §6.1 — these headers are scoped to a single hop and must not be
// forwarded between upstream and downstream connections.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/**
 * Parse SSE text chunks and extract run.completed events.
 * Returns the run_id if a run.completed was found.
 */
function extractRunCompletedFromChunk(chunk: string, profile: string): string | null {
  // SSE format: each line is "data: {...}\n\n"
  const lines = chunk.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data.event === 'run.completed' && data.usage && data.run_id) {
        const sessionId = getSessionForRun(data.run_id)
        if (sessionId) {
          updateUsage(sessionId, {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            cacheReadTokens: data.usage.cache_read_tokens,
            cacheWriteTokens: data.usage.cache_write_tokens,
            reasoningTokens: data.usage.reasoning_tokens,
            model: data.model || '',
            profile,
          })
          return data.run_id
        }
      }
    } catch { /* not JSON, skip */ }
  }
  return null
}

/**
 * Stream an SSE response while intercepting run.completed events.
 */
async function streamSSE(ctx: Context, res: Response, profile: string): Promise<void> {
  if (!res.body) {
    ctx.res.end()
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // Forward raw bytes to client immediately
      ctx.res.write(value)

      // Also decode for interception
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE lines (delimited by double newline)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)
        extractRunCompletedFromChunk(eventBlock, profile)
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      extractRunCompletedFromChunk(buffer, profile)
    }
  } finally {
    ctx.res.end()
  }
}

// --- Main proxy function ---

export async function proxy(ctx: Context) {
  const profile = resolveProfile(ctx)
  let upstream: string
  try {
    upstream = resolveUpstream(ctx)
  } catch (e: any) {
    ctx.status = 503
    ctx.body = { error: { message: e?.message || 'GatewayManager not initialized' } }
    return
  }
  const upstreamPath = ctx.path.replace(/^\/api\/hermes\/v1/, '/v1').replace(/^\/api\/hermes/, '/api')
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildProxyHeaders(ctx, upstream)

  // SECURITY: cap proxy waits so a stuck or slow upstream cannot tie up BFF
  // sockets indefinitely. SSE streams (chat events) intentionally use a much
  // longer ceiling because a model run can legitimately take several minutes;
  // every other endpoint has 120 s.
  const isSSE = SSE_EVENTS_PATH.test(upstreamPath)
  const timeoutMs = isSSE ? 30 * 60 * 1000 : 120 * 1000

  // Propagate client disconnect to the upstream fetch. Without this the BFF
  // keeps reading the upstream stream (and the upstream keeps generating —
  // burning model tokens) after the user closes their tab.
  const clientAbort = new AbortController()
  const onClientClose = () => clientAbort.abort()
  ctx.res.on('close', onClientClose)

  const buildSignal = () => AbortSignal.any([clientAbort.signal, AbortSignal.timeout(timeoutMs)])

  try {
    let body: string | undefined
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      // @koa/bodyparser parses JSON into ctx.request.body but doesn't store rawBody
      // by default. Re-serialize the parsed body to get the string form.
      const parsed = (ctx as any).request.body
      if (typeof parsed === 'string') {
        body = parsed
      } else if (parsed && typeof parsed === 'object') {
        body = JSON.stringify(parsed)
      }
    }

    const requestInit: RequestInit = {
      method: ctx.req.method,
      headers,
      body,
      signal: buildSignal(),
    }

    let res: Response
    try {
      res = await fetch(url, requestInit)
    } catch (err: any) {
      if (isTransientGatewayError(err) && await waitForGatewayReady(upstream)) {
        // Retry uses a fresh signal so the previous timeout doesn't carry over.
        res = await fetch(url, { ...requestInit, signal: buildSignal() })
      } else {
        throw err
      }
    }

    // Set response headers — strip the full RFC 7230 hop-by-hop set so upstream
    // keep-alive / proxy-auth semantics do not bleed into the client connection.
    res.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        ctx.set(key, value)
      }
    })
    ctx.status = res.status

    // Intercept POST /v1/runs to capture run_id → session_id mapping
    if (ctx.req.method === 'POST' && /\/v1\/runs$/.test(upstreamPath) && body) {
      try {
        const parsed = JSON.parse(body)
        if (parsed.session_id) {
          const resBody = await res.text()
          ctx.res.write(resBody)
          ctx.res.end()

          try {
            const result = JSON.parse(resBody)
            if (result.run_id) {
              setRunSession(result.run_id, parsed.session_id)
            }
          } catch { /* response not JSON, ignore */ }
          return
        }
      } catch { /* body not JSON, fall through to normal stream */ }
      // No session_id in body — fall through to normal response handling below
    }

    // Intercept SSE streams for /v1/runs/{id}/events
    const sseMatch = upstreamPath.match(SSE_EVENTS_PATH)
    if (sseMatch) {
      await streamSSE(ctx, res, profile)
      return
    }

    // Default: pipe response body directly
    if (res.body) {
      const reader = res.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          ctx.res.write(value)
        }
        ctx.res.end()
      }
      await pump()
    } else {
      ctx.res.end()
    }
  } catch (err: any) {
    // Log the full error server-side, but never echo upstream URLs / internal
    // hostnames back to the client — that would help an SSRF attacker map the
    // network behind the proxy.
    logger.error(err, 'Proxy error')
    if (!ctx.res.headersSent) {
      ctx.status = 502
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: { message: 'Upstream gateway unreachable' } }
    } else {
      ctx.res.end()
    }
  } finally {
    ctx.res.removeListener('close', onClientClose)
  }
}
