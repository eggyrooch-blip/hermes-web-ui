<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, NInput, NModal, NSelect, NTag, NSpin, useMessage, useDialog } from 'naive-ui'
import type { HermesProfile, HermesProfileDetail } from '@/api/hermes/profiles'
import { fetchAgentShares, grantAgentShare, revokeAgentShare, type AgentShare, type AgentShareGrantee, type AgentShareRole } from '@/api/hermes/agents'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'
import ProfileAvatar from './ProfileAvatar.vue'

const props = defineProps<{ profile: HermesProfile }>()
const emit = defineEmits<{}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()
const dialog = useDialog()

const expanded = ref(false)
const detailLoading = ref(false)
const exporting = ref(false)
const switching = ref(false)
const detail = ref<HermesProfileDetail | null>(null)
const shareModalVisible = ref(false)
const shareLoading = ref(false)
const shareSaving = ref(false)
const shares = ref<AgentShare[]>([])
const newGranteeQuery = ref('')
const newRole = ref<AgentShareRole>('viewer')

const isDefault = computed(() => props.profile.name === 'default')
const canManageShares = computed(() => (
  !!props.profile.agentId
  && (!props.profile.shareRole || props.profile.shareRole === 'manager')
))
const shareRoleOptions = [
  { label: 'viewer', value: 'viewer' },
  { label: 'editor', value: 'editor' },
  { label: 'manager', value: 'manager' },
]

async function toggleDetail() {
  if (expanded.value) {
    expanded.value = false
    return
  }
  expanded.value = true
  detailLoading.value = true
  try {
    detail.value = await profilesStore.fetchProfileDetail(props.profile.name)
  } finally {
    detailLoading.value = false
  }
}

async function handleSwitch() {
  dialog.warning({
    title: t('profiles.switchTo'),
    content: t('profiles.switchConfirm', { name: props.profile.name }),
    positiveText: t('profiles.switchTo'),
    negativeText: t('common.cancel'),
    onPositiveClick: performHermesSwitch,
  })
}

async function performHermesSwitch() {
  switching.value = true
  try {
    const ok = await profilesStore.switchHermesProfile(props.profile.name)
    if (ok) {
      message.success(t('profiles.switchSuccess', { name: props.profile.name }))
      // Reload to refresh all profile-dependent data
      setTimeout(() => window.location.reload(), 500)
    } else {
      message.error(t('profiles.switchFailed'))
    }
  } finally {
    switching.value = false
  }
}

