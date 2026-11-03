// @vitest-environment jsdom
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listFilesMock = vi.hoisted(() => vi.fn())
const readFileMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => ({
      'files.browseWorkspace': 'Browse workspace',
      'files.openFile': 'Open file',
      'files.openArtifacts': 'Open artifacts',
      'files.closeArtifact': `Close ${params?.name || ''}`,
    }[key] || key),
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    emits: ['click'],
    setup(_, { attrs, emit, slots }) {
      return () => h('button', { ...attrs, type: 'button', onClick: () => emit('click') }, [
        slots.icon?.(),
        slots.default?.(),
      ])
    },
  }),
  NDropdown: defineComponent({
    name: 'NDropdown',
    props: {
      show: { type: Boolean, default: false },
      options: { type: Array, default: () => [] },
    },
    emits: ['select', 'clickoutside'],
    setup(props, { emit }) {
      return () => h('div', (props.options as Array<any>).map(option => h('button', {
        type: 'button',
        'data-key': option.key,
        onClick: () => emit('select', option.key),
      }, option.label ?? option.key)))
    },
  }),
  NSpin: { template: '<div><slot /></div>' },
  NEmpty: { template: '<div />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@/api/hermes/files', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/hermes/files')>(),
  listFiles: listFilesMock,
  readFile: readFileMock,
}))

vi.mock('@/api/hermes/download', () => ({ downloadFile: vi.fn() }))
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('@/components/hermes/files/FileTree.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/files/FileBreadcrumb.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/files/FileToolbar.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/files/FileUploadModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/files/FileRenameModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/files/FilePreview.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/files/FileEditor.vue', async () => {
  const { useFilesStore } = await import('@/stores/hermes/files')
  return {
    default: defineComponent({
      setup: () => ({ filesStore: useFilesStore() }),
      template: '<div data-testid="file-editor">{{ filesStore.editingFile?.path }}</div>',
    }),
  }
})
vi.mock('@/components/hermes/chat/ArtifactBrowser.vue', () => ({
  default: defineComponent({
    setup(_, { expose }) {
      expose({ load: vi.fn() })
      return () => h('div')
    },
  }),
}))

import DetailPanel from '@/components/hermes/chat/DetailPanel.vue'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useFilesStore } from '@/stores/hermes/files'

function session(id: string): Session {
  return { id, profile: 'default', title: id, createdAt: 1, updatedAt: 1, messages: [] }
}

describe('DetailPanel context-menu editor ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listFilesMock.mockReset().mockResolvedValue({
      entries: [{ name: 'notes.txt', path: 'notes.txt', isDir: false, size: 5, modTime: '' }],
    })
    readFileMock.mockReset().mockResolvedValue({ content: 'notes', path: 'notes.txt', size: 5 })
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-a'
    chatStore.activeSession = session('session-a')
  })

  it('keeps a right-click editor visible and owned by the active session', async () => {
    const wrapper = mount(DetailPanel)
    await wrapper.get('[aria-label="Browse workspace"]').trigger('click')
    await flushPromises()
    await nextTick()

    await wrapper.get('.file-list-row').trigger('contextmenu')
    await flushPromises()
    await wrapper.get('[data-key="edit"]').trigger('click')
    await flushPromises()

    expect(useFilesStore().editingFile).toMatchObject({ path: 'notes.txt', content: 'notes' })
    expect(wrapper.get('[data-testid="file-editor"]').text()).toBe('notes.txt')
  })
})
