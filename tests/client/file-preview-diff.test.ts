// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const fetchWorkspaceRunChangeFileMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/sessions', () => ({
  fetchWorkspaceRunChangeFile: fetchWorkspaceRunChangeFileMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    props: ['tag', 'href'],
    emits: ['click'],
    template: '<button @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  },
  NIcon: { template: '<span><slot /></span>' },
  NAlert: { props: ['type'], template: '<div class="alert"><slot name="header" /><slot /></div>' },
  NSpin: { props: ['show', 'description'], template: '<div class="spin"><slot /></div>' },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

const fetchFilePreviewBlobMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/hermes/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/hermes/files')>()
  return {
    ...actual,
    fetchFilePreviewBlob: fetchFilePreviewBlobMock,
    getFileDownloadUrl: vi.fn((path: string) => `/download?path=${encodeURIComponent(path)}`),
    readFile: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    statFile: vi.fn(async () => ({ name: '', path: '', isDir: false, size: 0, modTime: '' })),
  }
})

import FilePreview from '@/components/hermes/files/FilePreview.vue'
import { useFilesStore } from '@/stores/hermes/files'

describe('FilePreview workspace diff mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fetchWorkspaceRunChangeFileMock.mockReset()
  })

  it('shows the file/diff toggle, defaults to diff, and fetches the patch', async () => {
    fetchWorkspaceRunChangeFileMock.mockResolvedValue({
      id: 7,
      change_id: 'change-1',
      session_id: 'session-1',
      path: 'src/app.ts',
      truncated: true,
      patch: '@@ -1 +1 @@\n-old\n+new',
    })
    const store = useFilesStore()
    store.previewFile = {
      path: 'src/app.ts',
      type: 'text',
      content: 'new',
      language: 'typescript',
      diff: { changeId: 'change-1', fileId: 7, sessionId: 'session-1', profile: 'travel' },
    }

    const wrapper = mount(FilePreview)
    await flushPromises()

    expect(wrapper.text()).toContain('files.previewFileTab')
    expect(wrapper.text()).toContain('files.previewDiffTab')
    expect(fetchWorkspaceRunChangeFileMock).toHaveBeenCalledWith('session-1', 'change-1', 7, 'travel')
    expect(wrapper.find('.preview-diff').exists()).toBe(true)
    expect(wrapper.find('.hljs-unified-diff').exists()).toBe(true)
    expect(wrapper.text()).toContain('files.diffPatchTruncated')
  })

  it('opens a changed office file on the document pane instead of its patch', async () => {
    // The patch of a ZIP part is unreadable, and the reason someone clicks a
    // changed report.xlsx is to see the report. The diff tab stays available.
    fetchFilePreviewBlobMock.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }))
    const store = useFilesStore()
    store.previewFile = {
      path: 'reports/metrics.xlsx',
      type: 'spreadsheet',
      diff: { changeId: 'change-1', fileId: 7, sessionId: 'session-1', profile: 'travel' },
    }

    const wrapper = mount(FilePreview)
    await flushPromises()

    expect(wrapper.text()).toContain('files.previewFileTab')
    expect(wrapper.text()).toContain('files.previewDiffTab')
    expect(wrapper.find('.preview-diff').exists()).toBe(false)
    expect(fetchWorkspaceRunChangeFileMock).not.toHaveBeenCalled()
    expect(fetchFilePreviewBlobMock).toHaveBeenCalledWith('reports/metrics.xlsx', expect.anything())
  })

  it('still lets the reader switch a changed office file to its patch', async () => {
    fetchFilePreviewBlobMock.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }))
    fetchWorkspaceRunChangeFileMock.mockResolvedValue({
      id: 7, change_id: 'change-1', session_id: 'session-1',
      path: 'reports/metrics.xlsx', truncated: false, patch: '@@ -1 +1 @@\n-a\n+b',
    })
    const store = useFilesStore()
    store.previewFile = {
      path: 'reports/metrics.xlsx',
      type: 'spreadsheet',
      diff: { changeId: 'change-1', fileId: 7, sessionId: 'session-1', profile: 'travel' },
    }

    const wrapper = mount(FilePreview)
    await flushPromises()
    const diffTab = wrapper.findAll('button').find(button => button.text().includes('files.previewDiffTab'))
    await diffTab!.trigger('click')
    await flushPromises()

    expect(fetchWorkspaceRunChangeFileMock).toHaveBeenCalledWith('session-1', 'change-1', 7, 'travel')
    expect(wrapper.find('.preview-diff').exists()).toBe(true)
  })

  it('keeps the existing preview without a diff toggle when no diff context exists', () => {
    const store = useFilesStore()
    store.previewFile = {
      path: 'src/app.ts',
      type: 'text',
      content: 'const value = 1',
      language: 'typescript',
    }

    const wrapper = mount(FilePreview)

    expect(wrapper.text()).not.toContain('files.previewFileTab')
    expect(wrapper.text()).not.toContain('files.previewDiffTab')
    expect(wrapper.find('.preview-code').exists()).toBe(true)
    expect(fetchWorkspaceRunChangeFileMock).not.toHaveBeenCalled()
  })

  it('shows its close action by default and lets an embedding tab workspace hide it', async () => {
    const store = useFilesStore()
    store.previewFile = {
      path: 'notes.txt',
      type: 'text',
      content: 'notes',
      language: 'plaintext',
    }

    const defaultWrapper = mount(FilePreview)
    expect(defaultWrapper.text()).toContain('files.closePreview')

    const embeddedWrapper = mount(FilePreview, { props: { showClose: false } })
    expect(embeddedWrapper.text()).not.toContain('files.closePreview')
  })
})
