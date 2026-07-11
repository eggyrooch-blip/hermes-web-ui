// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileList from '@/components/hermes/files/FileList.vue'
import { useFilesStore } from '@/stores/hermes/files'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /></button>' },
  NSpin: { props: ['show'], template: '<div><slot /></div>' },
  NEmpty: { props: ['description'], template: '<div class="empty">{{ description }}</div>' },
  useMessage: () => ({ error: vi.fn() }),
}))

describe('FileList layout', () => {
  beforeEach(() => {
    createTestingPinia({ stubActions: false, createSpy: vi.fn })
  })

  it('uses the same column grid for header and rows', () => {
    const store = useFilesStore()
    store.entries = [
      {
        name: 'very-long-file-name-that-should-not-push-size-or-date-columns.md',
        path: '/workspace/very-long-file-name-that-should-not-push-size-or-date-columns.md',
        isDir: false,
        size: 2048,
        modTime: '2026-06-06T08:00:00.000Z',
      },
    ]

    const wrapper = mount(FileList)

    expect(wrapper.find('.file-list-header').classes()).toContain('file-list-grid')
    expect(wrapper.find('.file-list-row').classes()).toContain('file-list-grid')
    expect(wrapper.find('.file-name .file-label').exists()).toBe(true)
  })

  it('previews a text file on double click while the pencil still opens the editor', async () => {
    const store = useFilesStore()
    const entry = {
      name: 'notes.txt',
      path: 'notes.txt',
      isDir: false,
      size: 12,
      modTime: '2026-07-11T08:00:00.000Z',
    }
    store.entries = [entry]
    const openPreview = vi.spyOn(store, 'openPreview').mockResolvedValue(undefined)
    const openEditor = vi.spyOn(store, 'openEditor').mockResolvedValue(true)
    const wrapper = mount(FileList)

    await wrapper.find('.file-list-row').trigger('dblclick')

    expect(openPreview).toHaveBeenCalledWith(entry)
    expect(openEditor).not.toHaveBeenCalled()

    await wrapper.find('button[title="files.edit"]').trigger('click')
    expect(openEditor).toHaveBeenCalledWith('notes.txt')
    expect(wrapper.emitted('editor-opened')).toHaveLength(1)
  })

  it('can disable editing without disabling file preview', async () => {
    const store = useFilesStore()
    const entry = {
      name: 'notes.txt',
      path: 'notes.txt',
      isDir: false,
      size: 12,
      modTime: '2026-07-11T08:00:00.000Z',
    }
    store.entries = [entry]
    const openPreview = vi.spyOn(store, 'openPreview').mockResolvedValue(undefined)
    const openEditor = vi.spyOn(store, 'openEditor').mockResolvedValue(undefined)
    const wrapper = mount(FileList, { props: { allowEdit: false } })

    expect(wrapper.find('button[title="files.edit"]').exists()).toBe(false)
    await wrapper.find('.file-list-row').trigger('dblclick')
    expect(openPreview).toHaveBeenCalledWith(entry)
    expect(openEditor).not.toHaveBeenCalled()
  })
})
