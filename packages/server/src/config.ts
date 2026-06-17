import { join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Web UI environment variables.
 *
 * Server/listen:
 * - PORT: Web UI listen port. Default: 8648.
 * - BIND_HOST: Web UI bind host. Default: 0.0.0.0.
 * - CORS_ORIGINS: Comma/space-separated cross-origin allowlist. Default: same host only.
 *
 * Web UI storage:
 * - HERMES_WEB_UI_HOME: Web UI data home for auth token, credentials, logs, DB, and default uploads.
 * - HERMES_WEBUI_STATE_DIR: Compatibility alias for HERMES_WEB_UI_HOME.
 *   Default: join(homedir(), '.hermes-web-ui').
 * - UPLOAD_DIR: Upload directory override. Default: join(HERMES_WEB_UI_HOME, 'upload').
 * - dataDir: Development-only internal Web UI runtime data directory.
 *
 * Auth:
 * - AUTH_TOKEN: Explicit bearer token. If unset, Web UI stores an auto-generated token under HERMES_WEB_UI_HOME.
 *
 * Runtime behavior:
 * - PROFILE: Initial Hermes profile name. Default: default.
 * - HERMES_GATEWAY_URL / GATEWAY_URL: Explicit Hermes gateway upstream URL for proxy routes.
 * - GATEWAY_HOST: Default Hermes gateway upstream host. Default: 127.0.0.1.
 * - GATEWAY_PORT: Default Hermes gateway upstream port. Default: 8642.
 * - HERMES_WEB_UI_MANAGED_GATEWAY: Web UI-managed Hermes gateway handling. Enabled by default; set 0/false/off to use CLI start.
 * - HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: Whether Web UI shutdown also stops managed gateways.
 * - HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: Disable Hermes Studio MCP config injection.
 * - HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT: Allow MCP injection when HERMES_WEB_UI_HOME is under a temp dir.
 * - HERMES_LAN_DISCOVERY_ENABLED: Set false/0/off to disable UDP LAN discovery responder.
 * - HERMES_LAN_DISCOVERY_HTTP_PORTS: HTTP ports to probe during UDP discovery scans. Default: 8648,8748 plus current PORT.
 * - WORKSPACE_BASE: Base directory for workspace browsing. Default: current user's home directory.
 *
 * Limits/logging:
 * - MAX_DOWNLOAD_SIZE: Max file download size. Default: 200MB.
 * - MAX_EDIT_SIZE: Max editable file size. Default: 10MB.
 * - LOG_LEVEL: Server log level. Default: info.
 * - BRIDGE_LOG_LEVEL: Bridge log level. Default: LOG_LEVEL or info.
 */

export type WebPlane = 'chat' | 'ops' | 'both'
export type AuthMode = 'token' | 'trusted-feishu' | 'feishu-oauth-dev'

export function getListenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

export function getFeishuCallbackRedirect(env: Record<string, string | undefined> = process.env): string {
  const redirect = env.FEISHU_CALLBACK_REDIRECT?.trim()
  return redirect || '/#/hermes/chat'
}

export function getWebUiHome(env: Record<string, string | undefined> = process.env): string {
  const appHome = env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  return appHome ? resolve(appHome) : join(homedir(), '.hermes-web-ui')
}

export function shouldCreateWebUiDataDir(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production'
}

export function getCorsOrigins(env: Record<string, string | undefined> = process.env): string {
  return env.CORS_ORIGINS?.trim() || ''
}

export function getRunBrokerUrl(env: Record<string, string | undefined> = process.env): string {
  return env.HERMES_RUN_BROKER_URL?.trim().replace(/\/+$/, '') || ''
}

export function getRunBrokerKey(env: Record<string, string | undefined> = process.env): string {
  return env.HERMES_RUN_BROKER_KEY?.trim() || ''
}

export function parseBool(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export function getJobsBrokerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.HERMES_WEBUI_JOBS_BROKER
  if (explicit !== undefined) return parseBool(explicit)
  return parseBool(env.HERMES_WEBUI_RUN_BROKER)
}

function parseWebPlane(raw: string | undefined): WebPlane {
  const value = raw?.trim().toLowerCase()
  if (value === 'chat' || value === 'ops' || value === 'both') return value
  return 'both'
}

// Fork security invariant: a Feishu auth mode IS the multi-tenant chat plane.
// The entire defense (enforcePlaneAccess blocklist + every controller's per-profile
// isolation) is gated on webPlane === 'chat'. If a Feishu deployment forgot to also
// set HERMES_WEB_PLANE=chat, that gate would silently disable and every tenant could
// reach admin endpoints + other tenants' data. So derive 'chat' from the auth mode
// rather than trusting two env vars to stay in sync.
function getEffectiveWebPlane(): WebPlane {
  const authMode = parseAuthMode(process.env.HERMES_AUTH_MODE)
  if (authMode === 'feishu-oauth-dev' || authMode === 'trusted-feishu') return 'chat'
  return parseWebPlane(process.env.HERMES_WEB_PLANE)
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const value = raw?.trim().toLowerCase()
  if (value === 'trusted-feishu' || value === 'feishu-oauth-dev') return value
  return 'token'
}

export function isAuthDisabled(): boolean {
  return parseBool(process.env.AUTH_DISABLED)
}

const appHome = getWebUiHome()

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  appHome,
  uploadDir: process.env.UPLOAD_DIR || join(appHome, 'upload'),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: getCorsOrigins(),
  sessionStore: (process.env.SESSION_STORE || 'local') as 'local' | 'remote',
  webPlane: getEffectiveWebPlane(),
  authMode: parseAuthMode(process.env.HERMES_AUTH_MODE),
  trustedHeaderOpenId: process.env.HERMES_TRUSTED_HEADER_OPENID || 'X-Feishu-OpenID',
  trustedHeaderName: process.env.HERMES_TRUSTED_HEADER_NAME || 'X-Feishu-Name',
  trustedHeaderAvatarUrl: process.env.HERMES_TRUSTED_HEADER_AVATAR_URL || 'X-Feishu-Avatar-Url',
  trustedHeaderTimestamp: process.env.HERMES_TRUSTED_HEADER_TIMESTAMP || 'X-Hermes-Auth-Timestamp',
  trustedHeaderSignature: process.env.HERMES_TRUSTED_HEADER_SIG || 'X-Hermes-Auth-Signature',
  trustedHeaderSecret: process.env.HERMES_TRUSTED_HEADER_SECRET || '',
  trustedHeaderMaxAgeSeconds: parseInt(process.env.HERMES_TRUSTED_HEADER_MAX_AGE_SECONDS || '300', 10),
  multitenancyDb: process.env.HERMES_MULTITENANCY_DB || resolve(homedir(), '.hermes', 'multitenancy.db'),
  requiredProfile: process.env.HERMES_REQUIRED_PROFILE?.trim() || '',
  feishuAppId: process.env.FEISHU_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
  feishuRedirectUri: process.env.FEISHU_REDIRECT_URI || '',
  feishuAuthorizeUrl: process.env.FEISHU_AUTHORIZE_URL || 'https://open.feishu.cn/open-apis/authen/v1/index',
  feishuApiBaseUrl: process.env.FEISHU_API_BASE_URL || 'https://open.feishu.cn',
  feishuSessionSecret: process.env.FEISHU_SESSION_SECRET || '',
  feishuSessionMaxAgeSeconds: parseInt(process.env.FEISHU_SESSION_MAX_AGE_SECONDS || String(7 * 24 * 60 * 60), 10),
  feishuCallbackRedirect: getFeishuCallbackRedirect(),
  webuiRunBroker: parseBool(process.env.HERMES_WEBUI_RUN_BROKER),
  webuiJobsBroker: getJobsBrokerEnabled(),
  runBrokerUrl: getRunBrokerUrl(),
  runBrokerKey: getRunBrokerKey(),
  chatPlaneAllowSettings: parseBool(process.env.HERMES_CHAT_PLANE_ALLOW_SETTINGS),
  chatPlaneTempOpenAdmin: parseBool(process.env.HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN),
}
