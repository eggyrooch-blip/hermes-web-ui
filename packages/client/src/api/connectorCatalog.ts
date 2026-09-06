import { request } from './client'

export type ConnectorCatalogView = 'source' | 'canonical'
export type ConnectorVerdict = 'pass' | 'needs_auth' | 'needs_sandbox' | 'incompatible' | 'rejected'

export interface ConnectorCatalogEntry {
  row_key?: string
  canonical_key: string
  catalog_id?: string
  name?: string
  description?: string
  product?: string
  transport?: string
  download_count?: number | null
  download_count_status?: string
  final_verdict?: ConnectorVerdict
  reason_code?: string
  next_action?: string
  risks?: string[]
  credential_schema?: Record<string, unknown>
  action?: {
    kind: 'connect' | 'revoke' | 'authorize' | 'authorize_cli' | 'install_sandbox' | 'blocked' | 'choose_source'
    label: string
    available: boolean
    installation_name?: string
    connector_id?: string
    fields?: string[]
    auth_flow?: 'mcp_oauth' | 'feishu_device_flow'
    status?: string
  }
  verdicts?: Partial<Record<ConnectorVerdict, number>>
  source_row_count?: number
  products?: string[]
  icon?: { url?: string; status?: string; source?: string }
}

export interface ConnectorCatalogResponse {
  profile_name: string
  subject_id: string
  view: ConnectorCatalogView
  source_count: number
  canonical_count: number
  connectors: ConnectorCatalogEntry[]
}

export interface CustomConnectorEntry {
  connector_id: string
  name: string
  transport: 'streamable_http' | 'sse' | 'stdio' | 'cli'
  endpoint: string
  credential_fields: string[]
  state: string
  updated_at: number
}

export interface CustomConnectorsResponse {
  profile_name: string
  subject_id: string
  connectors: CustomConnectorEntry[]
}

export interface CatalogOAuthStartResponse {
  profile_name: string
  subject_id: string
  authorization_url: string
  connector_id?: string
  status?: 'authorizing'
}

function withQuery(path: string, extra?: Record<string, string>) {
  const query = new URLSearchParams(extra)
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function fetchConnectorCatalog(view: ConnectorCatalogView) {
  return request<ConnectorCatalogResponse>(withQuery('/api/auth/skill-credentials/catalog', { view }))
}

export function fetchCustomConnectors() {
  return request<CustomConnectorsResponse>('/api/auth/skill-credentials/custom')
}

export function importCustomConnectors(config: string) {
  return request<CustomConnectorsResponse>('/api/auth/skill-credentials/custom/import', {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
}

export function connectCatalogConnector(rowKey: string, fields?: Record<string, string>) {
  return request<CustomConnectorsResponse | CatalogOAuthStartResponse>('/api/auth/skill-credentials/catalog/connect', {
    method: 'POST',
    body: JSON.stringify({ row_key: rowKey, ...(fields ? { fields } : {}) }),
  })
}

export function fetchCatalogConnectorStatus(rowKey: string) {
  return request<{
    profile_name: string
    subject_id: string
    connector: CustomConnectorEntry
    ready: boolean
  }>('/api/auth/skill-credentials/catalog/status', {
    method: 'POST',
    body: JSON.stringify({ row_key: rowKey }),
  })
}

export function deleteCustomConnector(connectorId: string) {
  return request<{ ok: true }>(
    `/api/auth/skill-credentials/custom/${encodeURIComponent(connectorId)}`,
    { method: 'DELETE' },
  )
}
