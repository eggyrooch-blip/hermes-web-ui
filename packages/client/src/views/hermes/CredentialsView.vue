<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NButton, NModal, NSpin, useMessage } from 'naive-ui'
import { completeSkillCredentialAuth, fetchSkillCredentials, startSkillCredentialAuth } from '@/api/skillCredentials'
import type { SkillCredentialEntry, SkillCredentialsResponse } from '@/api/skillCredentials'
import { useProfilesStore } from '@/stores/hermes/profiles'

const message = useMessage()
const { t } = useI18n()
const route = useRoute()
const profilesStore = useProfilesStore()
const props = withDefaults(defineProps<{
  embedded?: boolean
  preferActiveProfile?: boolean
}>(), {
  embedded: false,
  preferActiveProfile: false,
})
const loading = ref(false)
const startingId = ref('')
const completingId = ref('')
const error = ref('')
const data = ref<SkillCredentialsResponse | null>(null)
const qrDialog = ref<{
  id: string
  title: string
  qrcodeId: string
  qrcodeUrl: string
  redirectUrl?: string
} | null>(null)
const oauthPollingId = ref('')
// The auth popup we open (window.open) — kept so we can auto-close it once the
// credential reaches an authenticated state (the kep-auth success page can't close
// itself; we opened it, so we can). Tagged with the connector id that opened it so an
// older poll can't close a newer popup belonging to a different connector.
let authWindow: Window | null = null
let authWindowOwnerId = ''

const credentials = computed(() => data.value?.credentials || [])
const routeProfile = computed(() => typeof route.query.profile === 'string' ? route.query.profile.trim() : '')
const requestedProfile = computed(() => {
  const activeProfile = profilesStore.activeProfileName || ''
  return props.preferActiveProfile ? activeProfile : routeProfile.value || activeProfile
})
let profileWatchReady = false
const internalCredentialIds = new Set(['lark-cli', 'feishu-project', 'keep-record', 'kep-cli'])
const credentialGroups = computed(() => {
  const internal = credentials.value.filter(entry => internalCredentialIds.has(entry.id))
  const other = credentials.value.filter(entry => !internalCredentialIds.has(entry.id))
  return [
    internal.length ? { id: 'internal-systems', title: t('skillCredentials.groups.internalSystems'), entries: internal } : null,
    other.length ? { id: 'other-credentials', title: t('skillCredentials.groups.otherCredentials'), entries: other } : null,
  ].filter(Boolean) as Array<{ id: string; title: string; entries: SkillCredentialEntry[] }>
})

function statusLabel(status: SkillCredentialEntry['status']) {
  if (status === 'authenticated') return '已认证'
  if (status === 'configured') return 'Token 可读'
  if (status === 'needs_auth') return '未认证'
  if (status === 'unknown') return '待验证'
  if (status === 'missing') return '未安装'
  if (status === 'error') return '检测失败'
  return '未知'
}

function statusClass(status: SkillCredentialEntry['status']) {
  return `status-${status.replace('_', '-')}`
}

async function loadCredentials(opts?: { fresh?: boolean }) {
  loading.value = true
  error.value = ''
  try {
    await ensureProfileSelection()
    await refreshCredentials(opts?.fresh)
  } catch (err: any) {
    error.value = err?.message || '连接器状态加载失败'
  } finally {
    loading.value = false
  }
}

async function ensureProfileSelection() {
  if (!requestedProfile.value && (!profilesStore.activeProfileName || profilesStore.profiles.length === 0)) {
    await profilesStore.fetchProfiles()
  }
}

async function refreshCredentials(fresh = false) {
  data.value = await fetchSkillCredentials(requestedProfile.value, fresh ? { fresh: true } : undefined)
}

