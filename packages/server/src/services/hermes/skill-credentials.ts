import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import type { Dirent } from 'fs'
import { basename, delimiter, dirname, join } from 'path'
import { execFile, spawn } from 'child_process'
import type { ChildProcessByStdio } from 'child_process'
import type { Readable, Writable } from 'stream'
import { promisify } from 'util'
import { createHash, randomBytes } from 'crypto'
import type { WebUser } from '../request-context'

export type SkillCredentialState = 'authenticated' | 'configured' | 'missing' | 'needs_auth' | 'unknown' | 'error'
export type SkillCredentialActionKind = 'feishu_device_flow' | 'skill_flow' | 'qr_flow' | 'oauth_url' | 'manual'

const execFileAsync = promisify(execFile)
type KepAuthLoginProcess = ChildProcessByStdio<Writable | null, Readable, Readable>

interface KepAuthLoginSession {
  child: KepAuthLoginProcess
  sessionKey: string
}

interface FeishuProjectLoginSession {
  child: KepAuthLoginProcess
  sessionKey: string
}

interface KepAuthCallbackSession {
  createdAt: number
  localCallbackUrl: string
  sessionKey: string
}

const KEP_AUTH_CALLBACK_TTL_MS = 10 * 60 * 1000
const FEISHU_PROJECT_CREDENTIAL_ID = 'feishu-project'
const MEEGLE_DEFAULT_HOST = 'project.feishu.cn'
const activeKepAuthLogins = new Map<string, KepAuthLoginSession>()
const activeKepAuthCallbacks = new Map<string, KepAuthCallbackSession>()
const activeFeishuProjectLogins = new Map<string, FeishuProjectLoginSession>()

export interface SkillCredentialAction {
  kind: SkillCredentialActionKind
  label: string
  command?: string
  description?: string
}

export interface SkillCredentialEntry {
  id: string
  title: string
  provider: string
  installed: boolean
  status: SkillCredentialState
  account_hint?: string
  default_identity?: string
  detail?: string
  required_by?: string[]
  action: SkillCredentialAction
}

export interface SkillCredentialsResult {
  profile_name: string
  credentials: SkillCredentialEntry[]
}

export interface ListSkillCredentialOptions {
  profileName: string
  profileDir: string
  user?: WebUser
  larkStatus?: Record<string, any> | null
}

export interface SkillCredentialStartOptions {
  id: string
  profileName: string
  profileDir: string
  publicOrigin?: string
}

interface ProfileSkill {
  name: string
  dir: string
  path: string
  tags: string[]
  text: string
  source?: string
}

export interface SkillCredentialRequirementInput {
  name: string
  tags?: string[]
  text: string
  source?: string
}

interface KepAuthStatus {
  state: 'logged_in' | 'not_logged_in'
  account?: string
}

export interface KeepRecordQrStartResult {
  id: 'keep-record'
  status: 'qr_pending'
  qrcode_id: string
  qrcode_url: string
  redirect_url?: string
  action: SkillCredentialAction
}

export interface KeepRecordCompleteResult {
  id: 'keep-record'
  status: 'authenticated'
  account_hint?: string
}

export interface KepCliAuthStartResult {
  id: 'kep-cli'
  status: 'auth_pending'
  verification_uri: string
  action: SkillCredentialAction
}

export interface FeishuProjectAuthStartResult {
  id: 'feishu-project'
  status: 'auth_pending'
  verification_uri: string
  action: SkillCredentialAction
}

export interface KepCliAuthCallbackResult {
  status: 'ok'
  body: string
}

export async function listSkillCredentialStatuses(options: ListSkillCredentialOptions): Promise<SkillCredentialsResult> {
  const profileName = options.profileName
  const profileDir = options.profileDir
  const skills = scanProfileSkills(profileDir)
  const requiredBy = credentialRequirementsById(skills)
  return {
    profile_name: profileName,
    credentials: [
      larkCliStatus(options, requiredBy.get('lark-cli')),
      await feishuProjectStatus(profileDir, requiredBy.get(FEISHU_PROJECT_CREDENTIAL_ID)),
      keepRecordStatus(profileDir, skills),
      await kepCliStatus(profileDir, profileName, skills, requiredBy.get('kep-cli')),
      gitlabStatus(profileDir, skills),
    ],
  }
}

