<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { isStoredSuperAdmin } from '@/api/client'

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

const productTitle = 'Hermes Studio'
const tabTitle = computed(() => {
  if (route.name !== 'hermes.session') return productTitle
  return chatStore.activeSession?.title?.trim() || productTitle
})

watch(tabTitle, (value) => {
  document.title = value
}, { immediate: true })

onUnmounted(() => {
  document.title = productTitle
})

function preferredSessionProfileFilter(): string | null {
  if (routeProfile.value) return routeProfile.value
  if (chatStore.sessionProfileFilter) return chatStore.sessionProfileFilter
  if (isStoredSuperAdmin()) return chatStore.sessionProfileFilter
  return profilesStore.activeProfileName || null
}

function applyPreferredSessionProfileFilter(): string | null {
  const profile = preferredSessionProfileFilter()
  if (profile !== chatStore.sessionProfileFilter) {
    chatStore.sessionProfileFilter = profile
  }
  return profile
}

async function loadRouteSession() {
  const profile = applyPreferredSessionProfileFilter()
  const pendingLocalSession = routeSessionId.value
    ? chatStore.sessions.find(session => session.id === routeSessionId.value && session.localCreated)
    : null
  if (pendingLocalSession) {
    await chatStore.switchSession(pendingLocalSession.id)
    return
  }
  await chatStore.loadSessions(profile, routeSessionId.value)
  if (routeSessionId.value && chatStore.activeSessionId !== routeSessionId.value) {
    await router.replace({ name: 'hermes.chat' })
  }
}

let consumingNewChatRequest = false

/**
 * `?profile=X&new=1` is how the agents hub hands over: it switches the profile
 * and routes here, and WE open the chat — after loadSessions, which replaces
 * sessions[] wholesale and would otherwise drop a session created before
 * navigation. The query is consumed so a refresh doesn't spawn another.
 */
async function consumeNewChatRequest() {
  if (route.query.new !== '1' || consumingNewChatRequest) return
  consumingNewChatRequest = true
  try {
    if (!profilesStore.profilesLoaded) {
      await profilesStore.fetchProfiles()
    }
    const profile = routeProfile.value || profilesStore.activeProfileName || undefined
    if (!profilesStore.profilesLoaded || !profile || !profilesStore.profiles.some(item => item.name === profile)) {
      await router.replace({ name: 'hermes.chat' })
      return
    }
    chatStore.newChat({ profile })
    // Keep `profile` stable while consuming only `new`: the watcher keys on
    // routeProfile, so clearing both would immediately reload the server list and
    // delete this not-yet-persisted local session.
    await router.replace({ name: 'hermes.chat', query: { profile } })
  } finally {
    consumingNewChatRequest = false
  }
}

onMounted(async () => {
  chatStore.setRuntimeMode('default')
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name；同时预取显示设置，
  // 让聊天完成提示音不依赖用户先打开 Settings 页面。
  await Promise.all([
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  await loadRouteSession()
  await consumeNewChatRequest()
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (!chatStore.sessionsLoaded) return
  const profile = applyPreferredSessionProfileFilter()
  if (!sessionId) {
    await chatStore.loadSessions(profile)
    await consumeNewChatRequest()
    return
  }
  if (chatStore.activeSessionId === sessionId && (!profile || chatStore.activeSession?.profile === profile)) return

  const exists = chatStore.sessions.some(session => (
    session.id === sessionId && (!profile || session.profile === profile)
  ))
  if (!exists) {
    await loadRouteSession()
    return
  }

  await chatStore.switchSession(sessionId)
})
</script>

<template>
  <div class="chat-view">
    <ChatPanel />
  </div>
</template>

<style scoped lang="scss">
.chat-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}
</style>
