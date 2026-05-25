// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockProfilesApi = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  fetchProfileDetail: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  switchProfile: vi.fn(),
  updateProfileAvatar: vi.fn(),
  deleteProfileAvatar: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
}))

vi.mock('@/api/hermes/profiles', () => mockProfilesApi)

import { useProfilesStore } from '@/stores/hermes/profiles'

describe('Profiles Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('fetchProfiles loads profiles and sets active', async () => {
    const profiles = [
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', gateway: 'stopped', alias: '' },
    ]
    mockProfilesApi.fetchProfiles.mockResolvedValue(profiles)

    const store = useProfilesStore()
    await store.fetchProfiles()

    expect(store.profiles).toEqual(profiles)
    expect(store.activeProfile?.name).toBe('default')
    expect(store.loading).toBe(false)
  })

  it('stores Feishu display user when setting bound profile', () => {
    const store = useProfilesStore()

    store.setBoundProfile('g41a5b5g', {
      openid: 'ou_test',
      profile: 'g41a5b5g',
      role: 'user',
      name: '张三',
      avatarUrl: 'https://example.com/avatar.png',
    })

    expect(store.currentUser?.name).toBe('张三')
    expect(store.currentUser?.avatarUrl).toBe('https://example.com/avatar.png')
    expect(localStorage.getItem('hermes_current_user')).toContain('张三')
  })

  it('does not clobber an already selected owner profile when refreshing the bound Feishu user', () => {
    localStorage.setItem('hermes_active_profile_name', 'feishu_group_alpha')
    const store = useProfilesStore()
    store.profiles = [
      { name: 'g41a5b5g', active: false, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'feishu_group_alpha', active: true, model: 'gpt-4', gateway: 'running', alias: '', displayLabel: '研发群' },
    ] as any

    store.setBoundProfile('g41a5b5g', {
      openid: 'ou_test',
      profile: 'g41a5b5g',
      role: 'user',
      name: '张三',
    })

    expect(store.currentUser?.profile).toBe('g41a5b5g')
    expect(store.activeProfileName).toBe('feishu_group_alpha')
    expect(store.activeProfile?.name).toBe('feishu_group_alpha')
  })

  it('fetchProfiles sets loading state', async () => {
    mockProfilesApi.fetchProfiles.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([]), 10))
    )

    const store = useProfilesStore()
    const fetchPromise = store.fetchProfiles()

    expect(store.loading).toBe(true)
    await fetchPromise
    expect(store.loading).toBe(false)
  })

  it('uses owner-scoped profiles in user mode and keeps the bound Feishu profile active', async () => {
    localStorage.setItem('hermes_web_plane', 'chat')
    localStorage.setItem('hermes_current_user', JSON.stringify({
      openid: 'ou_test',
      profile: 'g41a5b5g',
      role: 'user',
      name: '张三',
    }))
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'g41a5b5g', active: false, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'webui_child_research', active: false, model: 'gpt-4', gateway: 'running', alias: '' },
    ])

    const store = useProfilesStore()
    await store.fetchProfiles()

    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalled()
    expect(store.activeProfileName).toBe('g41a5b5g')
    expect(store.activeProfile?.name).toBe('g41a5b5g')
    expect(store.profiles.map(p => p.name)).toEqual(['g41a5b5g', 'webui_child_research'])
  })

  it('switches the selected owner profile locally in user mode without changing the global Hermes active profile', async () => {
    localStorage.setItem('hermes_web_plane', 'chat')
    localStorage.setItem('hermes_current_user', JSON.stringify({
      openid: 'ou_test',
      profile: 'g41a5b5g',
      role: 'user',
      name: '张三',
    }))

    const store = useProfilesStore()
    store.profiles = [
      { name: 'g41a5b5g', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'feishu_group_alpha', active: false, model: 'gpt-4', gateway: 'running', alias: '', displayLabel: '研发群' },
    ] as any
    store.activeProfileName = 'g41a5b5g'

    const ok = await store.switchProfile('feishu_group_alpha')

    expect(ok).toBe(true)
    expect(mockProfilesApi.switchProfile).not.toHaveBeenCalled()
    expect(store.activeProfileName).toBe('feishu_group_alpha')
    expect(store.activeProfile?.name).toBe('feishu_group_alpha')
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('feishu_group_alpha')
  })

  it('updates profile avatars in list, detail cache, and active profile state', async () => {
    const avatar = { type: 'generated' as const, seed: 'sunke-seed' }
    mockProfilesApi.updateProfileAvatar.mockResolvedValue(avatar)
    const store = useProfilesStore()
    store.profiles = [{ name: 'sunke', active: true, model: 'gpt-4', gateway: 'running', alias: '' }] as any
    store.activeProfile = store.profiles[0] as any
    store.detailMap = {
      sunke: {
        name: 'sunke',
        path: '/tmp/sunke',
        model: 'gpt-4',
        provider: 'openai',
        gateway: 'running',
        skills: 1,
        hasEnv: true,
        hasSoulMd: true,
      },
    } as any

    await store.updateAvatar('sunke', avatar)

    expect(mockProfilesApi.updateProfileAvatar).toHaveBeenCalledWith('sunke', avatar)
    expect(store.profiles[0].avatar).toEqual(avatar)
    expect(store.activeProfile?.avatar).toEqual(avatar)
    expect(store.detailMap.sunke.avatar).toEqual(avatar)
  })

  it('clears profile avatars in list, detail cache, and active profile state', async () => {
    mockProfilesApi.deleteProfileAvatar.mockResolvedValue(undefined)
    const store = useProfilesStore()
    store.profiles = [{ name: 'sunke', active: true, model: 'gpt-4', gateway: 'running', alias: '', avatar: { type: 'generated', seed: 'old' } }] as any
    store.activeProfile = store.profiles[0] as any
    store.detailMap = {
      sunke: {
        name: 'sunke',
        path: '/tmp/sunke',
        model: 'gpt-4',
        provider: 'openai',
        gateway: 'running',
        skills: 1,
        hasEnv: true,
        hasSoulMd: true,
        avatar: { type: 'generated', seed: 'old' },
      },
    } as any

    await store.deleteAvatar('sunke')

    expect(mockProfilesApi.deleteProfileAvatar).toHaveBeenCalledWith('sunke')
    expect(store.profiles[0].avatar).toBeNull()
    expect(store.activeProfile?.avatar).toBeNull()
    expect(store.detailMap.sunke.avatar).toBeNull()
  })

  it('createProfile calls API and refreshes list', async () => {
    mockProfilesApi.createProfile.mockResolvedValue({ success: true })
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'new-profile', active: false, model: 'gpt-4', gateway: 'stopped', alias: '' },
    ])

    const store = useProfilesStore()
    const result = await store.createProfile('new-profile', false)

    expect(result.success).toBe(true)
    expect(mockProfilesApi.createProfile).toHaveBeenCalledWith('new-profile', false)
    expect(store.profiles).toHaveLength(2)
  })

  it('deleteProfile clears detail cache', async () => {
    mockProfilesApi.deleteProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
    ])

    const store = useProfilesStore()
    store.detailMap['test'] = { name: 'test', path: '/tmp/test', model: '', provider: '', gateway: '', skills: 0, hasEnv: false, hasSoulMd: false }

    await store.deleteProfile('test')

    expect(store.detailMap['test']).toBeUndefined()
    expect(mockProfilesApi.deleteProfile).toHaveBeenCalledWith('test')
  })

  it('fetchProfileDetail uses cache', async () => {
    const detail = { name: 'cached', path: '/tmp/cached', model: 'gpt-4', provider: 'openai', gateway: 'running', skills: 5, hasEnv: true, hasSoulMd: false }
    const store = useProfilesStore()
    store.detailMap['cached'] = detail

    const result = await store.fetchProfileDetail('cached')

    expect(result).toEqual(detail)
    expect(mockProfilesApi.fetchProfileDetail).not.toHaveBeenCalled()
  })

  it('switchProfile sets switching state', async () => {
    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([])

    const store = useProfilesStore()
    const switchPromise = store.switchProfile('dev')

    expect(store.switching).toBe(true)
    await switchPromise
    expect(store.switching).toBe(false)
  })

  it('switchProfile updates activeProfileName immediately', async () => {
    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: false, model: 'gpt-4', gateway: 'stopped', alias: '' },
      { name: 'dev', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
    ])

    const store = useProfilesStore()
    await store.switchProfile('dev')

    // activeProfileName should be updated immediately
    expect(store.activeProfileName).toBe('dev')
    // localStorage should also be updated
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })

  it('switchProfile does not update state when API fails', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(false)  // API failed

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return false
    expect(result).toBe(false)
    // activeProfileName should NOT change
    expect(store.activeProfileName).toBe(initialName)
    // localStorage should NOT change
    expect(localStorage.getItem('hermes_active_profile_name')).toBe(initialName)
  })

  it('switchProfile keeps activeProfileName even if fetchProfiles fails', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockRejectedValue(new Error('Network error'))

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return true (API succeeded)
    expect(result).toBe(true)
    // activeProfileName should be updated even though fetchProfiles failed
    expect(store.activeProfileName).toBe('dev')
    // localStorage should be updated
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })

  it('switchProfile rolls back if backend reports different active profile', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(true)
    // Backend returns success, but active profile is still default (not the one we switched to)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', gateway: 'stopped', alias: '' },
    ])

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return false (backend verification failed)
    expect(result).toBe(false)
    // activeProfileName should be rolled back to default
    expect(store.activeProfileName).toBe('default')
    // localStorage should be rolled back
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('default')
  })
})
