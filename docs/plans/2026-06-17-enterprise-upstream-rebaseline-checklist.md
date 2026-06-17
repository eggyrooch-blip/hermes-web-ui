# Enterprise Upstream Rebaseline Checklist

This fork follows upstream UI where it helps product velocity, but the enterprise
tenant boundary is stricter than upstream's local desktop/admin assumptions.

## Non-Negotiable Boundaries

- Browser users authenticate through Feishu/trusted identity. Do not make local
  password/JWT state the source of truth for user-mode access.
- WebUI is an adapter in front of multitenancy and profile-owned runtime state.
  Do not let ordinary users configure instance-wide operations.
- Keep chat execution on the multitenancy Run Broker path. Do not port upstream
  bridge execution unless owner/profile/sandbox parity is explicitly rebuilt.
- Do not expose self-update, desktop runtime update, release promotion, GitHub,
  Website, or changelog calls in the enterprise sidebar.

## User Chrome

- `AppSidebar` must not render `updateVersion`, `reloadClientVersion`,
  `versionManagement`, `Studio v...`, update buttons, version management modals,
  changelog buttons, or product promotion links.
- Ordinary users may use chat, history, jobs, kanban, skills, memory, group
  chat, files, settings, and connectors when those views keep existing
  owner/profile guards.
- Logs, channels, devices, Plugins inventory, Coding Agents install/config,
  MCP manager, profiles, performance, terminal, version preview, and model
  provider management are super-admin-only.
- The chat model picker remains available. `/hermes/models` is provider/cache
  management and must stay super-admin-only.
- Chat's new-session agent picker must not offer Claude Code/Codex to ordinary
  users; those choices depend on host-level coding-agent status and launch
  configuration.

## Settings

- Ordinary users only see `display`, `session`, and `privacy` tabs.
- `account`, `users`, `agent`, `memory`, `compression`, `models`, and `voice`
  tabs are super-admin-only.
- Do not expose username/password changes, locked IP management, gateway
  auto-start, provider defaults, or agent/runtime configuration to employees.

## Feishu Auth

- `/api/auth/me` must preserve Feishu fields: `openid`, `profile`, `name`,
  `avatarUrl`, and `profiles`.
- `profiles` store must keep `currentUser`, and the sidebar must render the
  Feishu avatar/name/profile card when present. The sidebar must still refresh
  `/api/auth/me` on mount so persisted user-card cache cannot outlive the
  current server session.
- `feishu-oauth-dev` uses an httpOnly cookie, not a JS token. Route guards and
  client stores that need protected API access must use
  `canAccessProtectedRoutes()`, not `hasApiKey()`.
- A protected route in Feishu cookie mode must not bounce through `/login` just
  because `localStorage.hermes_api_key` is empty.
- Fresh Feishu OAuth callbacks land directly on `/#/hermes/chat` with no
  `localStorage.hermes_auth_mode`; the router must discover server auth mode
  from `/api/auth/status` before deciding the user is unauthenticated.
- Feishu/trusted modes must not decode stale `localStorage.hermes_api_key`
  claims for username, role, admin navigation, or route gates.
- Feishu/trusted route guards must verify `/api/auth/me` before rendering
  protected chrome on a fresh page load. If that check fails, clear both
  runtime mode and stale local JWT state.
- Sidebar logout must clear the server session cookie with
  `POST /api/auth/feishu/logout` before reloading; clearing localStorage alone
  is not a Feishu logout.
- `trusted-feishu` may pass `X-Feishu-Name` and `X-Feishu-Avatar-Url`; when
  present these display headers are included in the trusted HMAC signature and
  must survive into `/api/auth/me`.

## Connectors And Skills

- The old Credentials surface is now called Connectors.
- Keep route `/hermes/connectors`, with `/hermes/credentials` as a compatibility
  alias.
- Keep `/api/auth/skill-credentials`, `/:id/start`, `/:id/bind-token`, and
  `/:id/complete` wired through the protected auth router.
- `lark-cli` auth goes through the multitenancy Run Broker Feishu UAT/session
  endpoints.
- `bind-token` forwards profile-scoped token binding to Run Broker and must not
  persist raw token values in WebUI storage.
- Do not regress profile-local generated skill editing.

## Regression Tests To Keep

- Sidebar test: update/version promotion controls absent; employee-only risky
  nav items hidden; Connectors present.
- Router test: risky routes have `requiresSuperAdmin`; Feishu cookie-mode can
  enter protected routes without a JS token, and stale super-admin JWTs cannot
  bypass Feishu/trusted route gates.
- ChatPanel test: ordinary users only see Hermes in the new-session agent
  picker and cannot trigger Coding Agents status/launch flows.
- Settings test: normal users only see allowed tabs; super-admin still sees the
  full management surface.
- Auth/API test: `/api/auth/me` preserves Feishu identity fields; client access
  helpers distinguish token presence from protected-route access.
- Credentials test: Connectors renders `lark-cli`, `keep-record`, `kep-cli`,
  and does not leak raw secrets.
