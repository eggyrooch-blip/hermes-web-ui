import type { Context } from 'koa'
import { config } from '../../config'

/**
 * Console BFF — server-side proxy from the browser to the run-broker console_api
 * (data layer already shipped in hermes-multitenancy). The browser NEVER sees the
 * master key; this controller holds it and forwards.
 *
 * Two planes (design §8c A1 — the route guards live in routes/hermes/console.ts):
 *   - admin plane (requireConsoleAdmin): overview / profiles / profile detail /
 *     reauth-pending — full fleet, master-key forwarded to console_api.
 *   - developer plane (requireConsoleUser): dev/me — the caller's OWN agents only.
 *     The owner is derived from the session server-side (§8c A5); a client-supplied
 *     owner is ignored, so no developer can enumerate anyone else.
 */

const BROKER_TIMEOUT_MS = 20_000

function sessionOpenId(ctx: Context): string | undefined {
  const v = (ctx.state?.user as { openid?: string } | undefined)?.openid
  return typeof v === 'string' && v ? v : undefined
}

/** Forward a GET to the run-broker with the master key. Client query is NOT
 *  passed through except an explicit allowlist per caller (owner never comes
 *  from the client). Returns the parsed body or writes an error onto ctx. */
async function brokerGet(
  ctx: Context,
  brokerPath: string,
  query?: URLSearchParams,
): Promise<unknown | null> {
  // Fail-closed: without a broker URL *or* a master key, refuse to forward at all.
  // Never send a keyless request — the BFF must not rely on the broker's own 401
  // as its only guard (a misconfigured deploy would otherwise proxy unauthenticated
  // traffic to the fleet data plane). No key → 503, request never leaves the box.
  if (!config.runBrokerUrl || !config.runBrokerKey) {
    ctx.status = 503
    ctx.body = { error: 'Console broker is not configured' }
    return null
  }
  const search = query?.toString()
  const url = `${config.runBrokerUrl.replace(/\/+$/, '')}${brokerPath}${search ? `?${search}` : ''}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.runBrokerKey}`,
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(BROKER_TIMEOUT_MS) })
  } catch (e: any) {
    ctx.status = 502
    ctx.body = { error: `Broker error: ${e?.message ?? 'unreachable'}` }
    return null
  }
  if (!res.ok) {
    ctx.status = res.status
    try {
      ctx.body = await res.json()
    } catch {
      ctx.body = { error: `Broker returned ${res.status}` }
    }
    return null
  }
  return res.json()
}

async function proxy(ctx: Context, brokerPath: string, query?: URLSearchParams): Promise<void> {
  const body = await brokerGet(ctx, brokerPath, query)
  if (body === null) return
  ctx.status = 200
  ctx.body = body
}

// ── admin plane (requireConsoleAdmin) ─────────────────────────────────────

export async function overview(ctx: Context): Promise<void> {
  await proxy(ctx, '/api/run-broker/console/overview')
}

export async function profiles(ctx: Context): Promise<void> {
  // Only q/limit/offset pass through — and limit is clamped (§8c A9). No client
  // identity/scope param is forwarded.
  const q = new URLSearchParams()
  const rawQ = ctx.query.q
  if (typeof rawQ === 'string' && rawQ) q.set('q', rawQ.slice(0, 128))
  const limit = Math.min(Math.max(parseInt(String(ctx.query.limit ?? '50'), 10) || 50, 1), 200)
  const offset = Math.max(parseInt(String(ctx.query.offset ?? '0'), 10) || 0, 0)
  q.set('limit', String(limit))
  q.set('offset', String(offset))
  await proxy(ctx, '/api/run-broker/console/profiles', q)
}

export async function profileDetail(ctx: Context): Promise<void> {
  const name = String(ctx.params.name ?? '')
  await proxy(ctx, `/api/run-broker/console/profiles/${encodeURIComponent(name)}`)
}

export async function reauthPending(ctx: Context): Promise<void> {
  await proxy(ctx, '/api/run-broker/console/reauth-pending')
}

// ── developer plane (requireConsoleUser, self-scoped) ─────────────────────

/** The four ingest endpoints already public on hermes.gotokeep.com, described
 *  for the developer so they know how to call each. Static — no secrets. */
const API_CATALOG = [
  {
    name: '同步推送', method: 'POST', path: '/api/run-broker/ingest',
    auth: 'Bearer <你的 ingest key>',
    purpose: '把一段内容同步交给你的 agent 处理,一次请求拿最终结果(≤180s)。',
    example: 'curl -X POST https://hermes.gotokeep.com/api/run-broker/ingest \\\n  -H "Authorization: Bearer hm-ingest-《你的key》" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"content":"帮我分析这条工单:…"}\'',
  },
  {
    name: '异步提交', method: 'POST', path: '/api/run-broker/ingest/async',
    auth: 'Bearer <你的 ingest key>',
    purpose: '长任务:提交后立刻返回 run_id + poll_url,不占连接。',
    example: 'curl -X POST https://hermes.gotokeep.com/api/run-broker/ingest/async \\\n  -H "Authorization: Bearer hm-ingest-《你的key》" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"content":"…"}\'',
  },
  {
    name: '轮询结果', method: 'GET', path: '/api/run-broker/ingest/runs/{run_id}',
    auth: 'Bearer <你的 ingest key>',
    purpose: '拿异步任务结果。status ∈ pending/running/succeeded/needs_clarification/needs_approval/failed/timeout。',
    example: 'curl https://hermes.gotokeep.com/api/run-broker/ingest/runs/ing_XXXX \\\n  -H "Authorization: Bearer hm-ingest-《你的key》"',
  },
  {
    name: '列出我的 Agent', method: 'GET', path: '/api/run-broker/ingest/agents',
    auth: 'Bearer <你的 ingest key>',
    purpose: '列出这个 key(owner 模式)能调用的 agent。',
    example: 'curl https://hermes.gotokeep.com/api/run-broker/ingest/agents \\\n  -H "Authorization: Bearer hm-ingest-《你的key》"',
  },
]

/**
 * Developer self-view: the caller's own agents + the API catalog. The owner is
 * the SESSION open_id — never a client parameter (§8c A5). We forward that open_id
 * to the broker's profile-search and keep only agent rows owned by it.
 */
export async function devMe(ctx: Context): Promise<void> {
  const openid = sessionOpenId(ctx)
  if (!openid) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  // Ask the broker for agent-kind routing rows owned by THIS session's open_id.
  const q = new URLSearchParams({ q: openid, limit: '200' })
  const search = (await brokerGet(ctx, '/api/run-broker/console/profiles', q)) as
    | { items?: Array<Record<string, unknown>> }
    | null
  if (search === null) return // brokerGet already wrote the error
  const agents = (search.items ?? [])
    .filter((r) => r.kind === 'agent' && r.owner_open_id === openid)
    .map((r) => ({ name: r.display_label || r.profile || r.user_id, profile: r.profile, active: r.active }))
  ctx.status = 200
  ctx.body = {
    developer: { open_id: openid },
    agents,
    api_catalog: API_CATALOG,
    key_hint: '生成 ingest key 走自助(M3):服务端按你的飞书会话派生身份绑定,不经管理员。',
  }
}
