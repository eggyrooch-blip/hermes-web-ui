import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import type { Dirent } from 'fs'
import { basename, delimiter, dirname, join } from 'path'
import { execFile, spawn } from 'child_process'
import type { ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { promisify } from 'util'
import { createHash } from 'crypto'
import type { WebUser } from '../request-context'

export type SkillCredentialState = 'authenticated' | 'configured' | 'missing' | 'needs_auth' | 'unknown' | 'error'
export type SkillCredentialActionKind = 'feishu_device_flow' | 'skill_flow' | 'qr_flow' | 'oauth_url' | 'manual'

const execFileAsync = promisify(execFile)
type KepAuthLoginProcess = ChildProcessByStdio<null, Readable, Readable>

const activeKepAuthLogins = new Map<string, KepAuthLoginProcess>()

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
}

interface ProfileSkill {
  name: string
  dir: string
  path: string
  tags: string[]
  text: string
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

export async function listSkillCredentialStatuses(options: ListSkillCredentialOptions): Promise<SkillCredentialsResult> {
  const profileName = options.profileName
  const profileDir = options.profileDir
  const skills = scanProfileSkills(profileDir)
  return {
    profile_name: profileName,
    credentials: [
      larkCliStatus(options),
      keepRecordStatus(profileDir, skills),
      await kepCliStatus(profileDir, profileName, skills),
      gitlabStatus(profileDir, skills),
    ],
  }
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
  if (existing && !existing.killed) existing.kill()

  const child = spawn(bin, ['--profile', options.profileName, '--env', 'online', 'login'], {
    cwd: options.profileDir,
    env: kepAuthEnv(options.profileDir, options.profileName, false),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeKepAuthLogins.set(sessionKey, child)
  child.on('exit', () => {
    if (activeKepAuthLogins.get(sessionKey) === child) activeKepAuthLogins.delete(sessionKey)
  })

  const verificationUri = await waitForKepAuthUrl(child)
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

function waitForKepAuthUrl(child: KepAuthLoginProcess): Promise<string> {
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
    const timer = setTimeout(() => {
      done(new Error('kep-auth login did not return an authorization URL in time'))
      if (!child.killed) child.kill()
    }, 10_000)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', onExit)
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

function larkCliStatus(options: ListSkillCredentialOptions): SkillCredentialEntry {
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

async function kepCliStatus(profileDir: string, profileName: string, skills = scanProfileSkills(profileDir)): Promise<SkillCredentialEntry> {
  const skill = findKepCliSkill(skills)
  const installed = Boolean(skill)
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
        results.push({
          name: parseSkillName(text) || basename(dirname(fullPath)),
          dir: dirname(fullPath),
          path: fullPath,
          tags: parseSkillTags(text),
          text,
        })
      }
    }
  }
  visit(root, 0)
  return results
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
      text.includes('gitlab_token') ||
      text.includes('gitlab.gotokeep.com')
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