function closeAuthWindow(ownerId?: string) {
  // When called with an ownerId (from a poll/focus), only close if that flow still
  // owns the popup — guards against an older poll closing a newer connector's popup.
  // Called with no ownerId (explicit cleanup before a new attempt) it always closes.
  if (ownerId && ownerId !== authWindowOwnerId) return
  if (authWindow && !authWindow.closed) {
    try { authWindow.close() } catch { /* best-effort: cross-origin window we opened */ }
  }
  authWindow = null
  authWindowOwnerId = ''
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function credentialReachedTerminalAuthState(id: string) {
  // "settled" — stop polling. Includes `unknown` (待验证): an indeterminate result
  // we won't keep retrying. NOTE: this is NOT the same as success — see below.
  const credential = credentials.value.find(item => item.id === id)
  return credential?.status === 'authenticated' || credential?.status === 'configured' || credential?.status === 'unknown'
}

function credentialAuthSucceeded(id: string) {
  // Genuine success only — used to AUTO-CLOSE the popup. `unknown`/待验证 must NOT
  // close it, or we'd hide a failed/indeterminate auth as if it were done.
  const credential = credentials.value.find(item => item.id === id)
  return credential?.status === 'authenticated' || credential?.status === 'configured'
}

async function pollCredentialAfterOAuth(id: string) {
  oauthPollingId.value = id
  try {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await sleep(2_500)
      await refreshCredentials(true)  // fresh: bypass the broker cache to see the new login
      if (credentialAuthSucceeded(id)) {
        closeAuthWindow(id)  // auto-close THIS flow's popup only, on genuine success
        return
      }
      if (credentialReachedTerminalAuthState(id)) return  // settled but not success (待验证) → stop, leave popup
    }
  } catch {
    // The manual refresh button remains available if a background poll fails.
  } finally {
    if (oauthPollingId.value === id) oauthPollingId.value = ''
  }
}

async function startCredential(entry: SkillCredentialEntry) {
  startingId.value = entry.id
  try {
    const result = await startSkillCredentialAuth(entry.id, requestedProfile.value)
    if (result.qrcode_id && result.qrcode_url) {
      qrDialog.value = {
        id: entry.id,
        title: entry.title,
        qrcodeId: result.qrcode_id,
        qrcodeUrl: result.qrcode_url,
        redirectUrl: result.redirect_url,
      }
      return
    }
    if (result.verification_uri) {
      closeAuthWindow()  // close any stale popup from a previous attempt
      authWindow = window.open('about:blank', '_blank')
      authWindowOwnerId = authWindow ? entry.id : ''
      if (authWindow) {
        authWindow.opener = null
        authWindow.location.href = result.verification_uri
      } else {
        window.location.assign(result.verification_uri)
      }
      void pollCredentialAfterOAuth(entry.id)
      message.success(result.user_code ? `${entry.title}: ${result.user_code}` : `${entry.title} 认证流程已启动`)
      return
    }
    message.success(result.user_code ? `${entry.title}: ${result.user_code}` : `${entry.title} 认证流程已启动`)
    await loadCredentials()
  } catch (err: any) {
    message.error(err?.message || `${entry.title} 认证启动失败`)
  } finally {
    startingId.value = ''
  }
}

async function completeQrCredential() {
  if (!qrDialog.value) return
  const current = qrDialog.value
  completingId.value = current.id
  try {
    const result = await completeSkillCredentialAuth(current.id, current.qrcodeId, requestedProfile.value)
    message.success(result.account_hint ? `${current.title} 已认证：${result.account_hint}` : `${current.title} 已认证`)
    qrDialog.value = null
    await loadCredentials({ fresh: true })
  } catch (err: any) {
    message.error(err?.message || '还没有检测到扫码完成，请确认后再试')
  } finally {
    completingId.value = ''
  }
}

function closeQrDialog() {
  qrDialog.value = null
}

function handleWindowFocus() {
  // The user likely just returned from the auth popup. If a poll is in flight,
  // refresh immediately (fresh) instead of waiting for the next 2.5s tick, and
  // close the popup the moment auth is confirmed.
  if (!oauthPollingId.value) return
  const id = oauthPollingId.value
  void refreshCredentials(true).then(() => {
    if (credentialAuthSucceeded(id)) closeAuthWindow(id)  // only close THIS flow's popup, on success
  }).catch(() => { /* manual refresh stays available */ })
}

onMounted(async () => {
  window.addEventListener('focus', handleWindowFocus)
  await loadCredentials()
  profileWatchReady = true
})

onUnmounted(() => {
  window.removeEventListener('focus', handleWindowFocus)
})

watch(requestedProfile, async (profile, previous) => {
  if (!profileWatchReady || profile === previous) return
  await loadCredentials()
})
</script>