export function detectSkillCredentialRequirements(input: SkillCredentialRequirementInput): string[] {
  const text = `${input.name || ''}\n${(input.tags || []).join('\n')}\n${input.text || ''}`.toLowerCase()
  const source = String(input.source || '').trim().toLowerCase()
  const required: string[] = []

  const needsLark = [
    /\blark[-_ ]?cli\b/,
    /\blarksuite\b/,
    /open\.feishu\.cn/,
    /feishu\.cn\/(docx|docs|sheets|wiki|base|minutes|file)/,
    /\bwiki:wiki:readonly\b/,
    /\b(feishu|lark|larksuite)\b.{0,80}\b(docx|docs|base|sheets?|bitable|wiki)\b/,
    /\b(docx|docs|base|sheets?|bitable|wiki)\b.{0,80}\b(feishu|lark|larksuite)\b/,
    /\b(im:message|contact:user|drive:drive|wiki:wiki)\b/,
  ].some(pattern => pattern.test(text))

  const hubSourced = source === 'hub' || source === 'aidock-skillhub'
  const needsKep = hubSourced || [
    /\bkep[-_ ]?cli\b/,
    /\bkep[-_ ]?auth\b/,
    /\baidock\b/,
    /\bskillhub\b/,
    /\bkeep[-_ ]?login\b/,
    /\bproxy[-_ ]?cms\b/,
    /proxy\.cms\.(pre\.)?gotokeep\.com/,
    /ark\.gotokeep\.com\/aidock-cms/,
    /skill\/zipfile/,
    /\bkep_profile\b/,
    /\bkep_no_auto_login\b/,
    /bearer\s+token.*gotokeep/,
  ].some(pattern => pattern.test(text))

  const needsGitlab = [
    /\bgitlab_token\b/,
    /gitlab\.gotokeep\.com/,
    /oauth2:\$\{?gitlab_token\}?@/i,
  ].some(pattern => pattern.test(text))

  const needsKeepRecord = [
    /\bkeep-record\b/,
    /\bkeep_auth_token\b/,
    /\bget_qrcode\b/,
    /\bpersist_auth\b/,
  ].some(pattern => pattern.test(text))

  const needsFeishuProject = [
    /\bmeegle\b/,
    /\bmeego\b/,
    /project\.feishu\.cn/,
    /飞书项目/,
    /工作项/,
    /项目视图/,
    /需求/,
    /缺陷/,
    /排期/,
  ].some(pattern => pattern.test(text))

  if (needsLark) required.push('lark-cli')
  if (needsFeishuProject) required.push(FEISHU_PROJECT_CREDENTIAL_ID)
  if (needsKep) required.push('kep-cli')
  if (needsKeepRecord) required.push('keep-record')
  if (needsGitlab) required.push('gitlab')
  return required
}

function credentialRequirementsById(skills: ProfileSkill[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const skill of skills) {
    for (const id of detectSkillCredentialRequirements(skill)) {
      const list = result.get(id) || []
      if (!list.includes(skill.name)) list.push(skill.name)
      result.set(id, list)
    }
  }
  for (const list of result.values()) list.sort((a, b) => a.localeCompare(b))
  return result
}

export async function getSkillCredentialStartAction(options: SkillCredentialStartOptions): Promise<{ id: string; action: SkillCredentialAction }> {
  const id = normalizeId(options.id)
  if (id === 'lark-cli') {
    return {
      id,
      action: {
        kind: 'feishu_device_flow',
        label: '授权 Lark-cli',
        description: 'Start the existing Lark-cli / Feishu device authorization flow.',
      },
    }
  }
  if (id === 'keep-record') {
    return {
      id,
      action: {
        kind: 'skill_flow',
        label: '扫码认证 Keep-record',
        command: '/keep-record auth',
        description: 'Use the Keep-record skill login flow to show a QR code and persist the profile-local Keep credential.',
      },
    }
  }
  if (id === FEISHU_PROJECT_CREDENTIAL_ID) {
    return {
      id,
      action: {
        kind: 'oauth_url',
        label: '授权飞书项目',
        description: 'Start Feishu Project CLI device-code authorization for the current Hermes profile.',
      },
    }
  }
  if (id === 'kep-cli') {
    return {
      id,
      action: {
        kind: 'oauth_url',
        label: '认证 kep-cli',
        description: 'Start kep-cli OAuth from WebUI. The browser authorization callback is handled by the profile-scoped kep-auth process.',
      },
    }
  }
  if (id === 'gitlab') {
    return {
      id,
      action: {
        kind: 'manual',
        label: '检查 GitLab Token',
        description: 'GitLab tokens are managed by the multitenancy credential vault or materialized profile credential file.',
      },
    }
  }
  return {
    id,
    action: {
      kind: 'manual',
      label: 'Open skill authentication',
      description: 'This skill does not have a WebUI authentication adapter yet.',
    },
  }
}

