<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSelect, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const options = computed(() =>
  profilesStore.profiles.map(p => ({
    label: p.displayLabel ? `${p.displayLabel} · ${p.name}` : p.name,
    value: p.name,
  })),
)

const activeName = computed(() => profilesStore.activeProfileName ?? '')
const showCreateModal = ref(false)

async function handleChange(value: string | number | Array<string | number>) {
  if (typeof value === 'string' && value !== activeName.value) {
    const ok = await profilesStore.switchProfile(value)
    if (ok) {
      message.success(t('profiles.switchSuccess', { name: value }))
      // Reload to refresh all profile-dependent data
      window.location.reload()
    } else {
      message.error(t('profiles.switchFailed'))
    }
  }
}

onMounted(() => {
  if (profilesStore.profiles.length === 0) {
    profilesStore.fetchProfiles()
  }
})

async function handleCreated() {
  showCreateModal.value = false
  await profilesStore.fetchProfiles()
}
</script>

<template>
  <div class="profile-selector">
    <div class="selector-label">{{ t('sidebar.profiles') }}</div>
    <div class="selector-row">
      <NSelect
        :value="activeName"
        :options="options"
        :loading="profilesStore.switching"
        size="small"
        @update:value="handleChange"
      />
      <NButton
        size="small"
        quaternary
        circle
        :title="t('profiles.create')"
        @click="showCreateModal = true"
      >
        +
      </NButton>
    </div>
    <ProfileCreateModal
      v-if="showCreateModal"
      @saved="handleCreated"
      @close="showCreateModal = false"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.profile-selector {
  padding: 0 12px;
  margin-bottom: 8px;
}

.selector-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.selector-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  align-items: center;
  gap: 6px;
}
</style>
