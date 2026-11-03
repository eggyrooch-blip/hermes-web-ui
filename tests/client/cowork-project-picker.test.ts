// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const router = {
  push: vi.fn(),
  currentRoute: { value: { query: { profile: 'research' } } },
}

vi.mock('vue-router', () => ({ useRouter: () => router }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', async importOriginal => ({
  ...await importOriginal<typeof import('naive-ui')>(),
  useMessage: () => ({ error: vi.fn() }),
}))
vi.mock('@/api/hermes/cowork', () => ({
  listCoworkProjects: vi.fn(async () => []),
  getCoworkProject: vi.fn(),
  createCoworkProject: vi.fn(),
}))

import CoworkProjectPicker from '@/components/hermes/chat/CoworkProjectPicker.vue'
import { createCoworkProject, getCoworkProject, listCoworkProjects } from '@/api/hermes/cowork'

const oldProject: any = { id: 'prj-old', name: 'Old', status: 'active' }
const newProject: any = { id: 'prj-new', name: 'New', status: 'active' }
const detailedProject: any = {
  id: 'prj-alpha', name: 'Alpha', description: 'Quarterly work', instructions: 'Use concise tables.',
  primary_folder: 'private/folder', status: 'active',
}

describe('CoworkProjectPicker', () => {
  beforeEach(() => {
    router.push.mockReset()
    vi.mocked(listCoworkProjects).mockReset().mockResolvedValue([])
    vi.mocked(getCoworkProject).mockReset().mockResolvedValue(detailedProject)
    vi.mocked(createCoworkProject).mockReset()
  })

  it('keeps the current profile when opening all Projects', async () => {
    const wrapper = mount(CoworkProjectPicker, { props: { modelValue: null } })
    await (wrapper.vm as any).setOpen(true)
    await flushPromises()

    const button = [...document.querySelectorAll('button')]
      .find(item => item.textContent?.includes('cowork.viewAllProjects'))
    button?.click()
    await flushPromises()

    expect(router.push).toHaveBeenCalledWith({
      name: 'hermes.coworkProject', query: { profile: 'research' },
    })
  })

  it('keeps the current profile when opening Project details', async () => {
    const wrapper = mount(CoworkProjectPicker, { props: { modelValue: detailedProject } })
    await (wrapper.vm as any).setOpen(true)
    await flushPromises()

    const button = [...document.querySelectorAll('button')]
      .find(item => item.textContent?.includes('cowork.openProject'))
    button?.click()
    await flushPromises()

    expect(router.push).toHaveBeenCalledWith({
      name: 'hermes.coworkProject',
      params: { projectId: 'prj-alpha' },
      query: { profile: 'research' },
    })
  })

  it('emits draft and frozen selections so the parent can create a new task', async () => {
    const draft = mount(CoworkProjectPicker, { props: { modelValue: null } })
    await (draft.vm as any).setOpen(true)
    expect((draft.vm as any).open).toBe(true)
    await (draft.vm as any).chooseProject(newProject)
    expect(draft.emitted('update:modelValue')?.[0]).toEqual([newProject])
    await draft.setProps({ modelValue: newProject, frozen: true })
    await flushPromises()
    expect((draft.vm as any).open).toBe(false)

    const frozen = mount(CoworkProjectPicker, { props: { modelValue: oldProject, frozen: true } })
    await flushPromises()
    expect(frozen.get('button').attributes('disabled')).toBeUndefined()
    expect(frozen.attributes('data-selected-project-id')).toBe('prj-old')
    await (frozen.vm as any).setOpen(true)
    await (frozen.vm as any).chooseProject(newProject)
    expect(frozen.emitted('update:modelValue')?.[0]).toEqual([newProject])
  })

  it('keeps the newest search response and exposes an unavailable state', async () => {
    let resolveOld!: (value: any[]) => void
    let resolveNew!: (value: any[]) => void
    vi.mocked(listCoworkProjects)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve }))
    const wrapper = mount(CoworkProjectPicker, { props: { modelValue: null } })
    const oldRequest = (wrapper.vm as any).loadProjects('old')
    const newRequest = (wrapper.vm as any).loadProjects('new')
    resolveNew([newProject])
    await newRequest
    resolveOld([oldProject])
    await oldRequest
    expect(vi.mocked(listCoworkProjects)).toHaveBeenLastCalledWith('new')

    vi.mocked(listCoworkProjects).mockRejectedValueOnce(new Error('unavailable'))
    await (wrapper.vm as any).loadProjects('')
    expect((wrapper.vm as any).loadError).toBe(true)
  })

  it('deduplicates create while a request is in flight', async () => {
    let resolveCreate!: (value: any) => void
    vi.mocked(createCoworkProject).mockImplementation(() => new Promise(resolve => { resolveCreate = resolve }))
    const wrapper = mount(CoworkProjectPicker, { props: { modelValue: null } })
    ;(wrapper.vm as any).name = 'One project'
    const first = (wrapper.vm as any).createProject()
    const second = (wrapper.vm as any).createProject()
    expect(createCoworkProject).toHaveBeenCalledTimes(1)
    resolveCreate(newProject)
    await Promise.all([first, second])
  })

  it('does not create while an IME composition is being confirmed', async () => {
    const wrapper = mount(CoworkProjectPicker, { props: { modelValue: null } })
    ;(wrapper.vm as any).name = '项目'
    ;(wrapper.vm as any).createProjectFromKeyboard({ isComposing: true, keyCode: 229 })
    expect(createCoworkProject).not.toHaveBeenCalled()
  })

  it('shows the selected Project context without exposing its workspace folder', async () => {
    vi.mocked(listCoworkProjects).mockResolvedValue([detailedProject])
    const wrapper = mount(CoworkProjectPicker, {
      props: { modelValue: { ...detailedProject, description: '', instructions: '' }, frozen: true },
    })

    await (wrapper.vm as any).setOpen(true)
    await flushPromises()

    const context = document.querySelector('.cowork-context')
    expect(context?.textContent).toContain('Quarterly work')
    expect(context?.textContent).toContain('Use concise tables.')
    expect(context?.textContent).not.toContain('private/folder')
  })

  it('keeps selected Project context while search results change', async () => {
    vi.mocked(listCoworkProjects)
      .mockResolvedValueOnce([detailedProject])
      .mockResolvedValueOnce([newProject])
    const wrapper = mount(CoworkProjectPicker, {
      props: { modelValue: { ...detailedProject, description: '', instructions: '' }, frozen: true },
    })

    await (wrapper.vm as any).setOpen(true)
    await (wrapper.vm as any).loadProjects('missing')
    await flushPromises()

    expect(document.querySelector('.cowork-context')?.textContent).toContain('Quarterly work')
    expect(document.querySelector('.cowork-context')?.textContent).toContain('Use concise tables.')
  })
})
