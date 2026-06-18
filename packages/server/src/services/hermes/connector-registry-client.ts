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

const DEFAULT_TIMEOUT_MS = 8000

// Canonical first-party connector ids, in display order. Mirrors the broker's
// builtin.CONNECTOR_ORDER — used only to build the fail-safe error result when
// the broker can't be reached (so the UI still lists them, all as `error`).
const CANONICAL_CONNECTORS: ReadonlyArray<{ id: string; title: string; provider: string }> = [
  { id: 'lark-cli', title: 'Lark-cli', provider: 'lark' },
  { id: 'feishu-project', title: '飞书项目', provider: 'feishu-project' },
  { id: 'keep-record', title: 'Keep-record', provider: 'keep' },
  { id: 'kep-cli', title: 'kep-cli', provider: 'keep' },
  { id: 'gitlab', title: 'GitLab', provider: 'gitlab' },
]

const VALID_STATES: ReadonlySet<string> = new Set<SkillCredentialState>([
  'authenticated', 'configured', 'missing', 'needs_auth', 'unknown', 'error',
])
const VALID_ACTION_KINDS: ReadonlySet<string> = new Set<SkillCredentialActionKind>([
  'feishu_device_flow', 'skill_flow', 'qr_flow', 'oauth_url', 'manual',
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
  action?: { kind?: string; label?: string; command?: string; description?: string }
  // additive control-plane fields (scope/profile/acting_identity/credential_owner/
  // runtime_policy_owner/kind/stale/expires_at) are intentionally DROPPED in the
  // SkillCredentialEntry mapping — the frontend shape stays unchanged.
}

function coerceState(raw: unknown): SkillCredentialState {
  const s = String(raw || '').trim()
  return (VALID_STATES.has(s) ? s : 'unknown') as SkillCredentialState
}

function coerceAction(raw: ConnectorStatusDict['action']): SkillCredentialAction {
  const kind = String(raw?.kind || 'manual')
  const action: SkillCredentialAction = {
    kind: (VALID_ACTION_KINDS.has(kind) ? kind : 'manual') as SkillCredentialActionKind,
    label: String(raw?.label || ''),
  }
  if (raw?.command) action.command = String(raw.command)
  if (raw?.description) action.description = String(raw.description)
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
    action: coerceAction(c.action),
  }
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
      action: { kind: 'manual' as SkillCredentialActionKind, label: '' },
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
}): Promise<SkillCredentialsResult> {
  if (!config.runBrokerUrl) {
    throw new BrokerUnavailableError('HERMES_RUN_BROKER_URL is not configured', 503)
  }
  const params = new URLSearchParams()
  params.set('profile_name', opts.profileName)
  if (opts.userKey) params.set('user_key', opts.userKey)
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
  return {
    profile_name: String(body?.profile_name || opts.profileName),
    credentials: rows.map((r: ConnectorStatusDict) => mapConnectorToEntry(r)),
  }
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
    if (lc.action.kind !== bc.action.kind) {
      diffs.push({ id, field: 'action.kind', local: lc.action.kind, broker: bc.action.kind })
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
