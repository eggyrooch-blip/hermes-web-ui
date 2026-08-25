<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const router = useRouter()

const routeSessionId = computed(() => {
  const value = route.params.sessionId
  return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

async function loadRouteSession() {
  await chatStore.loadSessions(chatStore.sessionProfileFilter, routeSessionId.value)
  if (routeSessionId.value && chatStore.activeSessionId !== routeSessionId.value) {
    await router.replace({ name: 'hermes.globalAgent' })
  }
}

onMounted(async () => {
  chatStore.setRuntimeMode('global_agent')
  appStore.loadModels()
  await Promise.all([
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  await loadRouteSession()
})

onUnmounted(() => {
  chatStore.setRuntimeMode('default')
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (chatStore.runtimeMode !== 'global_agent' || !chatStore.sessionsLoaded) return
  if (!sessionId) {
    await chatStore.loadSessions(chatStore.sessionProfileFilter)
    return
  }
  if (chatStore.activeSessionId === sessionId) return

  const target = chatStore.sessions.find(session => session.id === sessionId)
  if (!target) {
    await loadRouteSession()
    return
  }

  // Client-only drafts must not be resumed (see ChatView's watcher).
  await chatStore.switchSession(sessionId, null, target.isLocalDraft ? { skipResume: true } : undefined)
})
</script>

<template>
  <div class="global-agent-view">
    <ChatPanel />
  </div>
</template>

<style scoped lang="scss">
.global-agent-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}
</style>
