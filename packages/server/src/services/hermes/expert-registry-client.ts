/**
 * Expert registry broker client (专家广场).
 *
 * Reads the expert catalog from the hermes-multitenancy Run Broker
 * (`GET /api/run-broker/experts`) — the control-plane source of truth — and
 * returns the display + capability fields for the WebUI catalog. The expert
 * persona (agent_md) is NEVER part of this payload; it lives only in the
 * multitenancy run-time overlay and never reaches the browser.
 *
 * Reuses the SAME broker config the rest of the BFF uses
 * (`config.runBrokerUrl` / `config.runBrokerKey`) — it does NOT introduce a
 * second broker client.
 *
 * Fail-safe: when the broker is unavailable the catalog is served EMPTY (never
 * a fabricated expert). The UI shows an empty / retry state rather than a
 * misleading card.
 */
import { config } from '../../config'
import { logger } from '../logger'

const DEFAULT_TIMEOUT_MS = 8000

export interface ExpertGovernance {
  env_default?: string
  approval_required?: string[]
  online_requires?: string
}

export interface ExpertEntry {
  id: string
  name: string
  title?: string
  tagline?: string
  avatar?: string
  category?: string
  display_tags?: string[]
  featured?: boolean
  team?: string | null
  skills?: string[]
  governance?: ExpertGovernance
  plugin_id?: string
  /** Distribution source ('aihub' = ingested managed plugin) → drives the 来自 AiHub badge. */
  source?: string
  from_aihub?: boolean
}

export interface ExpertListResult {
  experts: ExpertEntry[]
  profile_name?: string
}

const BROKER_ASSET_PREFIX = '/api/run-broker/plugin-assets/'
const WEBUI_ASSET_PREFIX = '/api/hermes/plugin-assets/'
const ASSET_COMPONENT_RE = /^[A-Za-z0-9_.:-]{1,180}$/

export class BrokerUnavailableError extends Error {
  status: number
  constructor(message: string, status = 503) {
    super(message)
    this.name = 'BrokerUnavailableError'
    this.status = status
  }
}

/** Raw expert row as serialized by the broker. */
interface ExpertRowDict {
  id?: string
  name?: string
  title?: string
  tagline?: string
  avatar?: string
  category?: string
  display_tags?: unknown
  featured?: unknown
  team?: unknown
  skills?: unknown
  governance?: Record<string, unknown>
  plugin_id?: string
  source?: unknown
  from_aihub?: unknown
  // The persona (`agent_md`) MUST NOT be surfaced; it is dropped here even if
  // the broker ever includes it.
}

function strArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.map((v) => String(v)).filter((v) => v.length > 0)
  return out.length ? out : undefined
}

function coerceGovernance(raw: ExpertRowDict['governance']): ExpertGovernance | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const gov: ExpertGovernance = {}
  if (raw.env_default) gov.env_default = String(raw.env_default)
  const approvals = strArray(raw.approval_required)
  if (approvals) gov.approval_required = approvals
  if (raw.online_requires) gov.online_requires = String(raw.online_requires)
  return Object.keys(gov).length ? gov : undefined
}

export function brokerAssetUrlToWebUrl(raw: string): string {
  if (!raw.startsWith(BROKER_ASSET_PREFIX)) return raw
  const parts = raw.slice(BROKER_ASSET_PREFIX.length).split('/')
  if (parts.length !== 2 || !parts.every((part) => ASSET_COMPONENT_RE.test(part))) {
    return raw
  }
  return WEBUI_ASSET_PREFIX + parts.join('/')
}

/** Map one broker expert row → the WebUI ExpertEntry (persona stripped). */
export function mapExpertRow(r: ExpertRowDict): ExpertEntry {
  const entry: ExpertEntry = {
    id: String(r.id),
    name: String(r.name || r.title || r.id),
  }
  if (r.title) entry.title = String(r.title)
  if (r.tagline) entry.tagline = String(r.tagline)
  if (r.avatar) entry.avatar = brokerAssetUrlToWebUrl(String(r.avatar))
  if (r.category) entry.category = String(r.category)
  const tags = strArray(r.display_tags)
  if (tags) entry.display_tags = tags
  if (typeof r.featured === 'boolean') entry.featured = r.featured
  if (r.team === null || typeof r.team === 'string') entry.team = (r.team as string | null)
  const skills = strArray(r.skills)
  if (skills) entry.skills = skills
  const gov = coerceGovernance(r.governance)
  if (gov) entry.governance = gov
  if (r.plugin_id) entry.plugin_id = String(r.plugin_id)
  if (r.source) entry.source = String(r.source)
  if (typeof r.from_aihub === 'boolean') entry.from_aihub = r.from_aihub
  return entry
}

/**
 * Fetch the expert catalog from the Run Broker and map to ExpertEntry[].
 * Throws BrokerUnavailableError on non-2xx / timeout / network error — the
 * caller decides the fail-safe (an empty catalog).
 */
export async function fetchExpertCatalog(opts: {
  profileName: string
  userKey?: string
  timeoutMs?: number
}): Promise<ExpertListResult> {
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
    res = await fetch(`${config.runBrokerUrl}/api/run-broker/experts?${params.toString()}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err: any) {
    throw new BrokerUnavailableError(`expert broker request failed: ${err?.message || err}`, 503)
  }
  if (!res.ok) {
    throw new BrokerUnavailableError(`expert broker returned HTTP ${res.status}`, res.status)
  }
  const body = await res.json().catch(() => null)
  const rows = body?.experts
  if (!Array.isArray(rows)) {
    throw new BrokerUnavailableError('expert broker returned no experts array', 502)
  }
  const experts: ExpertEntry[] = []
  for (const r of rows as ExpertRowDict[]) {
    if (!r || typeof r !== 'object' || !r.id) continue
    experts.push(mapExpertRow(r))
  }
  return {
    experts,
    profile_name: String(body?.profile_name || opts.profileName),
  }
}

/** Empty catalog — the broker-unavailable fail-safe (never fabricate experts). */
export function emptyCatalog(profileName: string): ExpertListResult {
  logger.warn({ profile: profileName }, '[expert-registry] broker unavailable — serving empty catalog')
  return { experts: [], profile_name: profileName }
}
