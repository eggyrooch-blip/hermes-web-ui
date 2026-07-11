// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { FileEntry } from '@/api/hermes/files'

const mockMessage = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

const mockDialog = vi.hoisted(() => ({
  warning: vi.fn(),
}))

const downloadFileMock = vi.hoisted(() => vi.fn())
const copyToClipboardMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')

  return {
    NDropdown: defineComponent({
      name: 'NDropdown',
      props: {
        show: { type: Boolean, default: false },
        options: { type: Array, default: () => [] },
      },
      emits: ['select', 'clickoutside'],
      setup(props, { emit }) {
        return () => h('div', { 'data-show': props.show ? 'true' : 'false' },
          (props.options as Array<any>).map(option => h(
            'button',
            {
              type: 'button',
              'data-key': option.key,
              onClick: () => emit('select', option.key),
            },
            option.label ?? option.type ?? option.key,
          )),
        )
      },
    }),
    useMessage: () => mockMessage,
    useDialog: () => mockDialog,
  }
})

vi.mock('@/api/hermes/download', () => ({
  downloadFile: downloadFileMock,
}))

vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: copyToClipboardMock,
}))

vi.mock('@/utils/file-path', () => ({
  getClipboardPathForEntry: (entry: FileEntry) => entry.path,
}))

import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import { useFilesStore } from '@/stores/hermes/files'

describe('FileContextMenu', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  async function showMenu(wrapper: ReturnType<typeof mount>, entry: FileEntry) {
    ;(wrapper.vm as any).show(new MouseEvent('contextmenu', { clientX: 12, clientY: 34 }), entry)
    await flushPromises()
  }

  it('offers both edit and preview for previewable text files', async () => {
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'Dockerfile',
      path: 'Dockerfile',
      isDir: false,
      size: 42,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)

    const keys = wrapper.findAll('[data-key]').map(node => node.attributes('data-key'))
    expect(keys).toContain('edit')
    expect(keys).toContain('preview')
    expect(keys).toContain('download')
  })

  it('hides and guards edit when the embedding scope disables it', async () => {
    const store = useFilesStore()
    const openEditorSpy = vi.spyOn(store, 'openEditor').mockResolvedValue(true)
    const wrapper = mount(FileContextMenu, { props: { allowEdit: false } })
    const entry: FileEntry = {
      name: 'README',
      path: 'README',
      isDir: false,
      size: 12,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)
    expect(wrapper.find('[data-key="edit"]').exists()).toBe(false)

    wrapper.findComponent({ name: 'NDropdown' }).vm.$emit('select', 'edit')
    await flushPromises()
    expect(openEditorSpy).not.toHaveBeenCalled()
  })

  it('announces editor ownership before opening from the context menu', async () => {
    const store = useFilesStore()
    const openEditorSpy = vi.spyOn(store, 'openEditor').mockResolvedValue(true)
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'README',
      path: 'README',
      isDir: false,
      size: 12,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)
    await wrapper.get('[data-key="edit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('editor-opened')).toHaveLength(1)
    expect(openEditorSpy).toHaveBeenCalledWith('README')
  })

  it('wires FilesPanel editor scope into both edit entry points', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/FilesPanel.vue', 'utf8')

    expect(source).toContain('<FileContextMenu')
    expect(source.match(/:allow-edit="editorScopeActive"/g)).toHaveLength(2)
    expect(source.match(/@editor-opened="handleEditorOpened"/g)).toHaveLength(2)
  })

  it('does not announce ownership when the editor load fails', async () => {
    const store = useFilesStore()
    vi.spyOn(store, 'openEditor').mockRejectedValue(new Error('failed'))
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'README', path: 'README', isDir: false, size: 1, modTime: '',
    }

    await showMenu(wrapper, entry)
    await wrapper.get('[data-key="edit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('editor-opened')).toBeUndefined()
    expect(mockMessage.error).toHaveBeenCalled()
  })

  it('invokes the store preview action from the preview menu item', async () => {
    const store = useFilesStore()
    const openPreviewSpy = vi.spyOn(store, 'openPreview').mockResolvedValue(undefined)
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'README',
      path: 'README',
      isDir: false,
      size: 12,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)
    await wrapper.get('[data-key="preview"]').trigger('click')
    await flushPromises()

    expect(openPreviewSpy).toHaveBeenCalledWith(entry)
    expect(mockMessage.error).not.toHaveBeenCalled()
  })

  it('does not offer preview for non-previewable binary files', async () => {
    const wrapper = mount(FileContextMenu)
    const entry: FileEntry = {
      name: 'archive.zip',
      path: 'archive.zip',
      isDir: false,
      size: 128,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await showMenu(wrapper, entry)

    const keys = wrapper.findAll('[data-key]').map(node => node.attributes('data-key'))
    expect(keys).not.toContain('preview')
    expect(keys).not.toContain('edit')
    expect(keys).toContain('download')
  })
})
