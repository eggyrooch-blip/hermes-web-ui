<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
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