export async function startFeishuProjectAuth(options: SkillCredentialStartOptions): Promise<FeishuProjectAuthStartResult> {
  mkdirSync(join(options.profileDir, 'home'), { recursive: true })

  const host = meegleHost()
  const sessionKey = `${options.profileName}:${host}`
  const existing = activeFeishuProjectLogins.get(sessionKey)
  if (existing && !existing.child.killed) existing.child.kill()

  const command = meegleCommand()
  await configureMeegleHost(command, options.profileDir, host)

  const args = ['auth', 'login', '--device-code', '--host', host]
  const child = spawn(command, args, {
    cwd: options.profileDir,
    env: meegleEnv(options.profileDir, host),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  activeFeishuProjectLogins.set(sessionKey, { child, sessionKey })
  child.on('exit', () => {
    if (activeFeishuProjectLogins.get(sessionKey)?.child === child) activeFeishuProjectLogins.delete(sessionKey)
  })

  const verificationUri = await waitForKepAuthUrl(child, 'Meegle CLI command was not found. Install @lark-project/meegle or configure HERMES_MEEGLE_BIN for WebUI.')
  return {
    id: FEISHU_PROJECT_CREDENTIAL_ID,
    status: 'auth_pending',
    verification_uri: verificationUri,
    action: {
      kind: 'oauth_url',
      label: '授权飞书项目',
      description: 'Open the Meegle CLI device-code authorization URL. The CLI stores credentials under the current Hermes profile home.',
    },
  }
}

function meegleCommand(): string {
  return String(process.env.HERMES_MEEGLE_BIN || 'meegle').trim() || 'meegle'
}

function meegleHost(): string {
  return String(process.env.HERMES_MEEGLE_HOST || MEEGLE_DEFAULT_HOST).trim() || MEEGLE_DEFAULT_HOST
}

function meegleEnv(profileDir: string, host = meegleHost()): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(profileDir, 'home'),
    MEEGLE_HOST: host,
  }
}

async function configureMeegleHost(command: string, profileDir: string, host: string): Promise<void> {
  try {
    await execFileAsync(command, ['config', 'set', 'host', host], {
      cwd: profileDir,
      env: meegleEnv(profileDir, host),
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    })
  } catch (err: any) {
    const wrapped: any = new Error(err?.code === 'ENOENT'
      ? 'Meegle CLI command was not found. Install @lark-project/meegle or configure HERMES_MEEGLE_BIN for WebUI.'
      : `Meegle CLI host configuration failed: ${err?.stderr || err?.message || err}`)
    wrapped.status = 502
    throw wrapped
  }
}

export async function startKeepRecordAuth(options: SkillCredentialStartOptions): Promise<KeepRecordQrStartResult> {
  const skillDir = keepRecordSkillDir(options.profileDir)
  const script = join(skillDir, 'scripts', 'mcp-call.js')
  if (!existsSync(script)) {
    const err: any = new Error('Keep-record skill is not installed for this profile')
    err.status = 404
    throw err
  }
  const envelope = await runKeepRecordScript(options.profileDir, skillDir, [
    script,
    'get_qrcode',
    JSON.stringify({ authType: 'openclaw' }),
  ])
  const data = envelope?.data || {}
  const qrcodeId = String(data.qrcodeId || data.qrcode_id || '').trim()
  const qrcodeUrl = String(data.qrcodeUrl || data.qrcode_url || '').trim()
  const redirectUrl = String(data.redirectUrl || data.redirect_url || '').trim()
  if (!qrcodeId || !qrcodeUrl) {
    const err: any = new Error('Keep-record did not return a QR code')
    err.status = 502
    throw err
  }
  return {
    id: 'keep-record',
    status: 'qr_pending',
    qrcode_id: qrcodeId,
    qrcode_url: qrcodeUrl,
    redirect_url: redirectUrl || undefined,
    action: {
      kind: 'qr_flow',
      label: 'Scan Keep QR code',
      description: 'Scan this QR code in Keep, then confirm in WebUI. The token is persisted only in the profile home.',
    },
  }
}

