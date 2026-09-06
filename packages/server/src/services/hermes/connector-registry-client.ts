/**
 * Connector Registry broker client (Connector Registry Phase 2).
 *
 * Reads connector status from the hermes-multitenancy Run Broker
 * (`GET /api/run-broker/connectors`) — the control-plane source of truth — and
 * maps each ConnectorStatus to the WebUI's `SkillCredentialEntry` shape so the
 * existing `/api/auth/skill-credentials` response (and the frontend that
 * consumes it) is unchanged.
 *
 * Reuses the SAME broker config the rest of auth uses (`config.runBrokerUrl` /
 * `config.runBrokerKey`) — it does NOT introduce a second broker client.
 *
 * Fail-safe is load-bearing (plan red line): when the broker is unavailable the
 * caller must NEVER show `authenticated` and must NEVER serve a stale cached
 * authenticated state. `failSafeResult()` returns every known connector in the
 * `error` state for exactly this case.
 */
import { config } from '../../config'
import { logger } from '../logger'
import type {
  SkillCredentialAction,
  SkillCredentialActionKind,
  SkillCredentialEntry,
  SkillCredentialsResult,
  SkillCredentialState,
} from './skill-credentials'

// Broker /connectors does live per-connector CLI checks; a cold (uncached) read
// measures ~11s on prod (the slowest single reader). 8s aborted every cold call,
// collapsing the whole panel to the fail-safe ("检测失败"). 20s clears the cold
// read; the broker caches the result, so warm reads stay ~instant.
const DEFAULT_TIMEOUT_MS = 20000

// Canonical first-party connector ids, in display order. Mirrors the broker's
// builtin.CONNECTOR_ORDER — used only to build the fail-safe error result when
// the broker can't be reached (so the UI still lists them, all as `error`).
const CANONICAL_CONNECTORS: ReadonlyArray<{ id: string; title: string; provider: string }> = [
  { id: 'lark-cli', title: 'Lark-cli', provider: 'lark' },
  { id: 'feishu-project', title: '飞书项目', provider: 'feishu-project' },
  { id: 'keep-record', title: 'Keep-record', provider: 'keep' },
  { id: 'kep-cli-online', title: 'kep-cli online', provider: 'keep' },
  { id: 'kep-cli-pre', title: 'kep-cli pre', provider: 'keep' },
  { id: 'gitlab', title: 'GitLab（全局）', provider: 'gitlab' },
  { id: 'gitlab-personal', title: 'GitLab（我的）', provider: 'gitlab' },
  { id: 'github-mcp', title: 'GitHub', provider: 'github' },
]

const VALID_STATES: ReadonlySet<string> = new Set<SkillCredentialState>([
  'authenticated', 'configured', 'missing', 'needs_auth', 'unknown', 'error',
])
const VALID_ACTION_KINDS: ReadonlySet<string> = new Set<SkillCredentialActionKind>([
  'feishu_device_flow', 'skill_flow', 'qr_flow', 'oauth_url', 'manual', 'retry',
])

export class BrokerUnavailableError extends Error {
  status: number
  constructor(message: string, status = 503) {
    super(message)
    this.name = 'BrokerUnavailableError'
    this.status = status
  }
}

/** Raw connector row as serialized by the broker's ConnectorStatus.to_dict(). */
interface ConnectorStatusDict {
  id: string
  title?: string
  provider?: string
  installed?: boolean
  status?: string
  account_hint?: string
  default_identity?: string
  detail?: string
  required_by?: string[]
  // broker 对「无可执行操作」的卡实际送 null（见 hermes-multitenancy ConnectorStatus.to_dict），
  // wire 类型必须容得下它，否则测试只能靠 `as any` 绕过去。
  action?: { kind?: string; label?: string; command?: string; description?: string; env?: string } | null
  // additive control-plane fields (scope/profile/acting_identity/credential_owner/
  // runtime_policy_owner/kind/stale/expires_at) are intentionally DROPPED in the
  // SkillCredentialEntry mapping — the frontend shape stays unchanged.
}

