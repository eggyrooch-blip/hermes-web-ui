// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// Models 设置页的 Profile 过滤器只活在 URL 里，所以这些用例共享同一个 route 对象：
// 组件通过 useRoute()/useRouter() 读写它，api/client 通过 router 单例读它。两边看到
// 的必须是同一份，否则测不出「页面选中的 Profile 决定请求打到谁」。
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  const route = reactive({ name: 'hermes.models', query: {} as Record<string, unknown> })
  const router = {
    replace: (to: { query?: Record<string, unknown> }) => {
      route.query = { ...(to.query || {}) }
      return Promise.resolve()
    },
  }
  return { useRoute: () => route, useRouter: () => router, __route: route }
})

vi.mock('@/router', async () => {
  const vueRouter = await import('vue-router') as unknown as { __route: { name: string; query: Record<string, unknown> } }
  return {
    default: {
      get currentRoute() { return { value: vueRouter.__route } },
      replace: vi.fn(),
    },
  }
})

const fetchProfilesMock = vi.hoisted(() => vi.fn())
const fetchAvailableModelsForProfileMock = vi.hoisted(() => vi.fn())
const fetchAvailableModelsMock = vi.hoisted(() => vi.fn())
const removeCustomProviderMock = vi.hoisted(() => vi.fn())
const checkCopilotTokenMock = vi.hoisted(() => vi.fn())
const fetchAuxiliaryModelsMock = vi.hoisted(() => vi.fn())
const dialogCalls = vi.hoisted(() => [] as { options: any; destroy: ReturnType<typeof vi.fn> }[])

vi.mock('@/api/hermes/profiles', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchProfiles: fetchProfilesMock,
}))

vi.mock('@/api/hermes/system', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchAvailableModelsForProfile: fetchAvailableModelsForProfileMock,
  fetchAvailableModels: fetchAvailableModelsMock,
  removeCustomProvider: removeCustomProviderMock,
}))

vi.mock('@/api/hermes/config', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchAuxiliaryModels: fetchAuxiliaryModelsMock,
}))