function handleDelete() {
  dialog.warning({
    title: t('profiles.delete'),
    content: t('profiles.deleteConfirm', { name: props.profile.name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const ok = await profilesStore.deleteProfile(props.profile.name)
      if (ok) {
        message.success(t('profiles.deleteSuccess'))
      } else {
        message.error(t('profiles.deleteFailed'))
      }
    },
  })
}

async function handleExport() {
  exporting.value = true
  try {
    const ok = await profilesStore.exportProfile(props.profile.name)
    if (ok) {
      message.success(t('profiles.exportSuccess'))
    } else {
      message.error(t('profiles.exportFailed'))
    }
  } finally {
    exporting.value = false
  }
}

async function loadShares() {
  if (!props.profile.agentId) return
  shareLoading.value = true
  try {
    shares.value = await fetchAgentShares(props.profile.agentId)
  } catch (err: any) {
    message.error(err?.message || t('profiles.share.loadFailed'))
    shares.value = []
  } finally {
    shareLoading.value = false
  }
}

async function openShareModal() {
  if (!canManageShares.value) return
  shareModalVisible.value = true
  await loadShares()
}

async function handleGrantShare() {
  if (!props.profile.agentId) return
  const grantee = newGranteeQuery.value.trim()
  if (!grantee) return
  shareSaving.value = true
  try {
    await grantAgentShare(props.profile.agentId, granteeLookupFromInput(grantee), newRole.value)
    newGranteeQuery.value = ''
    newRole.value = 'viewer'
    await loadShares()
    message.success(t('profiles.share.grantSuccess'))
  } catch (err: any) {
    message.error(err?.message || t('profiles.share.grantFailed'))
  } finally {
    shareSaving.value = false
  }
}

async function handleRevokeShare(share: AgentShare) {
  if (!props.profile.agentId) return
  shareSaving.value = true
  try {
    const key = shareKey(share)
    await revokeAgentShare(props.profile.agentId, key)
    shares.value = shares.value.filter(item => shareKey(item) !== key)
    message.success(t('profiles.share.revokeSuccess'))
  } catch (err: any) {
    message.error(err?.message || t('profiles.share.revokeFailed'))
  } finally {
    shareSaving.value = false
  }
}

function granteeLookupFromInput(value: string): AgentShareGrantee {
  return {
    provider: 'feishu',
    type: value.includes('@') ? 'email' : 'user_id',
    value,
  }
}

function shareKey(share: AgentShare): string {
  return share.share_id || share.grantee_principal_id || share.grantee_open_id
}

function shareDisplayName(share: AgentShare): string {
  return share.principal?.display_name || share.principal?.email || share.principal?.user_id || share.grantee_open_id
}

function shareSecondaryLabel(share: AgentShare): string {
  if (!share.principal) return ''
  return share.principal.email || share.principal.user_id || ''
}

function shareAvatarUrl(share: AgentShare): string {
  return share.principal?.avatar_url || ''
}
</script>

<template>
  <div class="profile-card" :class="{ active: profile.active }">
    <div class="card-header">
      <div class="profile-title">
        <ProfileAvatar :name="profile.name" :avatar="profile.avatar" :size="28" />
        <h3 class="profile-name">{{ profile.name }}</h3>
      </div>
      <NTag v-if="profile.active" size="tiny" type="success" :bordered="false">
        {{ t('profiles.active') }}
      </NTag>
    </div>

    <div class="card-body">
      <div class="info-row">
        <span class="info-label">{{ t('profiles.model') }}</span>
        <code class="info-value mono">{{ profile.model }}</code>
      </div>
    </div>

    <div class="card-detail-toggle" @click="toggleDetail">
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="toggle-icon"
        :class="{ expanded }"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span class="toggle-text">{{ expanded ? t('common.collapse') : t('common.expand') }}</span>
    </div>

    <div v-if="expanded" class="card-detail">
      <NSpin :show="detailLoading" size="small">
        <template v-if="detail">
          <div class="info-row">
            <span class="info-label">{{ t('profiles.provider') }}</span>
            <span class="info-value">{{ detail.provider }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.path') }}</span>
            <code class="info-value mono detail-path">{{ detail.path }}</code>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.skills') }}</span>
            <span class="info-value">{{ detail.skills }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.hasEnv') }}</span>
            <span class="info-value">{{ detail.hasEnv ? 'Yes' : 'No' }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.hasSoulMd') }}</span>
            <span class="info-value">{{ detail.hasSoulMd ? 'Yes' : 'No' }}</span>
          </div>
        </template>
      </NSpin>
    </div>

    <div class="card-actions">
      <NButton
        v-if="canManageShares"
        size="tiny"
        quaternary
        type="primary"
        @click="openShareModal"
      >
        {{ t('profiles.share.manage') }}
      </NButton>
      <NButton
        v-if="!profile.active"
        size="tiny"
        :loading="switching"
        quaternary
        type="primary"
        @click="handleSwitch"
      >
        {{ t('profiles.switchTo') }}
      </NButton>
      <NButton
        size="tiny"
        quaternary
        type="error"
        :disabled="isDefault || profile.active"
        @click="handleDelete"
      >
        {{ t('common.delete') }}
      </NButton>
      <NButton size="tiny" quaternary :loading="exporting" @click="handleExport">
        {{ t('profiles.export') }}
      </NButton>
    </div>

    <NModal
      v-model:show="shareModalVisible"
      preset="card"
      :bordered="false"
      :style="{ width: '520px', maxWidth: 'calc(100vw - 32px)' }"
    >
      <template #header>
        <div class="share-modal-title">{{ t('profiles.share.title') }}</div>
      </template>
      <NSpin :show="shareLoading" size="small">
        <div class="share-list">
          <div v-if="shares.length === 0" class="share-empty">{{ t('profiles.share.empty') }}</div>
          <div v-for="share in shares" :key="shareKey(share)" class="share-row">
            <img
              v-if="shareAvatarUrl(share)"
              class="share-principal-avatar"
              :src="shareAvatarUrl(share)"
              alt=""
            >
            <div class="share-grantee">
              <span class="share-grantee-name">{{ shareDisplayName(share) }}</span>
              <span v-if="shareSecondaryLabel(share)" class="share-grantee-secondary">
                {{ shareSecondaryLabel(share) }}
              </span>
            </div>
            <NTag size="tiny" :bordered="false">{{ share.role }}</NTag>
            <NButton size="tiny" quaternary :loading="shareSaving" @click="handleRevokeShare(share)">
              {{ t('profiles.share.revoke') }}
            </NButton>
          </div>
        </div>
        <div class="share-form">
          <NInput
            v-model:value="newGranteeQuery"
            size="small"
            :placeholder="t('profiles.share.grantee')"
          />
          <NSelect
            v-model:value="newRole"
            size="small"
            :options="shareRoleOptions"
          />
          <NButton size="small" type="primary" :loading="shareSaving" @click="handleGrantShare">
            {{ t('profiles.share.grant') }}
          </NButton>
        </div>
      </NSpin>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.profile-card {
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  transition: border-color $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }

  &.active {
    border-color: rgba(var(--success-rgb), 0.4);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.profile-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.profile-name {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  margin: 0;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.card-detail-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  cursor: pointer;
  color: $text-muted;
  font-size: 12px;
  user-select: none;

  &:hover {
    color: $text-secondary;
  }
}

.toggle-icon {
  transition: transform 0.2s;

  &.expanded {
    transform: rotate(180deg);
  }
}

.card-detail {
  padding: 8px 0;
  border-top: 1px solid $border-light;
  margin-bottom: 8px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
}

.info-label {
  font-size: 12px;
  color: $text-muted;
  flex-shrink: 0;
  margin-right: 12px;
}

.info-value {
  font-size: 12px;
  color: $text-secondary;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: $font-code;
  font-size: 12px;
}

.detail-path {
  max-width: 260px;
}

.card-actions {
  display: flex;
  gap: 8px;
  border-top: 1px solid $border-light;
  padding-top: 10px;
  flex-wrap: wrap;
}

.share-modal-title {
  font-size: 14px;
  font-weight: 700;
  color: $text-primary;
}

.share-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 48px;
}

.share-empty {
  color: $text-muted;
  font-size: 13px;
}

.share-row,
.share-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.share-row {
  justify-content: space-between;
  padding: 8px;
  border: 1px solid $border-light;
  border-radius: 8px;
}

.share-principal-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex: 0 0 28px;
}

.share-grantee {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.share-grantee-name,
.share-grantee-secondary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-grantee-name {
  color: $text-primary;
  font-size: 12px;
}

.share-grantee-secondary {
  color: $text-muted;
  font-size: 11px;
}

.share-form {
  margin-top: 12px;

  :deep(.n-select) {
    width: 116px;
    flex: 0 0 116px;
  }
}
</style>