export async function startKepCliAuth(options: SkillCredentialStartOptions): Promise<KepCliAuthStartResult> {
  const skill = findKepCliSkill(scanProfileSkills(options.profileDir))
  const bin = process.env.HERMES_KEP_AUTH_BIN || kepAuthBin(options.profileDir, skill)
  if (!existsSync(bin)) {
    const err: any = new Error('kep-auth binary is not installed')
    err.status = 404
    throw err
  }

  const sessionKey = `${options.profileName}:online`
  const existing = activeKepAuthLogins.get(sessionKey)
  if (existing && !existing.child.killed) existing.child.kill()
  deleteKepAuthCallbacksForSessionKey(sessionKey)

  const child = spawn(bin, ['--profile', options.profileName, '--env', 'online', 'login'], {
    cwd: options.profileDir,
    env: kepAuthEnv(options.profileDir, options.profileName, false),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeKepAuthLogins.set(sessionKey, { child, sessionKey })
  child.on('exit', () => {
    if (activeKepAuthLogins.get(sessionKey)?.child === child) activeKepAuthLogins.delete(sessionKey)
  })

  const rawVerificationUri = await waitForKepAuthUrl(child)
  const verificationUri = rewriteKepAuthVerificationUri(rawVerificationUri, {
    publicOrigin: options.publicOrigin,
    sessionKey,
  })
  return {
    id: 'kep-cli',
    status: 'auth_pending',
    verification_uri: verificationUri,
    action: {
      kind: 'oauth_url',
      label: '打开 kep-cli 认证',
      description: 'Complete kep-cli OAuth in the browser. The CLI callback writes the token into the current Hermes profile home.',
    },
  }
}

export async function completeKepCliAuthCallback(options: { sessionId: string; query: string | URLSearchParams }): Promise<KepCliAuthCallbackResult> {
  pruneExpiredKepAuthCallbacks()
  const sessionId = String(options.sessionId || '').trim()
  const session = activeKepAuthCallbacks.get(sessionId)
  if (!session) {
    const err: any = new Error('kep-cli auth session was not found or has expired')
    err.status = 404
    throw err
  }
  activeKepAuthCallbacks.delete(sessionId)

  const target = new URL(session.localCallbackUrl)
  const query = typeof options.query === 'string'
    ? options.query
    : options.query.toString()
  target.search = query

  let res: Response
  try {
    res = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'manual',
    })
  } catch (err: any) {
    const wrapped: any = new Error(`kep-auth local callback failed: ${err?.message || err}`)
    wrapped.status = 502
    throw wrapped
  }

  const body = await res.text().catch(() => '')
  if (res.status >= 400) {
    const err: any = new Error(body || `kep-auth local callback returned HTTP ${res.status}`)
    err.status = 502
    throw err
  }
  return {
    status: 'ok',
    body,
  }
}

function rewriteKepAuthVerificationUri(rawVerificationUri: string, options: {
  publicOrigin?: string
  sessionKey: string
}): string {
  const publicOrigin = normalizePublicOrigin(options.publicOrigin)
  if (!publicOrigin) return rawVerificationUri

  const authUrl = new URL(rawVerificationUri)
  const localCallback = authUrl.searchParams.get('response_url')
  if (!localCallback) return rawVerificationUri

  const localCallbackUrl = new URL(localCallback)
  if (!isLocalKepAuthCallback(localCallbackUrl)) {
    const err: any = new Error('kep-auth returned an unsafe OAuth callback URL')
    err.status = 502
    throw err
  }

  pruneExpiredKepAuthCallbacks()
  const sessionId = randomBytes(18).toString('base64url')
  activeKepAuthCallbacks.set(sessionId, {
    createdAt: Date.now(),
    localCallbackUrl: localCallbackUrl.toString(),
    sessionKey: options.sessionKey,
  })

  const publicCallback = new URL(`/api/auth/kep-cli/callback/${sessionId}`, publicOrigin)
  authUrl.searchParams.set('response_url', publicCallback.toString())
  return authUrl.toString()
}

function normalizePublicOrigin(raw: string | undefined): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.origin
  } catch {
    return ''
  }
}

function isLocalKepAuthCallback(url: URL): boolean {
  if (url.protocol !== 'http:') return false
  if (url.username || url.password) return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
}

function pruneExpiredKepAuthCallbacks(now = Date.now()): void {
  for (const [sessionId, session] of activeKepAuthCallbacks) {
    if (now - session.createdAt > KEP_AUTH_CALLBACK_TTL_MS) activeKepAuthCallbacks.delete(sessionId)
  }
}

function deleteKepAuthCallbacksForSessionKey(sessionKey: string): void {
  for (const [sessionId, session] of activeKepAuthCallbacks) {
    if (session.sessionKey === sessionKey) activeKepAuthCallbacks.delete(sessionId)
  }
}

function waitForKepAuthUrl(child: KepAuthLoginProcess, notFoundMessage = 'Authentication command was not found.'): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const done = (err?: Error, url?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      if (err) reject(err)
      else resolve(url || '')
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const match = buffer.match(/https?:\/\/[^\s]+/)
      if (match) done(undefined, match[0])
    }
    const onExit = (code: number | null) => {
      done(new Error(`kep-auth login exited before returning an authorization URL${code === null ? '' : ` (code ${code})`}`))
    }
    const onError = (err: Error & { code?: string }) => {
      const message = err.code === 'ENOENT'
        ? notFoundMessage
        : err.message
      const wrapped: any = new Error(message)
      wrapped.status = 502
      done(wrapped)
    }
    const timer = setTimeout(() => {
      done(new Error('kep-auth login did not return an authorization URL in time'))
      if (!child.killed) child.kill()
    }, 10_000)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

function kepAuthEnv(profileDir: string, profileName: string, noAutoLogin: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(profileDir, 'home'),
    HERMES_HOME: profileDir,
    KEP_PROFILE: profileName,
    ...(noAutoLogin ? { KEP_NO_AUTO_LOGIN: '1' } : {}),
  }
}