function coerceState(raw: unknown): SkillCredentialState {
  const s = String(raw || '').trim()
  return (VALID_STATES.has(s) ? s : 'unknown') as SkillCredentialState
}

/** broker 的 action → WebUI 的 action，缺省时返回 undefined。
 *
 * broker 对「这张卡没有员工可执行的操作」送 null/{}（见 hermes-multitenancy
 * ConnectorStatus.to_dict）。以前这里无条件造一个 {kind:'manual', label:''}，把缺省
 * 抹成了"有操作但没标签"，逼客户端拿空 label 当哨兵 —— 那个暗号 2026-08-04 咬过两次。
 * 现在缺省如实向上传递，可选性才真正生效。
 *
 * 判据是 kind 与 label 都没有：只有 label 没有 kind 说明 broker 确实想表达一个操作
 * （只是标签空了），那属于数据问题，不该被静默吞成"无操作"。
 */
function coerceAction(raw: ConnectorStatusDict['action']): SkillCredentialAction | undefined {
  const rawKind = String(raw?.kind || '').trim()
  const rawLabel = String(raw?.label || '').trim()
  if (!rawKind && !rawLabel) return undefined
  const kind = rawKind || 'manual'
  const action: SkillCredentialAction = {
    kind: (VALID_ACTION_KINDS.has(kind) ? kind : 'manual') as SkillCredentialActionKind,
    label: String(raw?.label || ''),
  }
  if (raw?.command) action.command = String(raw.command)
  if (raw?.description) action.description = String(raw.description)
  const env = String(raw?.env || '').trim().toLowerCase()
  if (env === 'pre' || env === 'online') action.env = env
  return action
}

/** Map one broker ConnectorStatus dict → the WebUI SkillCredentialEntry. */
export function mapConnectorToEntry(c: ConnectorStatusDict): SkillCredentialEntry {
  const entry: SkillCredentialEntry = {
    id: String(c.id),
    title: String(c.title || c.id),
    provider: String(c.provider || ''),
    installed: Boolean(c.installed),
    status: coerceState(c.status),
  }
  const action = coerceAction(c.action)
  if (action) entry.action = action
  if (c.account_hint) entry.account_hint = String(c.account_hint)
  if (c.default_identity) entry.default_identity = String(c.default_identity)
  if (c.detail) entry.detail = String(c.detail)
  if (Array.isArray(c.required_by) && c.required_by.length) {
    entry.required_by = c.required_by.map(String)
  }
  return entry
}

/** All known connectors in the `error` state — the broker-unavailable fail-safe. */
export function failSafeResult(profileName: string): SkillCredentialsResult {
  return {
    profile_name: profileName,
    credentials: CANONICAL_CONNECTORS.map(({ id, title, provider }) => ({
      id,
      title,
      provider,
      installed: false,
      status: 'error' as SkillCredentialState,
      detail: '凭证状态服务暂时不可用，请稍后重试（未能确认登录状态）。',
      // 降级态的每一行都必须带 action 且 label 非空：客户端按 action 是否存在渲染按钮，
      // 这里若整个不给 action，broker 一挂面板就一颗按钮都没有，用户连重试都点不了。
      // kind 用专门的 'retry' 而不是 'manual'：这颗按钮的语义是"再读一次状态"，不是
      // "启动认证"。客户端据此分流；靠 status/label 反推会把真 error 态的 GitLab 个人卡
      // 也判成重试、从此进不了绑定表单（codex 复评）。语义写进数据，不靠猜。
      action: { kind: 'retry' as SkillCredentialActionKind, label: '重试' },
    })),
  }
}

/**
 * Fetch connector status from the Run Broker and map to SkillCredentialEntry[].
 * Throws BrokerUnavailableError on non-2xx / timeout / network error — the caller
 * decides the fail-safe (never `authenticated`).
 */
