import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as profilesApi from '@/api/hermes/profiles'
import type { HermesProfile, HermesProfileDetail } from '@/api/hermes/profiles'
import type { CurrentUser } from '@/api/auth'
import { useAppStore } from './app'
import { prewarmConnectorStatus } from '@/utils/connector-status-cache'

const ACTIVE_PROFILE_STORAGE_KEY = 'hermes_active_profile_name'
const ACTIVE_AGENT_STORAGE_KEY = 'hermes_active_agent_id'
const CURRENT_USER_STORAGE_KEY = 'hermes_current_user'

function readStoredCurrentUser(): CurrentUser | null {
  const raw = localStorage.getItem(CURRENT_USER_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CurrentUser
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    localStorage.removeItem(CURRENT_USER_STORAGE_KEY)
    return null
  }
}

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<HermesProfile[]>([])
  // 初始化时同步读 localStorage，确保其他 store（如 chat）在启动时能拿到 profile name
  const activeProfileName = ref<string | null>(localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY))
  const currentUser = ref<CurrentUser | null>(readStoredCurrentUser())
  const activeProfile = ref<HermesProfile | null>(null)
  const detailMap = ref<Record<string, HermesProfileDetail>>({})
  const loading = ref(false)
  const switching = ref(false)

  function persistActiveSelection(profile: HermesProfile | null) {
    if (!profile) {
      localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY)
      localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY)
      return
    }
    activeProfileName.value = profile.name
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, profile.name)
    // Warm the connector-status cache in the background (deduped) so the FIRST open of
    // the connectors panel this session is instant, not a cold ~2s wait. Fire-and-forget.
    prewarmConnectorStatus(profile.name)
    if (profile.agentId && profile.shareRole) {
      localStorage.setItem(ACTIVE_AGENT_STORAGE_KEY, profile.agentId)
    } else {
      localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY)
    }
  }

  async function fetchProfiles() {
    loading.value = true
    try {
      profiles.value = await profilesApi.fetchProfiles()
      const storedName = activeProfileName.value || localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
      let selected = profiles.value.find(p => p.name === storedName) ?? null
      if (!selected && profiles.value.length > 0) {
        selected = profiles.value[0]
        persistActiveSelection(selected)
      }
      profiles.value = profiles.value.map(profile => ({
        ...profile,
        active: !!selected && profile.name === selected.name,
      }))
      activeProfile.value = selected
      if (selected) {
        persistActiveSelection(selected)
      } else {
        activeProfileName.value = null
        localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY)
        localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY)
      }
      // 清理所有会话缓存（不再使用 localStorage 缓存）
      clearAllSessionCaches()
    } catch (err) {
      console.error('Failed to fetch profiles:', err)
    } finally {
      loading.value = false
    }
  }

  async function fetchHermesProfiles() {
    loading.value = true
    try {
      profiles.value = await profilesApi.fetchProfiles()
      activeProfile.value = profiles.value.find(profile => profile.active) ?? null
      clearAllSessionCaches()
    } catch (err) {
      console.error('Failed to fetch Hermes profiles:', err)
    } finally {
      loading.value = false
    }
  }

  async function fetchProfileDetail(name: string) {
    if (detailMap.value[name]) return detailMap.value[name]
    try {
      const detail = await profilesApi.fetchProfileDetail(name)
      detailMap.value[name] = detail
      return detail
    } catch {
      return null
    }
  }

  async function updateAvatar(name: string, avatar: profilesApi.ProfileAvatar) {
    const saved = await profilesApi.updateProfileAvatar(name, avatar)
    profiles.value = profiles.value.map(profile => (
      profile.name === name ? { ...profile, avatar: saved } : profile
    ))
    if (detailMap.value[name]) {
      detailMap.value[name] = { ...detailMap.value[name], avatar: saved }
    }
    if (activeProfile.value?.name === name) {
      activeProfile.value = { ...activeProfile.value, avatar: saved }
    }
    return saved
  }

  async function deleteAvatar(name: string) {
    await profilesApi.deleteProfileAvatar(name)
    profiles.value = profiles.value.map(profile => (
      profile.name === name ? { ...profile, avatar: null } : profile
    ))
    if (detailMap.value[name]) {
      detailMap.value[name] = { ...detailMap.value[name], avatar: null }
    }
    if (activeProfile.value?.name === name) {
      activeProfile.value = { ...activeProfile.value, avatar: null }
    }
  }

  async function createProfile(name: string, clone?: boolean) {
    const res = await profilesApi.createProfile(name, clone)
    if (res.success) await fetchProfiles()
    return res
  }

  async function deleteProfile(name: string) {
    const ok = await profilesApi.deleteProfile(name)
    if (ok) {
      delete detailMap.value[name]
      await fetchProfiles()
    }
    return ok
  }

  // 清理所有 profile 的会话缓存
  function clearAllSessionCaches() {
    // 注意：不再清理任何缓存，因为已经不再使用 localStorage 缓存会话数据
    // 所有会话数据都从服务器实时获取
  }

  async function renameProfile(name: string, newName: string) {
    const ok = await profilesApi.renameProfile(name, newName)
    if (ok) {
      delete detailMap.value[name]
      await fetchProfiles()
    }
    return ok
  }

  async function switchProfile(name: string) {
    switching.value = true
    try {
      const ok = await profilesApi.switchProfile(name)
      if (ok) {
        profiles.value = profiles.value.map(profile => ({
          ...profile,
          active: profile.name === name,
        }))
        activeProfile.value = profiles.value.find(profile => profile.name === name) ?? null
        if (activeProfile.value) {
          persistActiveSelection(activeProfile.value)
        } else {
          activeProfileName.value = name
          localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, name)
          localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY)
        }
        await useAppStore().reloadModels()
      }
      return ok
    } finally {
      switching.value = false
    }
  }

  async function switchHermesProfile(name: string) {
    switching.value = true
    try {
      const ok = await profilesApi.switchHermesProfile(name)
      if (ok) await fetchHermesProfiles()
      return ok
    } finally {
      switching.value = false
    }
  }

  async function exportProfile(name: string) {
    return profilesApi.exportProfile(name)
  }

  async function importProfile(file: File) {
    const ok = await profilesApi.importProfile(file)
    if (ok) await fetchProfiles()
    return ok
  }

  function setCurrentUser(user: CurrentUser | null) {
    currentUser.value = user
    if (user) {
      localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(user))
    } else {
      localStorage.removeItem(CURRENT_USER_STORAGE_KEY)
    }
  }

  function setBoundProfile(name: string, user?: CurrentUser | null) {
    const storedName = activeProfileName.value || localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
    const ownedProfiles = new Set<string>([name])
    if (Array.isArray(user?.profiles)) {
      user.profiles
        .filter(profile => typeof profile === 'string' && profile.trim().length > 0)
        .forEach(profile => ownedProfiles.add(profile))
    }
    const selectedName = storedName && ownedProfiles.has(storedName) ? storedName : name
    activeProfileName.value = selectedName
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, selectedName)
    localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY)
    if (profiles.value.length > 0) {
      profiles.value = profiles.value.map(profile => ({
        ...profile,
        active: profile.name === selectedName,
      }))
      activeProfile.value = profiles.value.find(profile => profile.name === selectedName) ?? null
      persistActiveSelection(activeProfile.value)
    }
    if (user !== undefined) {
      setCurrentUser(user)
    }
  }

  return {
    profiles,
    activeProfile,
    activeProfileName,
    currentUser,
    detailMap,
    loading,
    switching,
    fetchProfiles,
    fetchHermesProfiles,
    fetchProfileDetail,
    createProfile,
    deleteProfile,
    renameProfile,
    switchProfile,
    switchHermesProfile,
    exportProfile,
    importProfile,
    updateAvatar,
    deleteAvatar,
    clearAllSessionCaches,
    setCurrentUser,
    setBoundProfile,
  }
})
