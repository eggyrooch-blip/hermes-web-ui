import { createRouter, createWebHashHistory } from 'vue-router'
import { fetchFeishuUatStatus } from '@/api/auth'
import { canAccessProtectedRoutes, getAuthMode, isUserMode, shouldSkipLoginPage } from '@/api/client'

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
      path: '/hermes/history',
      name: 'hermes.history',
      component: () => import('@/views/hermes/HistoryView.vue'),
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
      meta: { hiddenInChatPlane: true },
    },
    {
      path: '/hermes/profiles',
      name: 'hermes.profiles',
      component: () => import('@/views/hermes/ProfilesView.vue'),
      meta: { hiddenInChatPlane: true },
    },
    {
      path: '/hermes/logs',
      name: 'hermes.logs',
      component: () => import('@/views/hermes/LogsView.vue'),
      meta: { hiddenInChatPlane: true },
    },
    {
      path: '/hermes/usage',
      name: 'hermes.usage',
      component: () => import('@/views/hermes/UsageView.vue'),
    },
    {
      path: '/hermes/skills',
      name: 'hermes.skills',
      component: () => import('@/views/hermes/SkillsView.vue'),
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
      path: '/hermes/gateways',
      name: 'hermes.gateways',
      component: () => import('@/views/hermes/GatewaysView.vue'),
      meta: { hiddenInChatPlane: true },
    },
    {
      path: '/hermes/channels',
      name: 'hermes.channels',
      component: () => import('@/views/hermes/ChannelsView.vue'),
      meta: { hiddenInChatPlane: true },
    },
    {
      path: '/hermes/terminal',
      name: 'hermes.terminal',
      component: () => import('@/views/hermes/TerminalView.vue'),
      meta: { hiddenInChatPlane: true },
    },
    {
      path: '/hermes/group-chat',
      name: 'hermes.groupChat',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/hermes/files',
      name: 'hermes.files',
      component: () => import('@/views/hermes/FilesView.vue'),
    },
  ],
})

router.beforeEach(async (to, _from, next) => {
  // Public pages don't need auth
  if (to.meta.public) {
    // Already has key, skip login
    if (to.name === 'login' && shouldSkipLoginPage()) {
      next({ path: '/hermes/chat' })
      return
    }
    next()
    return
  }

  // All other pages require token
  if (!canAccessProtectedRoutes()) {
    next({ name: 'login' })
    return
  }

  if (isUserMode() && to.meta.hiddenInChatPlane) {
    next({ name: 'hermes.chat' })
    return
  }

  if (getAuthMode() === 'feishu-oauth-dev') {
    try {
      const status = await fetchFeishuUatStatus()
      if (status.status !== 'valid') {
        next({ name: 'login', query: { uat: 'required', redirect: to.fullPath } })
        return
      }
    } catch {
      next({ name: 'login', query: { uat: 'required', redirect: to.fullPath } })
      return
    }
  }

  next()
})

export default router
