// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const fetchEntriesMock = vi.hoisted(() => vi.fn())
const filesStoreMock = vi.hoisted(() => ({
  editingFile: null,
  previewFile: null,
  currentPath: '',
  sortedEntries: [
    { name: 'uploads', path: 'uploads', isDir: true, size: 0, modTime: '2026-05-07T00:00:00Z' },
    { name: 'note.md', path: 'note.md', isDir: false, size: 128, modTime: '2026-05-07T00:00:00Z' },
  ],
  fetchEntries: fetchEntriesMock,
}))

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => filesStoreMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/hermes/files/FileTree.vue', () => ({
  default: { template: '<div>FileTree</div>' },
}))
vi.mock('@/components/hermes/files/FileBreadcrumb.vue', () => ({
  default: { template: '<div>FileBreadcrumb</div>' },
}))
vi.mock('@/components/hermes/files/FileToolbar.vue', () => ({
  default: { template: '<div>FileToolbar</div>' },
}))
vi.mock('@/components/hermes/files/FileList.vue', () => ({
  default: { template: '<div>FileList</div>' },
}))
vi.mock('@/components/hermes/files/FileContextMenu.vue', () => ({
  default: { template: '<div>FileContextMenu</div>' },
}))
vi.mock('@/components/hermes/files/FileEditor.vue', () => ({
  default: { template: '<div>FileEditor</div>' },
}))
vi.mock('@/components/hermes/files/FilePreview.vue', () => ({
  default: { template: '<div>FilePreview</div>' },
}))
vi.mock('@/components/hermes/files/FileUploadModal.vue', () => ({
  default: { template: '<div>FileUploadModal</div>' },
}))
vi.mock('@/components/hermes/files/FileRenameModal.vue', () => ({
  default: { template: '<div>FileRenameModal</div>' },
}))

import FilesView from '@/views/hermes/FilesView.vue'

describe('FilesView user mode', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    filesStoreMock.editingFile = null
    filesStoreMock.previewFile = null
    filesStoreMock.currentPath = ''
    filesStoreMock.sortedEntries = [
      { name: 'uploads', path: 'uploads', isDir: true, size: 0, modTime: '2026-05-07T00:00:00Z' },
      { name: 'note.md', path: 'note.md', isDir: false, size: 128, modTime: '2026-05-07T00:00:00Z' },
    ]
    fetchEntriesMock.mockClear()
  })

  it('shows a workspace-scoped page header in user mode', () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(FilesView)

    expect(wrapper.text()).toContain('files.title')
    expect(wrapper.text()).toContain('files.workspaceScope')
  })

  it('summarizes the visible profile workspace without exposing host paths', () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(FilesView)

    const stats = wrapper.find('.workspace-stats')
    expect(stats.exists()).toBe(true)
    expect(stats.text()).toContain('files.workspaceFolders')
    expect(stats.text()).toContain('files.workspaceFiles')
    expect(stats.text()).toContain('files.workspaceCurrentPath')
    expect(stats.text()).not.toContain('/Users/')
    expect(stats.text()).not.toContain('.hermes')
  })

  it('keeps the file tree behind an explicit mobile toggle', async () => {
    const wrapper = mount(FilesView)

    expect(wrapper.find('.tree-toggle').exists()).toBe(true)
    expect(wrapper.find('.files-tree-panel').classes()).not.toContain('mobile-visible')

    await wrapper.find('.tree-toggle').trigger('click')

    expect(wrapper.find('.files-tree-panel').classes()).toContain('mobile-visible')
    expect(wrapper.find('.files-tree-overlay').exists()).toBe(true)
  })
})