export async function fetchConnectorStatuses(opts: {
  profileName: string
  userKey?: string
  timeoutMs?: number
  fresh?: boolean
}): Promise<SkillCredentialsResult> {
  if (!config.runBrokerUrl) {
    throw new BrokerUnavailableError('HERMES_RUN_BROKER_URL is not configured', 503)
  }
  const params = new URLSearchParams()
  params.set('profile_name', opts.profileName)
  if (opts.userKey) params.set('user_key', opts.userKey)
  // Forward the cache-bypass so the post-auth poll / manual refresh read live.
  if (opts.fresh) params.set('fresh', '1')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`

  let res: Response
  try {
    res = await fetch(`${config.runBrokerUrl}/api/run-broker/connectors?${params.toString()}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err: any) {
    throw new BrokerUnavailableError(`connector broker request failed: ${err?.message || err}`, 503)
  }
  if (!res.ok) {
    throw new BrokerUnavailableError(`connector broker returned HTTP ${res.status}`, res.status)
  }
  const body = await res.json().catch(() => null)
  const rows = body?.connectors
  if (!Array.isArray(rows)) {
    throw new BrokerUnavailableError('connector broker returned no connectors array', 502)
  }
  let credentials: SkillCredentialEntry[]
  try {
    // A malformed row (null / missing id) must surface as a broker fault so the
    // caller's fail-safe kicks in — not as a raw TypeError that becomes a 500.
    credentials = rows.map((r: ConnectorStatusDict) => {
      if (!r || typeof r !== 'object' || !r.id) {
        throw new Error('connector row is missing an id')
      }
      return mapConnectorToEntry(r)
    })
  } catch (err: any) {
    throw new BrokerUnavailableError(`connector broker returned a malformed row: ${err?.message || err}`, 502)
  }
  return {
    profile_name: String(body?.profile_name || opts.profileName),
    credentials,
  }
}

export type ConnectorCatalogView = 'source' | 'canonical'

export interface ConnectorCatalogResponse {
  profile_name: string
  subject_id: string
  view: ConnectorCatalogView
  source_count: number
  canonical_count: number
  connectors: Array<Record<string, any> & { icon?: { url?: string } }>
}

export interface CustomConnectorsResponse {
  profile_name: string
  subject_id: string
  connectors: Array<Record<string, any>>
}

const catalogIconKeys = new Set<string>()

export function isKnownConnectorIconKey(rowKey: string): boolean {
  return rowKey.length > 0 && catalogIconKeys.has(rowKey)
}

function ownerHeaders(profileName: string, ownerOpenId: string): Record<string, string> {
  if (!profileName.trim() || !ownerOpenId.trim()) throw new BrokerUnavailableError('trusted connector owner is required', 403)
  return {
    'Content-Type': 'application/json',
    ...(config.runBrokerKey ? { Authorization: `Bearer ${config.runBrokerKey}` } : {}),
    'X-Hermes-Owner-Open-Id': ownerOpenId,
    'X-Hermes-Profile': profileName,
  }
}

