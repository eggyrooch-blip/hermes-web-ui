import { createRouter, createWebHashHistory } from 'vue-router'
import { ref } from 'vue'
import { canAccessProtectedRoutes, clearApiKey, clearRuntimeMode, hasApiKey, isServerSessionAuthMode, isStoredSuperAdmin, setRuntimeMode } from '@/api/client'

export const authNavigationReady = ref(false)
export const routeContentReady = ref(false)

// Pages that used to be their own entry in the management sidebar are now tabs
// inside 设置, which renders in the chat shell — one sidebar everywhere. Their
// old paths stay linkable and land on the matching tab.
const settingsTab = (tab: string) => ({
  name: 'hermes.chat' as const,
  query: { surface: 'settings', tab },
})

// Admin-only pages keep their `meta` (that is the declared contract, and the
// tests read it), but the check ALSO happens here: a redirect record is not
// part of the resolved `to.matched`, so `beforeEach` never sees its meta and
// would wave a non-admin straight through to the tab.
const adminSettingsTab = (tab: string, nonAdminRedirect = 'hermes.chat') => () =>
  isStoredSuperAdmin() ? settingsTab(tab) : { name: nonAdminRedirect }

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/hermes/chat',
      name: 'hermes.chat',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/hermes/session/:sessionId',
      name: 'hermes.session',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/hermes/history',
      name: 'hermes.history',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      path: '/hermes/design',
      name: 'hermes.design',
      component: () => import('@/views/hermes/DesignModeView.vue'),
    },
    {
      path: '/hermes/history/session/:sessionId',
      name: 'hermes.historySession',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      // Console — any logged-in Feishu user (developer plane is default-all).
      // The ops plane inside is gated server-side by requireConsoleAdmin, so no
      // requiresSuperAdmin meta here (that flag is dead for Feishu users anyway).
      path: '/hermes/console',
      name: 'hermes.console',
      component: () => import('@/views/hermes/ConsoleView.vue'),
    },
    {
      path: '/hermes/global-agent',
      name: 'hermes.globalAgent',
      component: () => import('@/views/hermes/GlobalAgentView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/global-agent/session/:sessionId',
      name: 'hermes.globalAgentSession',
      component: () => import('@/views/hermes/GlobalAgentView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/jobs',
      name: 'hermes.jobs',
      component: () => import('@/views/hermes/JobsView.vue'),
    },
    {
      path: '/hermes/apps',
      name: 'hermes.apps',
      component: () => import('@/views/hermes/AppsView.vue'),
    },
    {
      path: '/hermes/kanban',
      name: 'hermes.kanban',
      redirect: settingsTab('kanban'),
    },
    {
      // `providers`, not `models`: 设置 already had a `models` tab (ModelSettings),
      // which is a different page from ModelsView (provider accounts).
      path: '/hermes/models',
      name: 'hermes.models',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('providers'),
    },
    {
      // Deliberately NOT requiresSuperAdmin: this is the everyday agent hub and
      // sunke's prod role is `user`. /hermes/profiles stays super-admin-only for
      // profile ops (rename/import/export/delete).
      path: '/hermes/agents',
      name: 'hermes.agents',
      component: () => import('@/views/hermes/AgentsView.vue'),
    },
    {
      path: '/hermes/agents/:name',
      name: 'hermes.agentDetail',
      component: () => import('@/views/hermes/AgentDetailView.vue'),
    },
    {
      path: '/hermes/profiles',
      name: 'hermes.profiles',
      component: () => import('@/views/hermes/ProfilesView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/logs',
      name: 'hermes.logs',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('logs'),
    },
    {
      path: '/hermes/usage',
      name: 'hermes.usage',
      redirect: settingsTab('usage'),
    },
    {
      path: '/hermes/performance',
      name: 'hermes.performance',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('performance'),
    },
    {
      path: '/hermes/skills-usage',
      name: 'hermes.skillsUsage',
      redirect: settingsTab('skillsUsage'),
    },
    {
      path: '/hermes/skills',
      name: 'hermes.skills',
      component: () => import('@/views/hermes/SkillsView.vue'),
    },
    {
      path: '/hermes/expert',
      name: 'hermes.expert',
      component: () => import('@/views/hermes/ExpertCatalogView.vue'),
    },
    {
      path: '/hermes/connectors',
      alias: '/hermes/credentials',
      name: 'hermes.connectors',
      component: () => import('@/views/hermes/CredentialsView.vue'),
    },
    {
      path: '/hermes/plugins',
      name: 'hermes.plugins',
      meta: { requiresSuperAdmin: true, nonAdminRedirect: 'hermes.connectors' },
      redirect: adminSettingsTab('plugins', 'hermes.connectors'),
    },
    {
      path: '/hermes/memory',
      name: 'hermes.memory',
      redirect: settingsTab('memory'),
    },
    {
      // 设置 renders inside the chat shell (surface=settings) so it keeps the
      // one sidebar. The name stays valid — `router.push({name:'hermes.settings'})`
      // still works everywhere it is already called — and `?tab=` is carried over.
      path: '/hermes/settings',
      name: 'hermes.settings',
      redirect: (to) => ({
        name: 'hermes.chat' as const,
        query: {
          surface: 'settings',
          ...(typeof to.query.tab === 'string' ? { tab: to.query.tab } : {}),
        },
      }),
    },
    {
      path: '/hermes/channels',
      name: 'hermes.channels',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('channels'),
    },
    {
      path: '/hermes/terminal',
      name: 'hermes.terminal',
      component: () => import('@/views/hermes/TerminalView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/devices',
      name: 'hermes.devices',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('devices'),
    },
    {
      path: '/hermes/group-chat',
      name: 'hermes.groupChat',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/hermes/group-chat/room/:roomId',
      name: 'hermes.groupChatRoom',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/hermes/files',
      name: 'hermes.files',
      component: () => import('@/views/hermes/FilesView.vue'),
    },
    {
      path: '/hermes/coding-agents',
      name: 'hermes.codingAgents',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('codingAgents'),
    },
    {
      path: '/hermes/version-preview',
      name: 'hermes.versionPreview',
      meta: { requiresSuperAdmin: true },
      redirect: adminSettingsTab('versionPreview'),
    },
    {
      path: '/hermes/mcp',
      name: 'hermes.mcp',
      meta: { requiresSuperAdmin: true, nonAdminRedirect: 'hermes.connectors' },
      redirect: adminSettingsTab('mcp', 'hermes.connectors'),
    },
  ],
})

let serverSessionVerified = false
let serverSessionCheck: Promise<boolean> | null = null

function isServerSessionAuthModeValue(value: unknown): value is 'feishu-oauth-dev' | 'trusted-feishu' {
  return value === 'feishu-oauth-dev' || value === 'trusted-feishu'
}

function clearStaleServerSession() {
  authNavigationReady.value = false
  routeContentReady.value = false
  serverSessionVerified = false
  clearApiKey()
  clearRuntimeMode()
}

// Auth probes must not hang navigation forever: if the backend stalls (e.g.
// mid-restart), abort and fall through to the login page instead of leaving
// the router — and the whole screen — suspended.
const AUTH_PROBE_TIMEOUT_MS = 5000

function authProbeSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS)
    : undefined
}

