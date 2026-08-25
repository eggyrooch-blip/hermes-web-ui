<script setup lang="ts">
import { onUnmounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { darkTheme, NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getThemeOverrides } from '@/styles/theme'
import { useTheme } from '@/composables/useTheme'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import DesktopTitleBar from '@/components/layout/DesktopTitleBar.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { useAppStore } from '@/stores/hermes/app'
import SessionSearchModal from '@/components/hermes/chat/SessionSearchModal.vue'
import AuthEventListener from '@/components/auth/AuthEventListener.vue'
import DefaultCredentialPrompt from '@/components/auth/DefaultCredentialPrompt.vue'
import { authNavigationReady, routeContentReady } from '@/router'

const { isDark, isComic } = useTheme()
const { t } = useI18n()
const appStore = useAppStore()
const route = useRoute()

const themeOverrides = computed(() => getThemeOverrides(isDark.value, isComic.value))
const naiveTheme = computed(() => isDark.value ? darkTheme : null)

const isLoginPage = computed(() => route.name === 'login')
const usesPageSidebar = computed(() =>
  authNavigationReady.value && ['hermes.chat', 'hermes.session', 'hermes.history', 'hermes.historySession', 'hermes.globalAgent', 'hermes.globalAgentSession', 'hermes.groupChat', 'hermes.groupChatRoom'].includes(route.name as string),
)
// Also gated on routeContentReady: when a guard aborts mid-navigation (e.g.
// the session died while redirecting), the route object still points at the
// PREVIOUS page — rendering its sidebar next to a blank <main> reads as a
// broken half-page. Until content is ready, show the pending state instead.
const showAppSidebar = computed(() =>
  authNavigationReady.value && routeContentReady.value && !isLoginPage.value && !usesPageSidebar.value,
)
const showMobileMenuButton = computed(() => authNavigationReady.value && !isLoginPage.value && (showAppSidebar.value || usesPageSidebar.value))

const nodeVersionLow = computed(() => {
  const v = appStore.nodeVersion
  const major = parseInt(v.split('.')[0], 10)
  return !isNaN(major) && major < 23
})

const isDesktopShell = computed(() =>
  (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } }).hermesDesktop?.isDesktop === true,
)
const hasDesktopTitleBar = computed(() => {
  const platform = (window as typeof window & { hermesDesktop?: { platform?: string } }).hermesDesktop?.platform
  return isDesktopShell.value && (platform === 'darwin' || platform === 'win32')
})

function handleMobileMenuClick() {
  if (usesPageSidebar.value) {
    window.dispatchEvent(new CustomEvent('hermes:open-page-sidebar'))
    return
  }
  appStore.toggleSidebar()
}

watch([authNavigationReady, isLoginPage], ([ready, loginPage]) => {
  if (!ready || loginPage) {
    appStore.stopHealthPolling()
    return
  }
  appStore.loadModels()
  appStore.startHealthPolling()
}, {
  immediate: true,
})

onUnmounted(() => {
  appStore.stopHealthPolling()
})

useKeyboard()
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <AuthEventListener />
      <NDialogProvider>
        <NNotificationProvider>
          <div class="app-shell" :class="{ desktop: isDesktopShell, 'desktop-titlebar-host': hasDesktopTitleBar }">
            <DesktopTitleBar v-if="isDesktopShell" />
            <div v-if="nodeVersionLow" class="node-warning-bar">
              {{ t('sidebar.nodeVersionWarning', { version: appStore.nodeVersion }) }}
            </div>
            <div class="app-layout" :class="{ 'no-sidebar': !authNavigationReady || isLoginPage || !showAppSidebar }">
              <button v-if="showMobileMenuButton" class="hamburger-btn" @click="handleMobileMenuClick">
                <img src="/logo.png" alt="Menu" style="width: 24px; height: 24px;" />
              </button>
              <div v-if="authNavigationReady && !isLoginPage && showAppSidebar && appStore.sidebarOpen" class="mobile-backdrop" @click="appStore.closeSidebar" />
              <AppSidebar v-if="authNavigationReady && !isLoginPage && showAppSidebar" />
              <main class="app-main">
                <router-view v-if="routeContentReady" />
                <!-- A guard mid-redirect (or an aborted navigation) leaves no
                     route content; show a quiet pending state instead of a
                     blank pane so the app never looks half-rendered. -->
                <div v-else-if="!isLoginPage" class="route-pending" aria-busy="true">
                  <span class="route-pending__spinner" aria-hidden="true" />
                </div>
              </main>
            </div>
          </div>
          <SessionSearchModal />
          <DefaultCredentialPrompt />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-shell {
  height: calc(100 * var(--vh));
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background-color: $bg-primary;
}

.app-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  overflow: hidden;

  &.no-sidebar {
    display: block;
  }
}

.app-shell.desktop-titlebar-host .app-layout {
  --vh: calc(1vh - 0.36px);
}

// Pending state while a navigation is unresolved: centered hairline spinner.
.route-pending {
  height: 100%;
  display: grid;
  place-items: center;
}

.route-pending__spinner {
  width: 22px;
  height: 22px;
  border-radius: 9999px;
  border: 2px solid var(--divider);
  border-top-color: var(--gray-33);
  animation: route-pending-spin 0.8s linear infinite;
}

@keyframes route-pending-spin {
  to {
    transform: rotate(360deg);
  }
}

.app-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background-color: $bg-primary;

  .no-sidebar & {
    height: 100%;
  }
}

.node-warning-bar {
  flex: 0 0 auto;
  width: 100%;
  z-index: 100;
  padding: 4px 16px;
  font-size: 12px;
  font-weight: 500;
  color: #b45309;
  background-color: #fef3c7;
  border-bottom: 1px solid #fde68a;
  text-align: center;
  line-height: 1.4;
}
</style>
