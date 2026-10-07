import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as systemApi from '@/api/hermes/system'
import type { AvailableModelGroup, CustomProvider } from '@/api/hermes/system'
import { canAccessProtectedRoutes, getModelsPageProfile } from '@/api/client'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'

export const useModelsStore = defineStore('models', () => {
  const providers = ref<AvailableModelGroup[]>([])
  const allProviders = ref<AvailableModelGroup[]>([])
  const defaultModel = ref('')
  const defaultProvider = ref('')
  const loading = ref(false)
  const refreshingModelCache = ref(false)
  // providers/allProviders 里这份数据属于哪个 Profile。null = 当前没有可信数据。
  // 没有这个标记，一次失败的切换会把上一个 Profile 的卡片留在页面上，而删除、改可见
  // 模型等写请求已经带上新 Profile 的 header —— 看到的和删掉的不是同一个 Profile。
  const loadedProfile = ref<string | null>(null)
  const loadError = ref<string | null>(null)

  function requestProfile(): string {
    // Models 设置页在 URL 里选的 Profile 优先；其它页面仍看 active profile。
    return getModelsPageProfile() || useProfilesStore().activeProfileName || 'default'
  }

  function resetProviderData() {
    providers.value = []
    allProviders.value = []
    defaultModel.value = ''
    defaultProvider.value = ''
    loadedProfile.value = null
  }

  const customProviders = computed(() =>
    providers.value.filter(g => g.provider.startsWith('custom:')),
  )

  const builtinProviders = computed(() =>
    providers.value.filter(g => !g.provider.startsWith('custom:')),
  )

  const allModels = computed(() =>
    providers.value.flatMap(g =>
      g.models.map(m => ({
        id: m,
        provider: g.provider,
        label: g.label,
        base_url: g.base_url,
        isDefault: m === defaultModel.value && g.provider === defaultProvider.value,
      })),
    ),
  )

  async function fetchProviders() {
    if (!canAccessProtectedRoutes()) return
    const profile = requestProfile()
    // 换 Profile 的第一件事是把上一个 Profile 的数据清掉，而不是等新数据回来才换：
    // 中间那段时间页面宁可空着，也不能显示别人的 provider。
    if (loadedProfile.value !== null && loadedProfile.value !== profile) resetProviderData()
    loading.value = true
    loadError.value = null
    try {
      const res = await systemApi.fetchAvailableModelsForProfile(profile)
      // 拉取期间用户又切了 Profile：这一份是过期结果，丢掉，别把上一个 Profile 的
      // provider 列表盖到新选中的 Profile 上。
      if (profile !== requestProfile()) return
      providers.value = res.groups
      allProviders.value = res.allProviders
      defaultModel.value = res.default
      defaultProvider.value = res.default_provider || ''
      loadedProfile.value = profile
    } catch (err: any) {
      // 又切走了就让新的那一轮做主，别把它的状态也擦掉。
      if (profile !== requestProfile()) return
      resetProviderData()
      loadError.value = err?.message || String(err)
      console.error('Failed to fetch providers:', err)
      // 往上抛：页面要据此显示「这个 Profile 没加载出来」，而不是沉默地留着旧卡片。
      throw err
    } finally {
      loading.value = false
    }
  }

  async function refreshModelCache() {
    if (!canAccessProtectedRoutes()) return
    refreshingModelCache.value = true
    try {
      await systemApi.refreshProviderModelCache()
      await fetchProviders()
      await useAppStore().reloadModels()
    } finally {
      refreshingModelCache.value = false
    }
  }

  async function setDefaultModel(modelId: string, provider: string) {
    await systemApi.updateDefaultModel({ default: modelId, provider })
    defaultModel.value = modelId
    defaultProvider.value = provider
    const appStore = useAppStore()
    appStore.reloadModels()
  }

  async function addProvider(data: CustomProvider) {
    await systemApi.addCustomProvider(data)
    await fetchProviders()
    await useAppStore().reloadModels()
  }

  async function removeProvider(name: string, options: { source?: 'custom_providers' | 'providers'; providerKey?: string } = {}) {
    await systemApi.removeCustomProvider(name, options)
    await fetchProviders()
    await useAppStore().reloadModels()
  }

  return {
    providers,
    allProviders,
    defaultModel,
    defaultProvider,
    loading,
    refreshingModelCache,
    loadedProfile,
    loadError,
    customProviders,
    builtinProviders,
    allModels,
    fetchProviders,
    refreshModelCache,
    setDefaultModel,
    addProvider,
    removeProvider,
  }
})