async function discoverServerSessionMode(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: authProbeSignal(),
    })
    if (!res.ok) return false
    const status = await res.json().catch(() => ({})) as { authMode?: unknown; plane?: unknown }
    if (!isServerSessionAuthModeValue(status.authMode)) return false
    setRuntimeMode(status.authMode, typeof status.plane === 'string' ? status.plane : undefined)
    return true
  } catch {
    return false
  }
}

async function hasValidServerSession(): Promise<boolean> {
  if (!isServerSessionAuthMode()) return true
  if (serverSessionVerified) return true
  if (!serverSessionCheck) {
    serverSessionCheck = fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: authProbeSignal(),
    })
      .then((res) => {
        if (res.ok) {
          serverSessionVerified = true
          return true
        }
        clearStaleServerSession()
        return false
      })
      .catch(() => {
        clearStaleServerSession()
        return false
      })
      .finally(() => {
        serverSessionCheck = null
      })
  }
  return serverSessionCheck
}

export function freshServerSettingsLandingRedirect(discoveredServerSession: boolean, routeName: unknown) {
  if (discoveredServerSession && isServerSessionAuthMode() && routeName === 'hermes.settings') {
    return { name: 'hermes.chat' as const, replace: true }
  }
  return null
}

function nonAdminRedirectTarget(to: { meta: Record<string | number | symbol, unknown> }) {
  const redirect = to.meta.nonAdminRedirect
  if (typeof redirect === 'string' && redirect.trim()) {
    return { name: redirect.trim() }
  }
  return { name: 'hermes.chat' }
}

router.beforeEach(async (to, _from, next) => {
  try {
    // Public pages don't need auth
    if (to.meta.public) {
      // Already has key, skip login
      if (to.name === 'login' && hasApiKey()) {
        next({ path: '/hermes/chat' })
        return
      }
      next()
      return
    }

    // All other pages require auth. Feishu OAuth uses an httpOnly cookie instead
    // of a JS-readable token, so do not gate protected routes on localStorage.
    let discoveredServerSession = false
    if (!canAccessProtectedRoutes()) {
      discoveredServerSession = await discoverServerSessionMode()
      if (!discoveredServerSession) {
        next({ name: 'login' })
        return
      }
    }

    if (!(await hasValidServerSession())) {
      next({ name: 'login' })
      return
    }

    authNavigationReady.value = true
    if (to.meta.requiresSuperAdmin && !isStoredSuperAdmin()) {
      routeContentReady.value = false
      next(nonAdminRedirectTarget(to))
      return
    }

    const settingsRedirect = freshServerSettingsLandingRedirect(discoveredServerSession, to.name)
    if (settingsRedirect) {
      routeContentReady.value = false
      next(settingsRedirect)
      return
    }

    routeContentReady.value = true
    next()
  } catch {
    // An unexpected failure inside the auth checks must never strand the app
    // on a half-finished navigation (previous page's chrome + blank main).
    // Land on the login page, which re-runs the bootstrap cleanly.
    routeContentReady.value = false
    if (to.name === 'login') {
      next()
    } else {
      next({ name: 'login' })
    }
  }
})

router.afterEach((to) => {
  if (to.meta.public) {
    authNavigationReady.value = true
    routeContentReady.value = true
  }
})

export default router
