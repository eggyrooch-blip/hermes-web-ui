import { createRouter, createWebHashHistory } from 'vue-router'
import { canAccessProtectedRoutes, clearApiKey, clearRuntimeMode, hasApiKey, isServerSessionAuthMode, isStoredSuperAdmin, setRuntimeMode } from '@/api/client'

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
      path: '/hermes/history/session/:sessionId',
      name: 'hermes.historySession',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      path: '/hermes/global-agent',
      name: 'hermes.globalAgent',
      component: () => import('@/views/hermes/GlobalAgentView.vue'),
    },
    {
      path: '/hermes/global-agent/session/:sessionId',
      name: 'hermes.globalAgentSession',
      component: () => import('@/views/hermes/GlobalAgentView.vue'),
    },
    {
      path: '/hermes/jobs',
      name: 'hermes.jobs',
      component: () => import('@/views/hermes/JobsView.vue'),
    },
    {
      path: '/hermes/kanban',
      name: 'hermes.kanban',
      component: () => import('@/views/hermes/KanbanView.vue'),
    },
    {
      path: '/hermes/models',
      name: 'hermes.models',
      component: () => import('@/views/hermes/ModelsView.vue'),
      meta: { requiresSuperAdmin: true },
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
      component: () => import('@/views/hermes/LogsView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/usage',
      name: 'hermes.usage',
      component: () => import('@/views/hermes/UsageView.vue'),
    },
    {
      path: '/hermes/performance',
      name: 'hermes.performance',
      component: () => import('@/views/hermes/PerformanceView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/skills-usage',
      name: 'hermes.skillsUsage',
      component: () => import('@/views/hermes/SkillsUsageView.vue'),
    },
    {
      path: '/hermes/skills',
      name: 'hermes.skills',
      component: () => import('@/views/hermes/SkillsView.vue'),
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
      component: () => import('@/views/hermes/PluginsView.vue'),
    },
    {
      path: '/hermes/memory',
      name: 'hermes.memory',
      component: () => import('@/views/hermes/MemoryView.vue'),
    },
    {
      path: '/hermes/settings',
      name: 'hermes.settings',
      component: () => import('@/views/hermes/SettingsView.vue'),
    },
    {
      path: '/hermes/channels',
      name: 'hermes.channels',
      component: () => import('@/views/hermes/ChannelsView.vue'),
      meta: { requiresSuperAdmin: true },
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
      component: () => import('@/views/hermes/DevicesView.vue'),
      meta: { requiresSuperAdmin: true },
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
      component: () => import('@/views/hermes/CodingAgentsView.vue'),
    },
    {
      path: '/hermes/version-preview',
      name: 'hermes.versionPreview',
      component: () => import('@/views/hermes/VersionPreviewView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/mcp',
      name: 'hermes.mcp',
      component: () => import('@/views/hermes/McpManagerView.vue'),
      meta: { requiresSuperAdmin: true },
    },
  ],
})

let serverSessionVerified = false
let serverSessionCheck: Promise<boolean> | null = null

function isServerSessionAuthModeValue(value: unknown): value is 'feishu-oauth-dev' | 'trusted-feishu' {
  return value === 'feishu-oauth-dev' || value === 'trusted-feishu'
}

function clearStaleServerSession() {
  serverSessionVerified = false
  clearApiKey()
  clearRuntimeMode()
}

async function discoverServerSessionMode(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
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

router.beforeEach(async (to, _from, next) => {
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
  if (!canAccessProtectedRoutes()) {
    if (!(await discoverServerSessionMode())) {
      next({ name: 'login' })
      return
    }
  }

  if (!(await hasValidServerSession())) {
    next({ name: 'login' })
    return
  }

  if (to.meta.requiresSuperAdmin && !isStoredSuperAdmin()) {
    next({ name: 'hermes.chat' })
    return
  }

  next()
})

export default router
