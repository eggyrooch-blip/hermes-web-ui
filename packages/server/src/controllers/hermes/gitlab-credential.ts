import type { Context } from 'koa'
import { config } from '../../config'
import { isChatPlaneRequest, type WebUser } from '../../services/request-context'

/**
 * Submit the caller's OWN GitLab personal access token.
 *
 * Identity discipline (this is a credential WRITE path):
 * the owner is read from the verified session (`ctx.state.user.openid`) and
 * stamped server-side as `X-Hermes-Owner-Open-Id`, mirroring the kanban/jobs
 * controllers. Nothing identity-shaped is forwarded from the request body — the
 * broker side additionally resolves the tenant from that header alone and
 * ignores any body field, so a client cannot aim the write at another profile
 * even if this layer regressed.
 *
 * The token itself is forwarded once and never persisted, logged, or echoed by
 * the WebUI: the multitenancy vault is the only thing that stores it.
 */
export async function submitGitlabToken(ctx: Context) {
  if (!isChatPlaneRequest(ctx)) {
    ctx.status = 404
    ctx.body = { error: 'not found' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'HERMES_RUN_BROKER_URL is required to configure GitLab credentials' }
    return
  }

  const user = ctx.state?.user as WebUser | undefined
  const openid = user?.openid?.trim()
  if (!openid) {
    // Fail closed: without a verified identity we cannot know whose vault to
    // write, and we must never fall back to a body-supplied one.
    ctx.status = 403
    ctx.body = { error: '无法确认你的身份，请重新登录后再试' }
    return
  }

  const body = (ctx.request.body || {}) as Record<string, unknown>
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Owner-Open-Id': openid,
  }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`

  // Only token material crosses this boundary. Any profile_name / open_id /
  // agent_id the client may have sent is dropped here by construction.
  // 不转发 expires_on：到期日由 broker 从 GitLab 的 token 行读取，
  // 员工填的任何日期都不再参与校验。
  const payload = {
    token: String(body.token ?? ''),
    tier: String(body.tier ?? ''),
  }

  let res: Response
  try {
    res = await fetch(`${config.runBrokerUrl}/api/run-broker/credentials/gitlab`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
  } catch {
    ctx.status = 502
    ctx.body = { error: '暂时联系不上凭据服务，请稍后重试' }
    return
  }

  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  ctx.status = res.status
  // Surface the broker's user-facing rejection reason verbatim; it is a fixed
  // string and never contains the submitted token.
  ctx.body = parsed ?? { error: '凭据服务返回了无法解析的响应' }
}
