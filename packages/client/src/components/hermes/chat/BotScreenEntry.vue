<script setup lang="ts">
/** Chat header entry to the bot's desktop; shown only when the broker reports one for the active profile. */
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NTooltip } from 'naive-ui'
import { observeDesktop } from '@/api/hermes/desktop'
import { useProfilesStore } from '@/stores/hermes/profiles'

const router = useRouter()
const profilesStore = useProfilesStore()
const enabled = ref(false)
let probe = 0

async function refresh() {
  const current = ++probe
  try {
    const result = await observeDesktop()
    if (current === probe) enabled.value = result.enabled === true
  } catch {
    // No screen entry is the right fallback: the chat page must not depend on the desktop broker.
    if (current === probe) enabled.value = false
  }
}

onMounted(() => {
  void refresh()
})
watch(() => profilesStore.activeProfileName, () => {
  void refresh()
})
</script>

<template>
  <NTooltip v-if="enabled" trigger="hover">
    <template #trigger>
      <NButton
        quaternary
        size="small"
        circle
        aria-label="屏幕"
        data-testid="bot-screen-entry"
        @click="router.push({ name: 'hermes.screen' })"
      >
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </template>
      </NButton>
    </template>
    屏幕
  </NTooltip>
</template>
