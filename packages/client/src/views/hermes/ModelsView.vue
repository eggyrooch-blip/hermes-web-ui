<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AuxiliaryModelsPanel from '@/components/hermes/models/AuxiliaryModelsPanel.vue'
import ProvidersPanel from '@/components/hermes/models/ProvidersPanel.vue'
import ProviderFormModal from '@/components/hermes/models/ProviderFormModal.vue'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchProfiles, type HermesProfile } from '@/api/hermes/profiles'
import { checkCopilotToken } from '@/api/hermes/copilot-auth'

const { t } = useI18n()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()
const message = useMessage()
const route = useRoute()
const router = useRouter()
const showModal = ref(false)

// 这个页面看哪个 Profile 只写进 URL（?modelProfile=），不动全局 active profile ——
// 在模型设置页翻别人的 Profile 不该把聊天平面也切走。
const profiles = ref<HermesProfile[]>([])
const selectedProfile = ref(
  typeof route.query.modelProfile === 'string'
    ? route.query.modelProfile
    : profilesStore.activeProfileName || 'default',
)
const profileOptions = computed(() => profiles.value.map(profile => ({ label: profile.name, value: profile.name })))
const profileLoading = ref(true)
// URL 上的 modelProfile 已经规范化成一个真实存在的 Profile，并且与 selectedProfile 一致。
// 只有这时 api/client 的 getModelsPageProfile() 才会返回同一个值，写请求才打得对地方。
const profileSynced = ref(false)
let profilesReady = false
let loadId = 0

// 侧栏的 Models 入口只带 route name，点一下 query 就被清空；`?modelProfile=a&modelProfile=b`
// 之类也会变成数组。两种情况 getModelsPageProfile() 都返回 null，请求会悄悄落回 active
// profile，所以这里一律当「没选」处理，由 watcher 把合法值写回 URL。
function normalizeProfileQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name && profiles.value.some(item => item.name === name) ? name : null
}

// 页面已经跟 URL 对齐、且 store 里的数据确实属于当前 Profile 时才渲染面板。
// 任何一条不成立都意味着「看到的」和「写进去的」可能不是同一个 Profile。
const contentReady = computed(() =>
  !profileLoading.value
  && !!selectedProfile.value
  && profileSynced.value
  && modelsStore.loadedProfile === selectedProfile.value,
)

function handleProfileUpdate(profile: string) {
  if (profileLoading.value || !profiles.value.some(item => item.name === profile)) return
  void router.replace({ query: { ...route.query, modelProfile: profile } })
}

watch(() => route.query.modelProfile, raw => {
  if (!profilesReady) return
  const profile = normalizeProfileQuery(raw)
  if (!profile) {
    // query 没了或者不合法：先停掉写操作，再把当前选中的 Profile 写回 URL。
    profileSynced.value = false
    const fallback = profiles.value.some(item => item.name === selectedProfile.value)
      ? selectedProfile.value
      : profiles.value[0]?.name || ''
    if (!fallback) return
    void router.replace({ query: { ...route.query, modelProfile: fallback } })
    return
  }
  if (profile === selectedProfile.value) {
    profileSynced.value = true
    return
  }
  selectedProfile.value = profile
  profileSynced.value = true
  showModal.value = false
  void loadProvidersForProfile()
})

async function loadProvidersForProfile() {
  // loadId 让上一轮在途的加载失效：切 Profile 切得快时，先发的请求可能后回来。
  const currentLoad = ++loadId
  profileLoading.value = true
  try {
    // 先 invalidate 后端 copilot 缓存（gh logout / VS Code 退出后下一次 list 立刻反映），
    // 再拉 providers 与 appStore 的模型显示名配置。check-token 失败不阻断。
    try { await checkCopilotToken() } catch { /* ignore */ }
    if (currentLoad !== loadId) return
    await modelsStore.fetchProviders()
  } catch (err: any) {
    // store 已经把这个 Profile 的数据清空了，这里只负责把失败说出来。
    if (currentLoad === loadId) message.error(err?.message || t('models.profileLoadFailed'))
  } finally {
    if (currentLoad === loadId) profileLoading.value = false
  }
}

onMounted(async () => {
  try {
    profiles.value = await fetchProfiles()
    selectedProfile.value = profiles.value.find(profile => profile.name === selectedProfile.value)?.name
      || profiles.value[0]?.name
      || ''
    if (!selectedProfile.value) return
    await router.replace({ query: { ...route.query, modelProfile: selectedProfile.value } })
    profilesReady = true
    profileSynced.value = normalizeProfileQuery(route.query.modelProfile) === selectedProfile.value
    await loadProvidersForProfile()
  } catch (err: any) {
    message.error(err?.message || t('models.profileLoadFailed'))
  } finally {
    profileLoading.value = false
  }
})

onUnmounted(() => { loadId++ })

function openCreateModal() {
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
}

async function handleSaved() {
  await modelsStore.fetchProviders()
  handleModalClose()
}

async function handleRefreshModelCache() {
  try {
    await modelsStore.refreshModelCache()
    message.success(t('models.refreshModelCacheSuccess'))
  } catch (e: any) {
    message.error(e?.message || t('models.refreshModelCacheFailed'))
  }
}
</script>

<template>
  <div class="models-view">
    <div v-if="modelsStore.refreshingModelCache" class="model-cache-overlay">
      <NSpin size="large" :description="t('models.refreshModelCacheLoading')" />
    </div>

    <header class="page-header">
      <h2 class="header-title">{{ t('models.title') }}</h2>
      <div class="header-actions">
        <NSelect
          class="models-profile-select"
          data-testid="models-profile-select"
          :value="selectedProfile"
          :options="profileOptions"
          :disabled="profileLoading || modelsStore.refreshingModelCache"
          :loading="profileLoading"
          :aria-label="t('models.profileFilter')"
          size="small"
          filterable
          @update:value="handleProfileUpdate"
        />
        <NButton
          size="small"
          :loading="modelsStore.refreshingModelCache"
          :disabled="modelsStore.loading || profileLoading || !contentReady"
          @click="handleRefreshModelCache"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7"/><path d="M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7"/><path d="M21 3v6h-6"/><path d="M3 21v-6h6"/></svg>
          </template>
          {{ t('models.refreshModelCache') }}
        </NButton>
        <NButton type="primary" size="small" :disabled="!contentReady" @click="openCreateModal">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ t('models.addProvider') }}
        </NButton>
      </div>
    </header>

    <div class="models-content">
      <NSpin v-if="profileLoading" class="models-profile-loading" />
      <p v-else-if="modelsStore.loadError" class="models-profile-error">{{ modelsStore.loadError }}</p>
      <template v-else-if="contentReady">
        <AuxiliaryModelsPanel :key="`aux-${selectedProfile}`" />
        <NSpin :show="modelsStore.loading && modelsStore.providers.length === 0">
          <ProvidersPanel :key="`providers-${selectedProfile}`" />
        </NSpin>
      </template>
    </div>

    <ProviderFormModal
      v-if="showModal && contentReady"
      @close="handleModalClose"
      @saved="handleSaved"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.models-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.model-cache-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, $bg-primary 78%, transparent);
  backdrop-filter: blur(2px);
}

.models-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.models-profile-select {
  width: 160px;
}

.models-profile-error {
  padding: 24px 0;
  text-align: center;
  color: $text-muted;
}

.models-profile-loading {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .models-profile-select {
    width: 120px;
  }
}
</style>