<template>
  <div class="credentials-view" :class="{ 'is-embedded': props.embedded }">
    <header class="page-header">
      <h2 class="header-title">{{ t('sidebar.connectors') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="() => loadCredentials({ fresh: true })">刷新</NButton>
    </header>

    <NSpin :show="loading && !data">
      <div v-if="error" class="credentials-error">{{ error }}</div>
      <div v-else class="credentials-sections">
        <section v-for="group in credentialGroups" :key="group.id" class="credential-section" :data-credential-group="group.id">
          <h3 class="credential-section-title">{{ group.title }}</h3>
          <div class="credentials-grid credentials-grid-compact">
            <article
              v-for="entry in group.entries"
              :key="entry.id"
              class="credential-card"
              :class="statusClass(entry.status)"
            >
              <div class="credential-main">
                <div class="credential-icon" aria-hidden="true">{{ entry.title.slice(0, 1) }}</div>
                <div class="credential-copy">
                  <div class="credential-title-row">
                    <h3>{{ entry.title }}</h3>
                    <span class="credential-status">{{ statusLabel(entry.status) }}</span>
                  </div>
                  <div class="credential-meta">
                    <span>{{ entry.provider }}</span>
                    <span v-if="entry.default_identity">{{ entry.default_identity }}</span>
                    <span v-if="entry.account_hint">{{ entry.account_hint }}</span>
                  </div>
                  <p v-if="entry.detail" class="credential-detail">{{ entry.detail }}</p>
                  <div v-if="entry.required_by?.length" class="credential-required credential-required-scroll">
                    <span class="required-label">关联技能</span>
                    <span v-for="skill in entry.required_by" :key="skill" class="required-skill">{{ skill }}</span>
                  </div>
                  <code v-if="entry.action?.command" class="credential-command">{{ entry.action.command }}</code>
                </div>
              </div>
              <NButton
                size="small"
                :loading="startingId === entry.id"
                :disabled="entry.status === 'missing'"
                :data-credential-action="entry.id"
                @click="startCredential(entry)"
              >
                {{ entry.action?.label || '连接' }}
              </NButton>
            </article>
          </div>
        </section>
      </div>
    </NSpin>

    <NModal
      :show="!!qrDialog"
      preset="card"
      class="qr-modal"
      :title="qrDialog ? `${qrDialog.title} 扫码登录` : ''"
      @update:show="value => { if (!value) closeQrDialog() }"
    >
      <div v-if="qrDialog" class="qr-auth">
        <img :src="qrDialog.qrcodeUrl" alt="Keep 扫码登录二维码" class="qr-image" />
        <p class="qr-copy">请使用 Keep App 扫描二维码完成登录。</p>
        <a :href="qrDialog.qrcodeUrl" target="_blank" rel="noreferrer" class="qr-link">二维码图片链接</a>
        <a v-if="qrDialog.redirectUrl" :href="qrDialog.redirectUrl" target="_blank" rel="noreferrer" class="qr-link">登录跳转链接</a>
        <div class="qr-actions">
          <NButton @click="closeQrDialog">取消</NButton>
          <NButton type="primary" :loading="completingId === qrDialog.id" @click="completeQrCredential">已完成扫码</NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.credentials-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;

  &.is-embedded {
    height: 100%;
    min-height: 0;
  }
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.credentials-sections {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 20px;
}

.credential-section-title {
  margin: 0 0 10px;
  color: $text-primary;
  font-size: 14px;
  font-weight: 650;
}

.credentials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.credentials-grid-compact {
  align-items: start;
}

.credential-card {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  min-height: 132px;
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-secondary;
}

.credential-main {
  min-width: 0;
  display: flex;
  gap: 12px;
}

.credential-icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-weight: 700;
}

.credential-copy {
  min-width: 0;
}

.credential-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: 15px;
    font-weight: 650;
  }
}

.credential-status {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  color: $text-secondary;
  background: $bg-primary;
}

.status-authenticated .credential-status,
.status-configured .credential-status {
  color: #0f7a3a;
  background: rgba(34, 197, 94, 0.12);
}

.status-needs-auth .credential-status,
.status-unknown .credential-status,
.status-error .credential-status {
  color: #9a3412;
  background: rgba(249, 115, 22, 0.12);
}

.credential-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  color: $text-secondary;
  font-size: 12px;
}

.credential-detail {
  margin: 9px 0 0;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.45;
}

.credential-required {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}

.credential-required-scroll {
  max-height: 188px;
  overflow-y: auto;
  padding-right: 3px;
}

.required-label {
  color: $text-muted;
}

.required-skill {
  max-width: 160px;
  padding: 1px 6px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  background: $bg-primary;
}

.credential-command {
  display: inline-block;
  max-width: 100%;
  margin-top: 8px;
  padding: 5px 7px;
  border-radius: $radius-sm;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  background: $code-bg;
}

.credentials-error {
  margin: 20px;
  padding: 12px 14px;
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: $radius-md;
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.08);
}

:deep(.qr-modal) {
  max-width: 420px;
}

.qr-auth {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-image {
  width: min(260px, 72vw);
  aspect-ratio: 1;
  object-fit: contain;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: #fff;
}

.qr-copy {
  margin: 0;
  color: $text-secondary;
  font-size: 14px;
}

.qr-link {
  color: $accent-primary;
  font-size: 13px;
  text-decoration: none;
}

.qr-actions {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
</style>
