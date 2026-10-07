import type { Context } from 'koa'
import { config } from '../../config'
import { isChatPlaneRequest, type WebUser } from '../../services/request-context'
import { revokeFigmaAuthorization } from '../../services/hermes/connector-registry-client'

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
  // The panel's profile is forwarded as a TARGET HINT only (group-owner binds
  // land on the group profile). It carries zero authority: the broker resolves
  // the owner from the verified header above and decides whether the hint is
  // honoured. Query-only on purpose — body identity fields stay dropped.
  const requestedProfile = String(
    (Array.isArray(ctx.query?.profile) ? ctx.query.profile[0] : ctx.query?.profile) ?? '',
  ).trim()
  if (requestedProfile) headers['X-Hermes-Profile'] = requestedProfile
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

async function githubCredential(ctx: Context, method: 'POST' | 'DELETE') {
  if (!isChatPlaneRequest(ctx)) {
    ctx.status = 404
    ctx.body = { error: 'not found' }
    return
  }
  if (!config.runBrokerUrl) {
    ctx.status = 503
    ctx.body = { error: 'HERMES_RUN_BROKER_URL is required to configure GitHub credentials' }
    return
  }
  const openid = (ctx.state?.user as WebUser | undefined)?.openid?.trim()
  if (!openid) {
    ctx.status = 403
    ctx.body = { error: '无法确认你的身份，请重新登录后再试' }
    return
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Owner-Open-Id': openid,
  }
  const requestedProfile = String(
    (Array.isArray(ctx.query?.profile) ? ctx.query.profile[0] : ctx.query?.profile) ?? '',
  ).trim()
  if (requestedProfile) headers['X-Hermes-Profile'] = requestedProfile
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`
  const rawToken = ((ctx.request.body || {}) as Record<string, unknown>).token
  const token = typeof rawToken === 'string' ? rawToken.trim() : ''
  if (method === 'POST' && (!token || token.length > 512 || /\s/.test(token))) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'GitHub token 格式不正确' }
    return
  }
  try {
    const res = await fetch(`${config.runBrokerUrl}/api/run-broker/credentials/github`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify({ token }) } : {}),
    })
    const text = await res.text()
    let parsed: Record<string, unknown> = {}
    try {
      const value = text ? JSON.parse(text) : {}
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value
    } catch { /* response is sanitized below */ }
    const ok = res.ok && (parsed.ok === true || (method === 'DELETE' && res.status === 204))
    ctx.status = res.status === 204 ? 200 : res.status
    ctx.body = {
      ok,
      ...(ok && typeof parsed.account_hint === 'string'
        ? { account_hint: parsed.account_hint.trim().slice(0, 80) }
        : {}),
      ...(ok && parsed.revoked === true ? { revoked: true } : {}),
      ...(!ok ? { error: 'GitHub 凭据未通过验证' } : {}),
    }
  } catch {
    ctx.status = 502
    ctx.body = { error: '暂时联系不上凭据服务，请稍后重试' }
  }
}

export async function submitGithubToken(ctx: Context) {
  return githubCredential(ctx, 'POST')
}

export async function revokeGithubToken(ctx: Context) {
  return githubCredential(ctx, 'DELETE')
}

/**
 * Revoke the caller's OWN Figma MCP authorization.
 *
 * Same identity discipline as the GitHub path above: the owner comes from the
 * verified session and is stamped server-side, so one employee can never revoke
 * another's grant. Start lives on `/api/auth/skill-credentials/figma/start`
 * (the card's `oauth_url` action); only revoke needs its own route because the
 * card renders a second button for it.
 */
export async function revokeFigmaCredential(ctx: Context) {
  if (!isChatPlaneRequest(ctx)) {
    ctx.status = 404
    ctx.body = { error: 'not found' }
    return
  }
  const user = ctx.state?.user as WebUser | undefined
  const openid = user?.openid?.trim()
  if (!openid) {
    ctx.status = 403
    ctx.body = { error: '无法确认你的身份，请重新登录后再试' }
    return
  }
  const requestedProfile = String(
    (Array.isArray(ctx.query?.profile) ? ctx.query.profile[0] : ctx.query?.profile) ?? '',
  ).trim()
  const profileName = requestedProfile || (user?.profile || '').trim()
  try {
    const { revoked } = await revokeFigmaAuthorization({ profileName, ownerOpenId: openid })
    // 撤销是幂等的：broker 说 revoked:false 表示本来就没有授权，对员工来说同样是
    // "现在没绑"，不是失败。ok 如实反映这一点，卡片照常回到未认证。
    ctx.status = 200
    ctx.body = { ok: true, revoked }
  } catch (err: any) {
    ctx.status = typeof err?.status === 'number' ? err.status : 502
    ctx.body = { ok: false, error: err?.message || '暂时联系不上凭据服务，请稍后重试' }
  }
}