vi.mock('@/api/hermes/copilot-auth', () => ({
  checkCopilotToken: checkCopilotTokenMock,
  disableCopilot: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({ clearProviderFromSessions: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NSelect: {
    props: ['value', 'options', 'disabled', 'loading', 'filterable', 'size'],
    emits: ['update:value'],
    template: '<select class="n-select" :disabled="disabled" :value="value" @change="$emit(\'update:value\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
  },
  NButton: {
    props: ['disabled', 'loading', 'type', 'size', 'quaternary'],
    emits: ['click'],
    template: '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  NSpin: {
    props: ['show', 'size', 'description'],
    template: '<div class="n-spin"><slot /></div>',
  },
  NModal: {
    props: ['show', 'preset', 'title', 'style'],
    template: '<div class="n-modal"><slot /><slot name="footer" /></div>',
  },
  NInput: { props: ['value', 'placeholder'], emits: ['update:value'], template: '<input class="n-input" :value="value" />' },
  NInputNumber: { props: ['value'], emits: ['update:value'], template: '<input class="n-input-number" :value="value" />' },
  NCheckbox: { props: ['value', 'checked', 'label'], template: '<label class="n-checkbox"><slot /></label>' },
  NCheckboxGroup: { props: ['value'], emits: ['update:value'], template: '<div class="n-checkbox-group"><slot /></div>' },
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  useDialog: () => ({
    warning: (options: any) => {
      const instance = { options, destroy: vi.fn() }
      dialogCalls.push(instance)
      return instance
    },
  }),
}))

import { request } from '@/api/client'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { useModelsStore } from '@/stores/hermes/models'
import ModelsView from '@/views/hermes/ModelsView.vue'

const PROFILES = [{ name: 'profile-a' }, { name: 'profile-b' }]

// 两个 Profile 给两套完全不同的 provider，这样「卡片属于谁」在 DOM 上直接看得出来。
const PROVIDERS_BY_PROFILE: Record<string, { provider: string; label: string }> = {
  'profile-a': { provider: 'custom:alpha', label: 'Alpha Gateway' },
  'profile-b': { provider: 'custom:beta', label: 'Beta Gateway' },
}

function modelsResponse(profile: string) {
  const spec = PROVIDERS_BY_PROFILE[profile]
  const group = {
    provider: spec.provider,
    label: spec.label,
    base_url: 'https://gateway.invalid/v1',
    models: [`${profile}-model`],
    available_models: [`${profile}-model`],
    provider_source: 'custom_providers' as const,
    provider_key: spec.provider,
  }
  return {
    default: `${profile}-model`,
    default_provider: spec.provider,
    groups: [group],
    allProviders: [group],
  }
}

async function currentRoute() {
  const vueRouter = await import('vue-router') as unknown as { __route: { name: string; query: Record<string, unknown> } }
  return vueRouter.__route
}

// 每个用例的 ModelsView 都要卸载：它们共享同一个 reactive route，留着的实例会跟着
// 下一个用例改 URL 一起重新拉 providers，调用次数就不可判了。
const mounted: ReturnType<typeof mount>[] = []

async function mountModelsView() {
  const wrapper = mount(ModelsView)
  mounted.push(wrapper)
  await flushPromises()
  await flushPromises()
  return wrapper
}

function providerLabels(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.provider-card .provider-name').map(node => node.text())
}

function addProviderButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.page-header button').at(-1)!
}

async function selectProfile(wrapper: ReturnType<typeof mount>, profile: string) {
  const select = wrapper.get('[data-testid="models-profile-select"]')
  ;(select.element as HTMLSelectElement).value = profile
  await select.trigger('change')
  await flushPromises()
  await flushPromises()
}

describe('Models page Profile filter', () => {
  beforeEach(async () => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    dialogCalls.length = 0
    const route = await currentRoute()
    route.name = 'hermes.models'
    route.query = {}
    fetchProfilesMock.mockResolvedValue(PROFILES)
    checkCopilotTokenMock.mockResolvedValue({ source: 'env' })
    fetchAuxiliaryModelsMock.mockResolvedValue({ tasks: [], auxiliary: {} })
    fetchAvailableModelsMock.mockResolvedValue(modelsResponse('profile-a'))
    fetchAvailableModelsForProfileMock.mockImplementation(async (profile: string) => modelsResponse(profile))
    removeCustomProviderMock.mockResolvedValue(undefined)
    localStorage.setItem('hermes_api_key', 'test-token')
    localStorage.setItem('hermes_active_profile_name', 'profile-a')
  })

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount()
  })

  it('pins the page-selected Profile into the URL and loads that Profile 的模型列表', async () => {
    const wrapper = await mountModelsView()

    const route = await currentRoute()
    expect(route.query.modelProfile).toBe('profile-a')

    const select = wrapper.get('[data-testid="models-profile-select"]')
    expect(select.findAll('option').map(o => o.attributes('value'))).toEqual(['profile-a', 'profile-b'])
    expect((select.element as HTMLSelectElement).value).toBe('profile-a')
    expect(fetchAvailableModelsForProfileMock).toHaveBeenCalledWith('profile-a')
  })

  it('两个 Profile 渲染出各自真实的 provider 卡片（面板不 stub）', async () => {
    const wrapper = await mountModelsView()
    expect(providerLabels(wrapper)).toEqual(['Alpha Gateway'])
    expect(wrapper.find('.auxiliary-panel, .auxiliary-models').exists() || wrapper.html().includes('models.auxiliaryTitle')).toBe(true)

    await selectProfile(wrapper, 'profile-b')

    expect(providerLabels(wrapper)).toEqual(['Beta Gateway'])
    expect(useModelsStore().loadedProfile).toBe('profile-b')
  })

  it('切换 Profile 后重新拉该 Profile 的模型，且不改全局 active profile', async () => {
    const wrapper = await mountModelsView()
    fetchAvailableModelsForProfileMock.mockClear()

    await selectProfile(wrapper, 'profile-b')

    const route = await currentRoute()
    expect(route.query.modelProfile).toBe('profile-b')
    expect(fetchAvailableModelsForProfileMock).toHaveBeenCalledTimes(1)
    expect(fetchAvailableModelsForProfileMock).toHaveBeenCalledWith('profile-b')
    // Models 页只是「看」别的 Profile，不切换全局 active profile。
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('profile-a')
  })

  // P1 #1：P1 加载成功后切 P2 失败，绝不能留着 P1 的卡片 —— 否则看到的是 P1、
  // 删除请求却带着 P2 的 header。
  it('P1 成功后切 P2 失败：清空旧数据、报错、禁用写操作', async () => {
    const wrapper = await mountModelsView()
    expect(providerLabels(wrapper)).toEqual(['Alpha Gateway'])

    fetchAvailableModelsForProfileMock.mockRejectedValueOnce(new Error('boom: profile-b unavailable'))
    await selectProfile(wrapper, 'profile-b')

    const store = useModelsStore()
    expect(store.providers).toEqual([])
    expect(store.allProviders).toEqual([])
    expect(store.defaultProvider).toBe('')
    expect(store.loadedProfile).toBeNull()
    expect(store.loadError).toContain('boom: profile-b unavailable')
    expect(providerLabels(wrapper)).toEqual([])
    expect(wrapper.find('.models-profile-error').text()).toContain('boom: profile-b unavailable')
    expect(addProviderButton(wrapper).attributes('disabled')).toBeDefined()
    // 选择器已经指向 P2，所以页面上不允许再有任何属于 P1 的可操作数据。
    expect((wrapper.get('[data-testid="models-profile-select"]').element as HTMLSelectElement).value).toBe('profile-b')
  })

  // P1 #2：侧栏 Models 入口只带 route name，query 会被清掉。组件还显示 P2 而
  // getModelsPageProfile() 返回 null 时，写请求会落到 active profile 上。
  it('重复点侧栏 Models 清掉 query 后，把当前 Profile 写回 URL', async () => {
    const wrapper = await mountModelsView()
    await selectProfile(wrapper, 'profile-b')
    fetchAvailableModelsForProfileMock.mockClear()

    const route = await currentRoute()
    route.query = {}
    await flushPromises()
    await flushPromises()

    expect(route.query.modelProfile).toBe('profile-b')
    expect((wrapper.get('[data-testid="models-profile-select"]').element as HTMLSelectElement).value).toBe('profile-b')
    // 不能因为 query 丢了就去拉 active profile(profile-a) 的数据。
    expect(fetchAvailableModelsForProfileMock).not.toHaveBeenCalledWith('profile-a')
    expect(providerLabels(wrapper)).toEqual(['Beta Gateway'])
  })

  it('非法 modelProfile（未知名字 / 数组）一律被规范化回合法 Profile', async () => {
    const wrapper = await mountModelsView()
    await selectProfile(wrapper, 'profile-b')
    const route = await currentRoute()

    route.query = { modelProfile: 'ghost-profile' }
    await flushPromises()
    await flushPromises()
    expect(route.query.modelProfile).toBe('profile-b')

    route.query = { modelProfile: ['profile-a', 'profile-b'] }
    await flushPromises()
    await flushPromises()
    expect(route.query.modelProfile).toBe('profile-b')
    expect(providerLabels(wrapper)).toEqual(['Beta Gateway'])
  })

  // P1 #3：确认框挂在 App 根部的 NDialogProvider 上，卡片卸载后它还活着。
  it('打开删除确认 → 离开页面 → 点确认：不发删除请求', async () => {
    const wrapper = await mountModelsView()
    await selectProfile(wrapper, 'profile-b')

    const deleteButton = wrapper.findAll('.provider-card .card-actions button').at(-1)!
    await deleteButton.trigger('click')
    await flushPromises()
    expect(dialogCalls).toHaveLength(1)

    // 用户退回聊天页：ModelsView 连同卡片一起卸载，URL 上的 modelProfile 不再生效。
    wrapper.unmount()
    mounted.length = 0
    const route = await currentRoute()
    route.name = 'hermes.chat'
    await flushPromises()

    await dialogCalls[0].options.onPositiveClick()

    expect(removeCustomProviderMock).not.toHaveBeenCalled()
    expect(dialogCalls[0].destroy).toHaveBeenCalled()
  })

  it('模型设置类请求带页面选中的 Profile，会话类请求仍带 active profile', async () => {
    const route = await currentRoute()
    route.query = { modelProfile: 'profile-b' }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await request('/api/hermes/config/auxiliary-models')
    await request('/api/hermes/model-visibility', { method: 'PUT', body: JSON.stringify({ provider: 'p', mode: 'all', models: [] }) })
    await request('/api/hermes/sessions/abc')

    const headersFor = (path: string) => (fetchMock.mock.calls.find(call => String(call[0]).endsWith(path)) as any)[1].headers
    expect(headersFor('/api/hermes/config/auxiliary-models')['X-Hermes-Profile']).toBe('profile-b')
    expect(headersFor('/api/hermes/model-visibility')['X-Hermes-Profile']).toBe('profile-b')
    expect(headersFor('/api/hermes/sessions/abc')['X-Hermes-Profile']).toBe('profile-a')
    vi.unstubAllGlobals()
  })

  it('离开 Models 页后 URL 上的 modelProfile 不再影响请求', async () => {
    const route = await currentRoute()
    route.name = 'hermes.chat'
    route.query = { modelProfile: 'profile-b' }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await request('/api/hermes/config/auxiliary-models')

    expect((fetchMock.mock.calls[0] as any)[1].headers['X-Hermes-Profile']).toBe('profile-a')
    vi.unstubAllGlobals()
  })

  it('辅助模型标题标明 Hermes scope', () => {
    expect(zh.models.auxiliaryTitle).toBe('辅助模型（Hermes）')
    expect(en.models.auxiliaryTitle).toBe('Auxiliary Models (Hermes)')
  })
})
