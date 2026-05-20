<script setup lang="ts">
import { onMounted } from 'vue'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()

onMounted(async () => {
  appStore.loadModels()
  // Chat session isolation is enforced server-side from the Feishu session and
  // owner/profile ACL. Do not block visible chat history on the slower profile
  // list; production profile discovery can involve multitenancy metadata.
  void chatStore.loadSessions()
  void profilesStore.fetchProfiles()
  void settingsStore.fetchSettings()
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
