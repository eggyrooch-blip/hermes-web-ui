import type { Context } from 'koa'
import { config } from '../../config'
import { isChatPlaneRequest, type WebUser } from '../../services/request-context'
import { ownerOwnsProfile, resolveAccessibleProfileAgentId } from '../../services/hermes/agent-ownership'

export interface SlashCommand {
  name: string
  slash: string
  title: string
  description: string
  source: 'local' | 'skill' | string
  type: 'local' | 'skill' | string
  category: string
}

const LOCAL_COMMANDS: SlashCommand[] = [
  {
    name: 'clear',
    slash: '/clear',
    title: 'Clear conversation',
    description: 'Clear the current chat transcript.',
    source: 'local',
    type: 'local',
    category: 'Chat',
  },
]

function chatPlaneOpenId(ctx: Context): string | undefined {
  if (!isChatPlaneRequest(ctx)) return undefined
  const user = ctx.state?.user as WebUser | undefined
  return user?.openid?.trim() || undefined
}

function chatPlaneUserProfile(ctx: Context): string | undefined {
  if (!isChatPlaneRequest(ctx)) return undefined
  const user = ctx.state?.user as WebUser | undefined
  return user?.profile?.trim() || undefined
}

function requestedProfile(ctx: Context): string {
  return String(ctx.query?.profile_name || ctx.query?.profile || '').trim()
}

function brokerAgentId(ctx: Context, profile: string): string | undefined {
  const openid = chatPlaneOpenId(ctx)
  if (openid) return profile ? resolveAccessibleProfileAgentId(openid, profile) : undefined
  return String(ctx.query?.agent_id || ctx.get?.('x-hermes-agent-id') || '').trim() || undefined
}

function rejectUnownedChatPlaneProfile(ctx: Context, profile: string): boolean {
  const openid = chatPlaneOpenId(ctx)
  if (!openid || !profile || profile === chatPlaneUserProfile(ctx)) return false
  if (ownerOwnsProfile(openid, profile)) return false
  ctx.status = 403
  ctx.body = { error: 'profile is not accessible for current owner' }
  return true
}

function brokerHeaders(ctx: Context): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  const openid = chatPlaneOpenId(ctx)
  if (openid) headers['X-Hermes-Owner-Open-Id'] = openid
  const agentId = brokerAgentId(ctx, requestedProfile(ctx))
  if (agentId) headers['X-Hermes-Agent-Id'] = agentId
  return headers
}

function brokerSlashUrl(ctx: Context): string {
  const url = new URL('/api/run-broker/slash/commands', config.runBrokerUrl)
  const profile = requestedProfile(ctx)
  if (profile) url.searchParams.set('profile_name', profile)
  const agentId = brokerAgentId(ctx, profile)
  if (agentId) url.searchParams.set('agent_id', agentId)
  return url.toString()
}

async function readUpstreamError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `${res.status} ${res.statusText}`
  try {
    const parsed = JSON.parse(text)
    return String(parsed?.error?.message || parsed?.error || text)
  } catch {
    return text
  }
}

function normalizeBrokerCommands(value: unknown): SlashCommand[] {
  const raw = Array.isArray(value) ? value : []
  return raw
    .map((item: any) => ({
      name: String(item?.name || '').trim(),
      slash: String(item?.slash || '').trim(),
      title: String(item?.title || item?.name || '').trim(),
      description: String(item?.description || '').trim(),
      source: String(item?.source || 'skill'),
      type: String(item?.type || 'skill'),
      category: String(item?.category || ''),
    }))
    .filter(command => command.name && command.slash.startsWith('/'))
}

export async function listSlashCommands(ctx: Context): Promise<void> {
  if (!config.runBrokerUrl) {
    ctx.status = 200
    ctx.body = {
      ok: true,
      commands: LOCAL_COMMANDS,
      broker: {
        ok: false,
        error: 'HERMES_RUN_BROKER_URL is required for slash registry',
      },
    }
    return
  }

  const profile = requestedProfile(ctx)
  if (rejectUnownedChatPlaneProfile(ctx, profile)) return

  let res: Response
  try {
    res = await fetch(brokerSlashUrl(ctx), {
      method: 'GET',
      headers: brokerHeaders(ctx),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e: any) {
    ctx.status = 200
    ctx.body = {
      ok: true,
      commands: LOCAL_COMMANDS,
      broker: {
        ok: false,
        error: `Broker error: ${e.message}`,
      },
    }
    return
  }

  if (!res.ok) {
    ctx.status = res.status
    ctx.body = { error: await readUpstreamError(res) }
    return
  }

  const body = await res.json()
  ctx.status = 200
  ctx.body = {
    ok: true,
    commands: [...LOCAL_COMMANDS, ...normalizeBrokerCommands(body?.commands)],
    broker: {
      ok: true,
      profile_name: body?.profile_name,
    },
  }
}