export async function completeKeepRecordAuth(options: SkillCredentialStartOptions & { qrcodeId: string }): Promise<KeepRecordCompleteResult> {
  const skillDir = keepRecordSkillDir(options.profileDir)
  const waitScript = join(skillDir, 'scripts', 'login-wait.js')
  const persistScript = join(skillDir, 'scripts', 'persist_auth.js')
  if (!existsSync(waitScript) || !existsSync(persistScript)) {
    const err: any = new Error('Keep-record auth scripts are not installed for this profile')
    err.status = 404
    throw err
  }
  const envelope = await runKeepRecordScript(options.profileDir, skillDir, [
    waitScript,
    options.qrcodeId,
    '--timeout=15000',
  ], 20_000)
  const data = envelope?.data || {}
  if (data.status !== 'authorized' || !data.token) {
    const code = envelope?.error?.code || data.status || 'LOGIN_PENDING'
    const message = envelope?.error?.message || 'Keep login is not authorized yet'
    const err: any = new Error(message)
    err.status = code === 'LOGIN_TIMEOUT' || code === 'LOGIN_PENDING' ? 409 : 502
    throw err
  }
  const username = safeAccountHint(data.user?.username || data.username)
  await runKeepRecordScript(options.profileDir, skillDir, [
    persistScript,
    `--token=${String(data.token)}`,
    ...(username ? [`--username=${username}`] : []),
  ])
  writeKeepRecordVerification(options.profileDir, String(data.token), username)
  return {
    id: 'keep-record',
    status: 'authenticated',
    account_hint: username,
  }
}

function larkCliStatus(options: ListSkillCredentialOptions, requiredBy?: string[]): SkillCredentialEntry {
  const status = options.larkStatus || {}
  const larkCli = status.lark_cli || {}
  const localUat = localFeishuUatStatus(options.profileDir)
  const hasUserAuthorization = status.status === 'valid' || localUat.connected || larkCli.default_identity === 'user'
  const connected = options.user ? hasUserAuthorization : hasUserAuthorization || Boolean(larkCli.available)
  const defaultIdentity = connected
    ? typeof larkCli.default_identity === 'string'
      ? larkCli.default_identity
      : localUat.connected ? 'user' : undefined
    : undefined
  return {
    id: 'lark-cli',
    title: 'Lark-cli',
    provider: 'lark',
    installed: true,
    status: connected ? 'authenticated' : 'needs_auth',
    account_hint: connected ? safeAccountHint(options.user?.name) : undefined,
    default_identity: defaultIdentity,
    detail: connected
      ? hasUserAuthorization ? 'Lark-cli user authorization is available for this profile.' : 'Lark-cli credential is available for this skill runtime.'
      : 'Lark-cli needs user authorization for private Lark resources.',
    required_by: requiredBy,
    action: {
      kind: 'feishu_device_flow',
      label: connected ? '重新授权' : '授权',
    },
  }
}

function localFeishuUatStatus(profileDir: string): { connected: boolean } {
  const dir = join(profileDir, 'feishu_uat')
  for (const name of safeList(dir)) {
    if (!name.endsWith('.json')) continue
    const raw = readSmallText(join(dir, name))
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      const expiresAt = Number(parsed.expires_at || 0)
      const hasAccessToken = typeof parsed.access_token === 'string' && parsed.access_token.length > 0
      const validExpiry = !expiresAt || expiresAt > Date.now() + 60_000
      if (hasAccessToken && validExpiry) return { connected: true }
    } catch {
      // Ignore malformed credential cache files.
    }
  }
  return { connected: false }
}

async function feishuProjectStatus(profileDir: string, requiredBy?: string[]): Promise<SkillCredentialEntry> {
  const status = await readMeegleAuthStatus(profileDir)
  const authenticated = status.authenticated
  return {
    id: FEISHU_PROJECT_CREDENTIAL_ID,
    title: '飞书项目',
    provider: 'feishu-project',
    installed: status.available,
    status: !status.available ? 'missing' : authenticated ? 'authenticated' : 'needs_auth',
    account_hint: safeAccountHint(status.account),
    detail: !status.available
      ? '飞书项目 CLI 未安装，无法授权或调用飞书项目能力。'
      : authenticated
        ? '飞书项目 CLI 已在当前 profile 完成授权，可查询和更新工作项。'
        : '飞书项目需要授权后才能查询和更新工作项。',
    required_by: requiredBy,
    action: {
      kind: 'oauth_url',
      label: authenticated ? '重新授权' : '授权',
    },
  }
}

interface MeegleAuthStatus {
  available: boolean
  authenticated: boolean
  account?: string
}