async function ownerBrokerJson<T>(path: string, opts: {
  profileName: string
  ownerOpenId: string
  method?: string
  body?: Record<string, unknown>
  timeoutMs?: number
}): Promise<T> {
  if (!config.runBrokerUrl) throw new BrokerUnavailableError('HERMES_RUN_BROKER_URL is not configured', 503)
  const response = await fetch(`${config.runBrokerUrl}${path}`, {
    method: opts.method || 'GET',
    headers: ownerHeaders(opts.profileName, opts.ownerOpenId),
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  }).catch((err: any) => {
    throw new BrokerUnavailableError(`connector broker request failed: ${err?.message || err}`, 503)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new BrokerUnavailableError(String(body?.error || `connector broker returned HTTP ${response.status}`), response.status)
  return body as T
}

export async function fetchConnectorCatalog(opts: {
  profileName: string
  ownerOpenId: string
  view: ConnectorCatalogView
}): Promise<ConnectorCatalogResponse> {
  const body = await ownerBrokerJson<ConnectorCatalogResponse>(
    `/api/run-broker/connector-catalog?view=${opts.view}`,
    opts,
  )
  const expected = opts.view === 'canonical' ? 330 : 642
  if (body.source_count !== 642 || body.canonical_count !== 330 || !Array.isArray(body.connectors) || body.connectors.length !== expected) {
    throw new BrokerUnavailableError('connector catalog counts are invalid', 502)
  }
  for (const row of body.connectors) {
    const rowKey = String(row.row_key || '')
    if (rowKey) catalogIconKeys.add(rowKey)
  }
  body.connectors = body.connectors.map((row) => ({
    ...row,
    ...(row.icon ? {
      icon: {
        ...row.icon,
        url: `/api/auth/skill-credentials/catalog/icon?row_key=${encodeURIComponent(String(row.row_key || ''))}`,
      },
    } : {}),
  }))
  return body
}

export function listCustomConnectors(opts: { profileName: string; ownerOpenId: string }) {
  return ownerBrokerJson<CustomConnectorsResponse>('/api/run-broker/custom-connectors', opts)
}

export function importCustomConnectors(opts: { profileName: string; ownerOpenId: string; config: string }) {
  if (!opts.config || Buffer.byteLength(opts.config) > 64 * 1024) {
    throw new BrokerUnavailableError('connector config is empty or too large', 400)
  }
  return ownerBrokerJson<CustomConnectorsResponse>('/api/run-broker/custom-connectors/import', {
    ...opts,
    method: 'POST',
    body: { config: opts.config },
  })
}

export function connectCatalogConnector(opts: {
  profileName: string
  ownerOpenId: string
  rowKey: string
  fields?: Record<string, string>
}) {
  if (!opts.rowKey || opts.rowKey.length > 256) {
    throw new BrokerUnavailableError('invalid connector catalog row key', 400)
  }
  if (opts.fields) {
    const entries = Object.entries(opts.fields)
    if (!entries.length || entries.length > 32 || entries.some(([name, value]) => (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
      || typeof value !== 'string' || !value || value.length > 8192 || /[\r\n]/.test(value)
    ))) throw new BrokerUnavailableError('invalid connector credential fields', 400)
  }
  return ownerBrokerJson<CustomConnectorsResponse>('/api/run-broker/connector-catalog/connect', {
    ...opts,
    method: 'POST',
    body: { row_key: opts.rowKey, ...(opts.fields ? { fields: opts.fields } : {}) },
    timeoutMs: 180_000,
  })
}

export function fetchCatalogConnectorStatus(opts: {
  profileName: string
  ownerOpenId: string
  rowKey: string
}) {
  if (!opts.rowKey || opts.rowKey.length > 256) {
    throw new BrokerUnavailableError('invalid connector catalog row key', 400)
  }
  return ownerBrokerJson<{ profile_name: string; subject_id: string; connector: unknown; ready: boolean }>(
    '/api/run-broker/connector-catalog/status',
    { ...opts, method: 'POST', body: { row_key: opts.rowKey }, timeoutMs: 60_000 },
  )
}

export function deleteCustomConnector(opts: { profileName: string; ownerOpenId: string; connectorId: string }) {
  return ownerBrokerJson<{ ok: true }>(`/api/run-broker/custom-connectors/${encodeURIComponent(opts.connectorId)}`, {
    ...opts,
    method: 'DELETE',
  })
}

export async function completeCatalogOAuth(opts: { state: string; code: string }) {
  if (!config.runBrokerUrl) throw new BrokerUnavailableError('HERMES_RUN_BROKER_URL is not configured', 503)
  if (!opts.state || opts.state.length > 512 || !opts.code || opts.code.length > 8192) {
    throw new BrokerUnavailableError('invalid catalog OAuth callback', 400)
  }
  const response = await fetch(`${config.runBrokerUrl}/api/run-broker/connector-catalog/oauth/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.runBrokerKey ? { Authorization: `Bearer ${config.runBrokerKey}` } : {}),
    },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(60000),
  }).catch((err: any) => {
    throw new BrokerUnavailableError(`connector broker request failed: ${err?.message || err}`, 503)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new BrokerUnavailableError(String(body?.error || `connector broker returned HTTP ${response.status}`), response.status)
  return body as { ok: true }
}

export async function fetchConnectorIcon(rowKey: string): Promise<Response> {
  if (!config.runBrokerUrl) throw new BrokerUnavailableError('HERMES_RUN_BROKER_URL is not configured', 503)
  const headers: Record<string, string> = config.runBrokerKey
    ? { Authorization: `Bearer ${config.runBrokerKey}` }
    : {}
  return fetch(
    `${config.runBrokerUrl}/api/run-broker/connector-catalog/icon?row_key=${encodeURIComponent(rowKey)}`,
    { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) },
  ).catch((err: any) => {
    throw new BrokerUnavailableError(`connector icon request failed: ${err?.message || err}`, 503)
  })
}

// --- Phase 1.5 shadow compare (redacted; never logs a secret) ---------------

interface ShadowFieldDiff {
  id: string
  field: 'status' | 'action.kind' | 'required_by' | 'account_hint_present' | 'present'
  local: string
  broker: string
}

/**
 * Compare local vs broker results field-by-field. Returns ONLY redacted shape
 * info (ids, status enums, action kinds, required_by counts, account-hint
 * presence) — never the secret-bearing values (no account values, no tokens).
 */
export function shadowDiff(
  local: SkillCredentialsResult,
  broker: SkillCredentialsResult,
): ShadowFieldDiff[] {
  const diffs: ShadowFieldDiff[] = []
  const byId = (r: SkillCredentialsResult) => new Map(r.credentials.map((c) => [c.id, c]))
  const l = byId(local)
  const b = byId(broker)
  const ids = new Set<string>([...l.keys(), ...b.keys()])
  for (const id of ids) {
    const lc = l.get(id)
    const bc = b.get(id)
    if (!lc || !bc) {
      diffs.push({ id, field: 'present', local: lc ? 'yes' : 'no', broker: bc ? 'yes' : 'no' })
      continue
    }
    if (lc.status !== bc.status) {
      diffs.push({ id, field: 'status', local: lc.status, broker: bc.status })
    }
    // action 可缺省（= 这张卡没有员工可执行的操作）。把缺省当成一等取值 'none' 参与
    // 比对，而不是跳过：一侧有操作、另一侧没有，正是最值得报的那种漂移。
    const lKind = lc.action?.kind ?? 'none'
    const bKind = bc.action?.kind ?? 'none'
    if (lKind !== bKind) {
      diffs.push({ id, field: 'action.kind', local: lKind, broker: bKind })
    }
    const lReq = (lc.required_by || []).length
    const bReq = (bc.required_by || []).length
    if (lReq !== bReq) {
      diffs.push({ id, field: 'required_by', local: String(lReq), broker: String(bReq) })
    }
    const lHint = lc.account_hint ? 'yes' : 'no'
    const bHint = bc.account_hint ? 'yes' : 'no'
    if (lHint !== bHint) {
      diffs.push({ id, field: 'account_hint_present', local: lHint, broker: bHint })
    }
  }
  return diffs
}

/**
 * Run a background shadow comparison and log a redacted summary. Never throws,
 * never blocks, never changes the served result. `served` is the source the
 * user actually got; `other` is fetched here for comparison.
 */
export async function runShadowCompare(opts: {
  profileName: string
  userKey?: string
  servedSource: 'local' | 'broker'
  servedResult: SkillCredentialsResult
  fetchOther: () => Promise<SkillCredentialsResult>
}): Promise<void> {
  try {
    const other = await opts.fetchOther()
    const local = opts.servedSource === 'local' ? opts.servedResult : other
    const broker = opts.servedSource === 'broker' ? opts.servedResult : other
    const diffs = shadowDiff(local, broker)
    if (diffs.length === 0) {
      logger.info(
        { profile: opts.profileName, served: opts.servedSource, diffs: 0 },
        '[connector-shadow] local/broker connector status in agreement',
      )
    } else {
      logger.warn(
        { profile: opts.profileName, served: opts.servedSource, diffCount: diffs.length, diffs },
        '[connector-shadow] local/broker connector status DIFFER (redacted)',
      )
    }
  } catch (err: any) {
    logger.warn(
      { profile: opts.profileName, err: err?.message || String(err) },
      '[connector-shadow] shadow compare could not complete (ignored)',
    )
  }
}
