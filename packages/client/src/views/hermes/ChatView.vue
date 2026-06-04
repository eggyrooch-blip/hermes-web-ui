<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
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

const routeSessionId = computed(() => {
  const value = route.params.sessionId
  return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

// Upstream #1296: reflect the active session title in the browser tab.
// Kept intentionally minimal — sunke's profile-aware session loading below is
// preserved as-is; upstream's loadRouteSession() loading path is intentionally
// NOT adopted (it does not respect the multitenancy profile filter).
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

onMounted(async () => {
  appStore.loadModels()
  // Chat session isolation is enforced server-side from the Feishu session and
  // owner/profile ACL. Do not block visible chat history on the slower profile
  // list; production profile discovery can involve multitenancy metadata.
  void chatStore.loadSessions(routeProfile.value, routeSessionId.value)
  void profilesStore.fetchProfiles()
  void settingsStore.fetchSettings()
})

watch([routeSessionId, routeProfile], ([sessionId, profile]) => {
  void chatStore.loadSessions(profile, sessionId)
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
