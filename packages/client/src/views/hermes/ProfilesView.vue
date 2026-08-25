<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ProfilesPanel from '@/components/hermes/profiles/ProfilesPanel.vue'
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'
import ProfileRenameModal from '@/components/hermes/profiles/ProfileRenameModal.vue'
import ProfileImportModal from '@/components/hermes/profiles/ProfileImportModal.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
/** What a clone left behind — stripped credentials, disabled platforms. */
const cloneGaps = ref('')
const profilesStore = useProfilesStore()

const showCreateModal = ref(false)
const showImportModal = ref(false)
const renamingProfile = ref<string | null>(null)

onMounted(() => {
  profilesStore.fetchHermesProfiles()
})

function handleCreated() {
  showCreateModal.value = false
}

function handleRenamed() {
  renamingProfile.value = null
}

function handleImported() {
  showImportModal.value = false
}
</script>

<template>
  <div class="profiles-view">
    <!-- What the clone did NOT bring over. Informational, not a failure, and
         dismissible — the user needs it to know what to re-add. -->
    <p v-if="cloneGaps" class="clone-gaps" data-testid="clone-gaps">
      <span class="clone-gaps__text">{{ cloneGaps }}</span>
      <button type="button" class="clone-gaps__close" :title="t('common.close')" @click="cloneGaps = ''">&times;</button>
    </p>
    <header class="page-header">
      <h2 class="header-title">{{ t('profiles.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" @click="showImportModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </template>
          {{ t('profiles.import') }}
        </NButton>
        <NButton type="primary" size="small" @click="showCreateModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </template>
          {{ t('profiles.create') }}
        </NButton>
      </div>
    </header>

    <div class="profiles-content">
      <NSpin :show="profilesStore.loading && profilesStore.profiles.length === 0">
        <ProfilesPanel @rename="renamingProfile = $event" />
      </NSpin>
    </div>

    <ProfileCreateModal
      v-if="showCreateModal"
      @close="showCreateModal = false"
      @clone-gaps="(summary: string) => (cloneGaps = summary)"
      @saved="handleCreated"
    />
    <ProfileRenameModal
      v-if="renamingProfile"
      :profile-name="renamingProfile"
      @close="renamingProfile = null"
      @saved="handleRenamed"
    />
    <ProfileImportModal
      v-if="showImportModal"
      @close="showImportModal = false"
      @saved="handleImported"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.clone-gaps {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  white-space: pre-line;
}

.clone-gaps__text {
  flex: 1;
  min-width: 0;
}

.clone-gaps__close {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}


.profiles-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.profiles-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
