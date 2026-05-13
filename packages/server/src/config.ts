import { resolve } from 'path'
import { homedir } from 'os'

export type WebPlane = 'chat' | 'ops' | 'both'
export type AuthMode = 'token' | 'trusted-feishu' | 'feishu-oauth-dev'

export function getListenHost(env: Record<string, string | undefined> = process.env): string | undefined {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

export function getFeishuCallbackRedirect(env: Record<string, string | undefined> = process.env): string {
  const redirect = env.FEISHU_CALLBACK_REDIRECT?.trim()
  return redirect || '/#/hermes/chat'
}

function parseWebPlane(raw: string | undefined): WebPlane {
  const value = raw?.trim().toLowerCase()
  if (value === 'chat' || value === 'ops' || value === 'both') return value
  return 'both'
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const value = raw?.trim().toLowerCase()
  if (value === 'trusted-feishu' || value === 'feishu-oauth-dev') return value
  return 'token'
}

export function parseBool(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/**
 * Auth is disabled only when AUTH_DISABLED is explicitly truthy
 * (1 / true / yes / on, case-insensitive).
 *
 * Strings like "false" / "0" / "" / "no" all keep auth ENABLED.
 */
export function isAuthDisabled(): boolean {
  return parseBool(process.env.AUTH_DISABLED)
}

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  uploadDir: process.env.UPLOAD_DIR || resolve(homedir(), '.hermes-web-ui', 'upload'),
  dataDir: resolve(__dirname, '..', 'data'),
  // SECURITY: defaults to same-origin (no Access-Control-Allow-Origin emitted).
  // Set CORS_ORIGINS to '*' or a comma-separated list of origins to opt back
  // into cross-origin access. Combined with localStorage tokens, '*' makes a
  // single XSS sufficient to exfiltrate the API key — keep it tight unless
  // you control all callers.
  corsOrigins: process.env.CORS_ORIGINS || '',
  /** Session store: 'local' (self-built SQLite) or 'remote' (Hermes CLI) */
  sessionStore: (process.env.SESSION_STORE || 'local') as 'local' | 'remote',
  webPlane: parseWebPlane(process.env.HERMES_WEB_PLANE),
  authMode: parseAuthMode(process.env.HERMES_AUTH_MODE),
  trustedHeaderOpenId: process.env.HERMES_TRUSTED_HEADER_OPENID || 'X-Feishu-OpenID',
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
  chatPlaneAllowSettings: parseBool(process.env.HERMES_CHAT_PLANE_ALLOW_SETTINGS),
  chatPlaneTempOpenAdmin: parseBool(process.env.HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN),
}