async function readMeegleAuthStatus(profileDir: string): Promise<MeegleAuthStatus> {
  const command = meegleCommand()
  try {
    const { stdout } = await execFileAsync(command, ['auth', 'status', '--format', 'json'], {
      cwd: profileDir,
      env: meegleEnv(profileDir),
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    })
    const parsed = JSON.parse(stdout || '{}')
    return {
      available: true,
      authenticated: parsed?.authenticated === true,
      account: safeAccountHint(parsed?.account || parsed?.user?.name || parsed?.user?.email || parsed?.host),
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { available: false, authenticated: false }
    return { available: true, authenticated: false }
  }
}

function keepRecordStatus(profileDir: string, skills = scanProfileSkills(profileDir)): SkillCredentialEntry {
  const skill = findKeepRecordSkill(skills)
  const installed = Boolean(skill)
  const envPath = join(profileDir, 'home', '.keepai', '.env')
  const env = readSmallText(envPath)
  const parsed = parseKeepRecordEnv(env)
  const hasToken = Boolean(parsed.token)
  const verification = parsed.token ? readKeepRecordVerification(profileDir, parsed.token) : { verified: false }
  const authenticated = installed && hasToken && verification.verified
  const account = parsed.username || verification.account
  return {
    id: 'keep-record',
    title: 'Keep-record',
    provider: 'keep',
    installed,
    status: authenticated ? 'authenticated' : installed && hasToken ? 'unknown' : installed ? 'needs_auth' : 'missing',
    account_hint: safeAccountHint(account),
    detail: authenticated
      ? 'Keep-record QR login was verified by WebUI for this profile.'
      : installed && hasToken
      ? 'Keep-record local credential file exists, but WebUI has not verified a live Keep login. Use QR scan to authorize or refresh it.'
      : installed ? `${skill?.name || 'Keep-record skill'} requires Keep QR authorization for this profile.` : 'Keep-record skill is not installed for this profile.',
    action: {
      kind: 'skill_flow',
      label: hasToken ? '重新扫码' : '扫码认证',
      command: '/keep-record auth',
    },
  }
}

function parseKeepRecordEnv(env: string): { token?: string; username?: string } {
  const token = env.match(/^keep_auth_token=(.+)$/m)?.[1]?.trim()
  const username = env.match(/^keep_username=(.+)$/m)?.[1]?.trim()
  return {
    token: token || undefined,
    username: username || undefined,
  }
}

function keepRecordVerificationPath(profileDir: string): string {
  return join(profileDir, 'home', '.keepai', 'webui-auth-verified.json')
}

function keepRecordTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readKeepRecordVerification(profileDir: string, token: string): { verified: boolean; account?: string } {
  try {
    const raw = readSmallText(keepRecordVerificationPath(profileDir))
    if (!raw) return { verified: false }
    const parsed = JSON.parse(raw)
    const expectedHash = keepRecordTokenHash(token)
    return {
      verified: parsed?.token_sha256 === expectedHash,
      account: typeof parsed?.account_hint === 'string' ? parsed.account_hint : undefined,
    }
  } catch {
    return { verified: false }
  }
}

function writeKeepRecordVerification(profileDir: string, token: string, account?: string): void {
  const markerPath = keepRecordVerificationPath(profileDir)
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, `${JSON.stringify({
    verified_at: new Date().toISOString(),
    token_sha256: keepRecordTokenHash(token),
    account_hint: account || undefined,
  }, null, 2)}\n`, 'utf-8')
}

function keepRecordSkillDir(profileDir: string): string {
  return findKeepRecordSkill(scanProfileSkills(profileDir))?.dir || join(profileDir, 'skills', 'Keep', 'keep-record')
}

async function runKeepRecordScript(profileDir: string, skillDir: string, args: string[], timeout = 30_000): Promise<any> {
  let stdout = ''
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: skillDir,
      env: keepRecordScriptEnv(profileDir, skillDir),
      timeout,
      maxBuffer: 1024 * 1024,
    })
    stdout = result.stdout
  } catch (err: any) {
    const output = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`
    if (/Cannot find module '@keepclaw\/skill-sdk/.test(output)) {
      const wrapped: any = new Error('Keep-record skill dependencies are not installed for this profile')
      wrapped.status = 424
      throw wrapped
    }
    throw err
  }
  const raw = String(stdout || '').trim()
  if (!raw) return {}
  try {
    const envelope = JSON.parse(raw)
    if (envelope?.ok === false) {
      const err: any = new Error(envelope?.error?.message || 'Keep-record auth failed')
      err.status = 502
      err.envelope = envelope
      throw err
    }
    return envelope
  } catch (err: any) {
    if (err?.envelope) throw err
    const wrapped: any = new Error('Keep-record returned an invalid auth response')
    wrapped.status = 502
    throw wrapped
  }
}

function keepRecordScriptEnv(profileDir: string, skillDir: string): NodeJS.ProcessEnv {
  const nodePaths = keepRecordNodeModulePaths(profileDir, skillDir)
  return {
    ...process.env,
    HOME: join(profileDir, 'home'),
    ...(nodePaths.length
      ? { NODE_PATH: [process.env.NODE_PATH || '', ...nodePaths].filter(Boolean).join(delimiter) }
      : {}),
  }
}

function keepRecordNodeModulePaths(profileDir: string, skillDir: string): string[] {
  const roots: string[] = []
  const add = (path: string) => {
    if (!roots.includes(path) && keepRecordSdkExists(path)) roots.push(path)
  }
  add(join(skillDir, 'node_modules'))

  const sharedHome = basename(dirname(profileDir)) === 'profiles' ? dirname(dirname(profileDir)) : dirname(profileDir)
  add(join(sharedHome, 'skills', 'Keep', 'keep-record', 'node_modules'))

  const profilesRoot = dirname(profileDir)
  for (const name of safeList(profilesRoot)) {
    if (name === basename(profileDir)) continue
    add(join(profilesRoot, name, 'skills', 'Keep', 'keep-record', 'node_modules'))
  }
  return roots
}

function keepRecordSdkExists(nodeModulesDir: string): boolean {
  const sdkPackage = join(nodeModulesDir, '@keepclaw', 'skill-sdk', 'package.json')
  if (!existsSync(sdkPackage)) return false
  const text = readSmallText(sdkPackage)
  return text.includes('"@keepclaw/skill-sdk"') || text.includes('"name"')
}

async function kepCliStatus(profileDir: string, profileName: string, skills = scanProfileSkills(profileDir), requiredBy?: string[]): Promise<SkillCredentialEntry> {
  const skill = findKepCliSkill(skills)
  const installed = Boolean(skill) || Boolean(requiredBy?.length)
  const keyringDir = join(profileDir, 'home', '.kep-cli', 'keyring-fallback')
  const hasToken = safeList(keyringDir).some(name => name.includes(`token-key:online:${profileName}`) || name.includes('token-key:online:'))
  const liveStatus = installed ? await kepAuthStatus(profileDir, profileName, skill) : null
  const connected = liveStatus?.state === 'logged_in'
  const account = safeAccountHint(liveStatus?.account)
  const needsAuth = liveStatus?.state === 'not_logged_in' || (liveStatus === null && !hasToken)
  return {
    id: 'kep-cli',
    title: 'kep-cli',
    provider: 'keep',
    installed,
    status: connected ? 'authenticated' : installed && needsAuth ? 'needs_auth' : installed && hasToken ? 'unknown' : 'missing',
    account_hint: connected ? account : undefined,
    detail: connected
      ? 'kep-auth status verified this profile login.'
      : liveStatus?.state === 'not_logged_in'
        ? 'kep-auth status reports this profile is not logged in.'
        : installed && hasToken
          ? 'kep-cli credential material exists, but live status could not be verified.'
          : installed ? `${skill?.name || 'kep-cli skill'} requires kep-cli login for this profile.` : 'No kep-cli backed skill is installed for this profile.',
    required_by: requiredBy,
    action: {
      kind: 'oauth_url',
      label: connected ? '重新认证' : '认证',
    },
  }
}

function gitlabStatus(profileDir: string, skills = scanProfileSkills(profileDir)): SkillCredentialEntry {
  const credentialPath = join(profileDir, 'workspace', 'credentials', 'gitlab.token')
  const canReadToken = credentialCanBeRead(credentialPath)
  const skill = findGitlabSkill(skills)
  const installed = Boolean(skill) || canReadToken
  return {
    id: 'gitlab',
    title: 'GitLab',
    provider: 'gitlab',
    installed,
    status: canReadToken ? 'configured' : installed ? 'needs_auth' : 'missing',
    detail: canReadToken
      ? 'GitLab token is readable by the current profile; the token is not displayed.'
      : installed ? `${skill?.name || 'GitLab skill'} needs a readable profile GitLab token.` : 'No GitLab-backed skill or token is available for this profile.',
    action: {
      kind: 'manual',
      label: canReadToken ? '刷新' : '配置',
      description: 'GitLab does not use an interactive WebUI auth flow here; WebUI only verifies that the current profile can read the materialized token.',
    },
  }
}

function scanProfileSkills(profileDir: string): ProfileSkill[] {
  const root = join(profileDir, 'skills')
  const hubInstalledNames = readSkillHubInstalledNames(root)
  const results: ProfileSkill[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > 8 || !existsSync(dir)) return
    for (const entry of safeDirEntries(dir)) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const fullPath = join(dir, entry.name)
      if (isDirectoryLikeSync(fullPath, entry)) {
        visit(fullPath, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        const text = readSmallText(fullPath)
        if (!text) continue
        const name = parseSkillName(text) || basename(dirname(fullPath))
        const dirName = basename(dirname(fullPath))
        results.push({
          name,
          dir: dirname(fullPath),
          path: fullPath,
          tags: parseSkillTags(text),
          text,
          source: hubInstalledNames.has(name) || hubInstalledNames.has(dirName) ? 'hub' : undefined,
        })
      }
    }
  }
  visit(root, 0)
  return results
}

function readSkillHubInstalledNames(skillsDir: string): Set<string> {
  const names = new Set<string>()
  for (const relativePath of [join('.hub', 'lock.json'), '.hermes-skillhub.json']) {
    const raw = readSmallText(join(skillsDir, relativePath))
    if (!raw) continue
    try {
      const data = JSON.parse(raw)
      if (!data?.installed || typeof data.installed !== 'object') continue
      for (const name of Object.keys(data.installed)) {
        if (name) names.add(name)
      }
    } catch {
      // Ignore malformed SkillHub provenance files; skill text heuristics still apply.
    }
  }
  return names
}

function isDirectoryLikeSync(path: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function findKeepRecordSkill(skills: ProfileSkill[]): ProfileSkill | undefined {
  return skills.find(skill => {
    const text = skill.text.toLowerCase()
    return skill.name === 'keep-record' || (text.includes('keep_auth_token') && text.includes('get_qrcode'))
  })
}

function findKepCliSkill(skills: ProfileSkill[]): ProfileSkill | undefined {
  return skills.find(skill => {
    const text = skill.text.toLowerCase()
    return skill.name === 'kep-hades-cli' ||
      skill.tags.includes('kep-cli') ||
      (text.includes('kep-auth') && text.includes('--env online'))
  })
}

function findGitlabSkill(skills: ProfileSkill[]): ProfileSkill | undefined {
  return skills.find(skill => {
    const text = skill.text.toLowerCase()
    return skill.name === 'kep-prd-analysis' ||
      text.includes('gitlab_token')
  })
}

function parseSkillName(text: string): string {
  return text.match(/^name:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim() || ''
}

function parseSkillTags(text: string): string[] {
  const match = text.match(/tags:\s*\[([^\]]+)\]/m)
  if (!match) return []
  return match[1].split(',').map(tag => tag.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean)
}

function safeDirEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function normalizeId(id: string): string {
  const normalized = String(id || '').trim().toLowerCase()
  if (normalized === 'lark_cli') return 'lark-cli'
  if (normalized === 'keep-cli') return 'kep-cli'
  if (normalized === 'feishu_project_mcp' || normalized === 'feishu-project' || normalized === 'feishu-project-mcp' || normalized === 'meegle' || normalized === 'meegle-cli') return FEISHU_PROJECT_CREDENTIAL_ID
  return normalized
}

function readSmallText(path: string): string {
  try {
    if (!existsSync(path) || statSync(path).size > 64 * 1024) return ''
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

function safeList(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    return readdirSync(path)
  } catch {
    return []
  }
}

function credentialCanBeRead(path: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).size > 64 * 1024) return false
    return readFileSync(path, 'utf-8').trim().length > 0
  } catch {
    return false
  }
}

function safeAccountHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

async function kepAuthStatus(profileDir: string, profileName: string, skill?: ProfileSkill): Promise<KepAuthStatus | null> {
  const bin = process.env.HERMES_KEP_AUTH_BIN || kepAuthBin(profileDir, skill)
  if (!existsSync(bin)) return null
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--profile', profileName, '--env', 'online', 'status'], {
      cwd: profileDir,
      env: {
        ...kepAuthEnv(profileDir, profileName, true),
      },
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    })
    const rawOutput = `${stdout}\n${stderr}`
    const output = rawOutput.toLowerCase()
    if (/state:\s*not\s*logged\s*in/.test(output) || /not\s*logged\s*in/.test(output)) return { state: 'not_logged_in' }
    if (/state:\s*(valid|logged\s*in)/.test(output) || /logged\s*in/.test(output)) {
      return { state: 'logged_in', account: parseKepAuthAccount(rawOutput) }
    }
    return null
  } catch (err: any) {
    const output = `${err?.stdout || ''}\n${err?.stderr || ''}`.toLowerCase()
    if (/not\s*logged\s*in|unauthorized|401/.test(output) || err?.code === 3) return { state: 'not_logged_in' }
    return null
  }
}

function kepAuthBin(profileDir: string, skill?: ProfileSkill): string {
  const documented = skill?.text.match(/(?:^|\s)(\/[^\s`'"]*kep-auth)(?:\s|$)/m)?.[1]
  if (documented) return documented
  const sharedHome = basename(dirname(profileDir)) === 'profiles' ? dirname(dirname(profileDir)) : profileDir
  return join(sharedHome, 'bin', 'kep-auth')
}


function parseKepAuthAccount(output: string): string | undefined {
  const operator = output.match(/^operator:\s*(.+)$/mi)?.[1]?.trim()
  if (operator) return safeAccountHint(stripEmail(operator))
  const user = output.match(/^user:\s*(.+)$/mi)?.[1]?.trim()
  if (user) return safeAccountHint(stripEmail(user))
  return undefined
}

function stripEmail(value: string): string {
  return value.replace(/\s*<[^>]+>\s*/g, '').trim()
}
