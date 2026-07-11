// @vitest-environment jsdom
import { defineComponent, nextTick, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFileMock = vi.hoisted(() => vi.fn())
const filesPanelMountMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => ({
      'files.browseWorkspace': 'Browse workspace',
      'files.openFile': 'Open file',
      'files.openArtifacts': 'Open artifacts',
      'files.closeArtifact': `Close ${params?.name || ''}`,
      'common.collapse': 'Collapse',
    }[key] || key),
  }),
}))

vi.mock('@/api/hermes/files', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/hermes/files')>(),
  readFile: readFileMock,
}))

vi.mock('@/components/hermes/chat/FilesPanel.vue', async () => {
  const { defineComponent, onMounted } = await import('vue')
  const { useFilesStore } = await import('@/stores/hermes/files')
  return {
    default: defineComponent({
      name: 'FilesPanel',
      props: {
        editorScopeActive: { type: Boolean, default: true },
        editorScope: { type: String, default: 'files-view:__default__' },
      },
      emits: ['editor-opened'],
      setup(_, { emit }) {
        const filesStore = useFilesStore()
        onMounted(() => filesPanelMountMock())
        const openPreview = () => {
          filesStore.previewFile = {
            path: 'picked/from-files.md',
            type: 'markdown',
            content: '# picked',
          }
        }
        const openEditor = () => {
          filesStore.editingFile = {
            path: 'draft-a.txt',
            content: 'dirty A',
            originalContent: 'clean A',
            language: 'plaintext',
            ownerScope: _.editorScope,
          }
          emit('editor-opened')
        }
        return { filesStore, openPreview, openEditor }
      },
      template: '<div data-testid="files-panel" :data-editor-scope-active="String(editorScopeActive)"><span v-if="editorScopeActive && filesStore.editingFile" data-testid="scoped-editor">{{ filesStore.editingFile.path }}:{{ filesStore.editingFile.content }}</span><button v-if="editorScopeActive" data-testid="files-panel-open-editor" @click="openEditor">open editor</button><button data-testid="files-panel-open-preview" @click="openPreview">open preview</button></div>',
    }),
  }
})

vi.mock('@/components/hermes/files/FilePreview.vue', async () => {
  const { defineComponent } = await import('vue')
  const { useFilesStore } = await import('@/stores/hermes/files')
  return {
    default: defineComponent({
      name: 'FilePreview',
      props: { showClose: { type: Boolean, default: true } },
      setup() {
        return { filesStore: useFilesStore() }
      },
      template: '<div data-testid="file-preview" :data-show-close="String(showClose)">{{ filesStore.previewFile?.path }}</div>',
    }),
  }
})

vi.mock('@/components/hermes/chat/ArtifactBrowser.vue', async () => {
  const { defineComponent, ref } = await import('vue')
  return {
    default: defineComponent({
      name: 'ArtifactBrowser',
      setup(_, { expose }) {
        const history = ref<string[]>([])
        expose({
          load: (artifact: { path: string }) => {
            if (history.value.at(-1) !== artifact.path) history.value.push(artifact.path)
          },
        })
        return { history }
      },
      template: '<div data-testid="artifact-browser">{{ history.join("|") }}</div>',
    }),
  }
})

import DetailPanel from '@/components/hermes/chat/DetailPanel.vue'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useFilesStore } from '@/stores/hermes/files'
import { useProfilesStore } from '@/stores/hermes/profiles'

const mountOptions = {}

function session(id: string, artifact?: string, profile = 'default'): Session {
  return {
    id,
    profile,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: artifact
      ? [{ id: `${id}-message`, role: 'assistant', timestamp: 1, content: `MEDIA:/workspace/${artifact}` }]
      : [],
  }
}

async function activate(
  id: string,
  artifact?: string,
  profile = 'default',
  runtimeMode: 'default' | 'global_agent' = 'default',
) {
  const store = useChatStore()
  store.runtimeMode = runtimeMode
  store.activeSessionId = id
  store.activeSession = session(id, artifact, profile)
  await nextTick()
  await nextTick()
}

async function activateNew(runtimeMode: 'default' | 'global_agent' = 'default') {
  const store = useChatStore()
  store.runtimeMode = runtimeMode
  store.activeSessionId = null
  store.activeSession = null
  await nextTick()
  await nextTick()
}

function lastBrowserPath(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-testid="artifact-browser"]').text().split('|').at(-1)
}

function tabs(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.detail-tab')
}

function activeTab(wrapper: ReturnType<typeof mount>) {
  return tabs(wrapper).find(tab => tab.attributes('aria-selected') === 'true')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('DetailPanel session workspace', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    readFileMock.mockReset()
    filesPanelMountMock.mockReset()
    readFileMock.mockImplementation(async (path: string) => ({
      content: `content:${path}`,
      path,
      size: path.length,
    }))
  })

  it('opens on overview when the session has no remembered artifact', async () => {
    await activate('session-a')

    const wrapper = mount(DetailPanel, mountOptions)

    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)
    expect(tabs(wrapper)).toHaveLength(0)
    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(false)
    expect(wrapper.find('.detail-mode-trigger').exists()).toBe(false)
    expect(wrapper.find('.detail-empty').text()).toContain('files.noArtifacts')
  })

  it('offers an explicit panel close action without discarding workspace state', async () => {
    await activate('session-a', 'a.txt')
    const dismissPanel = vi.fn()
    const wrapper = mount(DetailPanel, { props: { dismissPanel } })
    const filesStore = useFilesStore()
    filesStore.previewFile = {
      path: '/workspace/a.txt',
      type: 'text',
      content: 'hello',
    }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    const close = wrapper.find('.detail-panel-dismiss')
    expect(close.exists()).toBe(true)
    expect(close.attributes('aria-label')).toBe('Collapse')

    await close.trigger('click')

    expect(dismissPanel).toHaveBeenCalledTimes(1)
    expect(tabs(wrapper)).toHaveLength(1)
    expect(activeTab(wrapper)?.text()).toContain('a.txt')
  })

  it('adds and selects a tab when a chat artifact is requested', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)

    useFilesStore().requestBrowserArtifact('report.html', '/workspace/report.html')
    await nextTick()

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    expect(tabs(wrapper)).toHaveLength(1)
    expect(tabs(wrapper)[0].attributes('role')).toBe('tab')
    expect(activeTab(wrapper)?.text()).toContain('report.html')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/report.html')
  })

  it('deduplicates encoded and unencoded forms of the same workspace path', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()

    filesStore.requestBrowserArtifact('My File.html', '/workspace/reports/My%20File.html')
    await nextTick()
    filesStore.requestBrowserArtifact('My File.html', 'workspace/reports/My File.html')
    await nextTick()

    expect(tabs(wrapper)).toHaveLength(1)
    expect(activeTab(wrapper)?.text()).toContain('My File.html')
  })

  it('deduplicates repeated separators and dot segments in workspace tab keys', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()

    filesStore.requestBrowserArtifact('My File.html', '/workspace/reports//./draft/../My%20File.html')
    await nextTick()
    filesStore.requestBrowserArtifact('My File.html', 'workspace/reports/My File.html')
    await nextTick()

    expect(tabs(wrapper)).toHaveLength(1)
  })

  it('switches between two open artifact tabs', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()

    filesStore.requestBrowserArtifact('a.html', '/workspace/a.html')
    await nextTick()
    filesStore.requestBrowserArtifact('b.html', '/workspace/b.html')
    await nextTick()
    expect(activeTab(wrapper)?.text()).toContain('b.html')

    await tabs(wrapper)[0].trigger('click')

    expect(activeTab(wrapper)?.text()).toContain('a.html')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/a.html')
  })

  it('provides roving tab focus, keyboard navigation, and a labelled tabpanel', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, { attachTo: document.body })
    const filesStore = useFilesStore()
    filesStore.requestBrowserArtifact('a.html', '/workspace/a.html')
    await nextTick()
    filesStore.requestBrowserArtifact('b.html', '/workspace/b.html')
    await nextTick()

    expect(wrapper.find('[role="tablist"]').attributes('aria-label')).toBe('Open artifacts')
    expect(tabs(wrapper)[0].attributes('tabindex')).toBe('-1')
    expect(tabs(wrapper)[1].attributes('tabindex')).toBe('0')
    const panelId = tabs(wrapper)[1].attributes('aria-controls')
    const panel = wrapper.find(`#${panelId}`)
    expect(panel.attributes('role')).toBe('tabpanel')
    expect(panel.attributes('aria-labelledby')).toBe(tabs(wrapper)[1].attributes('id'))

    await tabs(wrapper)[1].trigger('keydown', { key: 'ArrowLeft' })
    await nextTick()
    expect(activeTab(wrapper)?.text()).toContain('a.html')
    expect(tabs(wrapper)[0].attributes('tabindex')).toBe('0')
    expect(document.activeElement).toBe(tabs(wrapper)[0].element)

    await tabs(wrapper)[0].trigger('keydown', { key: 'End' })
    await nextTick()
    expect(activeTab(wrapper)?.text()).toContain('b.html')
    expect(document.activeElement).toBe(tabs(wrapper)[1].element)
    wrapper.unmount()
  })

  it('selects the adjacent tab after closing the active tab', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, { attachTo: document.body })
    const filesStore = useFilesStore()
    filesStore.requestBrowserArtifact('a.html', '/workspace/a.html')
    await nextTick()
    filesStore.requestBrowserArtifact('b.html', '/workspace/b.html')
    await nextTick()

    await wrapper.find('[aria-label="Close b.html"]').trigger('click')

    expect(tabs(wrapper)).toHaveLength(1)
    expect(activeTab(wrapper)?.text()).toContain('a.html')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/a.html')
    expect(document.activeElement).toBe(activeTab(wrapper)?.element)
    wrapper.unmount()
  })

  it('returns focus to the selected tab after closing a different tab', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, { attachTo: document.body })
    const filesStore = useFilesStore()
    filesStore.requestBrowserArtifact('a.html', '/workspace/a.html')
    await nextTick()
    filesStore.requestBrowserArtifact('b.html', '/workspace/b.html')
    await nextTick()

    const closeInactive = wrapper.get('[aria-label="Close a.html"]')
    closeInactive.element.focus()
    expect(document.activeElement).toBe(closeInactive.element)
    await closeInactive.trigger('click')
    await nextTick()

    expect(activeTab(wrapper)?.text()).toContain('b.html')
    expect(document.activeElement).toBe(activeTab(wrapper)?.element)
    wrapper.unmount()
  })

  it('returns to overview after closing the final tab', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    useFilesStore().requestBrowserArtifact('a.html', '/workspace/a.html')
    await nextTick()

    await wrapper.find('[aria-label="Close a.html"]').trigger('click')

    expect(tabs(wrapper)).toHaveLength(0)
    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)
  })

  it('opens the secondary file browser from both fixed header controls', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()
    filesStore.editingFile = {
      path: 'draft.txt',
      content: 'dirty',
      originalContent: 'clean',
      language: 'plaintext',
      ownerScope: 'external',
    }

    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(true)
    expect(filesStore.editingFile?.content).toBe('dirty')

    await wrapper.find('[aria-label="Open file"]').trigger('click')
    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(true)
    expect(filesStore.editingFile?.content).toBe('dirty')
  })

  it('hides a session A editor from session B without discarding the unsaved buffer', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()
    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    await wrapper.find('[data-testid="files-panel-open-editor"]').trigger('click')
    expect(wrapper.find('[data-testid="scoped-editor"]').text()).toContain('dirty A')

    await activate('session-b')
    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')

    expect(wrapper.find('[data-testid="files-panel"]').attributes('data-editor-scope-active')).toBe('false')
    expect(wrapper.find('[data-testid="scoped-editor"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="files-panel-open-editor"]').exists()).toBe(false)
    expect(filesStore.editingFile).toMatchObject({ path: 'draft-a.txt', content: 'dirty A' })

    await activate('session-a')
    expect(wrapper.find('[data-testid="files-panel"]').attributes('data-editor-scope-active')).toBe('true')
    expect(wrapper.find('[data-testid="scoped-editor"]').text()).toContain('draft-a.txt:dirty A')
  })

  it('upserts and selects a tab when FilesPanel opens a preview directly', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')

    await wrapper.find('[data-testid="files-panel-open-preview"]').trigger('click')
    await nextTick()

    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(false)
    expect(activeTab(wrapper)?.text()).toContain('from-files.md')
    expect(wrapper.find('[data-testid="file-preview"]').text()).toContain('picked/from-files.md')
    expect(wrapper.find('[data-testid="file-preview"]').attributes('data-show-close')).toBe('false')
  })

  it('keeps the selected artifact when the parent hides and shows it', async () => {
    await activate('session-a', 'a.html')
    const Host = defineComponent({
      components: { DetailPanel },
      setup() {
        const visible = ref(true)
        return { visible }
      },
      template: '<DetailPanel v-show="visible" />',
    })
    const wrapper = mount(Host, mountOptions)

    await wrapper.find('.detail-artifact-card').trigger('click')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/a.html')
    expect(activeTab(wrapper)?.text()).toContain('a.html')

    wrapper.vm.visible = false
    await nextTick()
    wrapper.vm.visible = true
    await nextTick()

    expect(lastBrowserPath(wrapper)).toBe('/workspace/a.html')
    expect(wrapper.find('[data-testid="artifact-browser"]').isVisible()).toBe(true)
  })

  it('restores the selected artifact independently for each active session', async () => {
    await activate('session-a', 'a.html')
    const wrapper = mount(DetailPanel, mountOptions)

    await wrapper.find('.detail-artifact-card').trigger('click')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/a.html')

    await activate('session-b', 'b.html')
    await wrapper.find('.detail-artifact-card').trigger('click')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/b.html')

    await activate('session-a', 'a.html')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/a.html')

    await activate('session-b', 'b.html')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/b.html')
  })

  it('rehydrates an ordinary file preview when returning to its session', async () => {
    await activate('session-a')
    mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()

    filesStore.previewFile = { path: 'a.txt', type: 'text', content: 'A', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    await activate('session-b')
    filesStore.previewFile = { path: 'b.txt', type: 'text', content: 'B', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    await activate('session-a')
    await flushPromises()

    expect(filesStore.previewFile?.path).toBe('a.txt')
    expect(filesStore.previewFile?.content).toBe('content:a.txt')
  })

  it('keeps diff metadata when restoring a diff preview', async () => {
    await activate('session-a')
    mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()

    filesStore.previewFile = {
      path: 'a.txt',
      type: 'text',
      content: 'A',
      language: 'plaintext',
      diff: { changeId: 'change-a', fileId: 1, sessionId: 'session-a' },
    }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    await activate('session-b')
    filesStore.previewFile = { path: 'b.txt', type: 'text', content: 'B', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    await activate('session-a')
    await flushPromises()

    expect(filesStore.previewFile?.path).toBe('a.txt')
    expect(filesStore.previewFile?.diff).toEqual({
      changeId: 'change-a',
      fileId: 1,
      sessionId: 'session-a',
    })
  })

  it('clears a stale preview when entering a new empty session', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()
    filesStore.previewFile = { path: 'a.txt', type: 'text', content: 'A', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    await activateNew()

    expect(filesStore.previewFile).toBeNull()
    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)
    expect(tabs(wrapper)).toHaveLength(0)
  })

  it('scopes remembered artifacts by profile and runtime mode', async () => {
    await activate('shared-id', 'profile-a.html', 'profile-a')
    const wrapper = mount(DetailPanel, mountOptions)
    await wrapper.find('.detail-artifact-card').trigger('click')

    await activate('shared-id', 'profile-b.html', 'profile-b')
    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)
    await wrapper.find('.detail-artifact-card').trigger('click')

    await activate('shared-id', 'global.html', 'profile-b', 'global_agent')
    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)
    await wrapper.find('.detail-artifact-card').trigger('click')

    await activate('shared-id', 'profile-b.html', 'profile-b')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/profile-b.html')

    await activate('shared-id', 'profile-a.html', 'profile-a')
    expect(lastBrowserPath(wrapper)).toBe('/workspace/profile-a.html')
  })

  it('uses an isolated browser instance for each session workspace', async () => {
    await activate('session-a', 'a.html')
    const wrapper = mount(DetailPanel, mountOptions)
    await wrapper.find('.detail-artifact-card').trigger('click')
    expect(wrapper.find('[data-testid="artifact-browser"]').text()).toBe('/workspace/a.html')

    await activate('session-b', 'b.html')
    await wrapper.find('.detail-artifact-card').trigger('click')
    expect(wrapper.find('[data-testid="artifact-browser"]').text()).toBe('/workspace/b.html')

    await activate('session-a', 'a.html')
    expect(wrapper.find('[data-testid="artifact-browser"]').text()).toBe('/workspace/a.html')
  })

  it('lazy-mounts FilesPanel only as the secondary browser and remounts it after a profile change', async () => {
    await activate('shared-id', undefined, 'profile-a')
    const wrapper = mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()
    expect(filesPanelMountMock).not.toHaveBeenCalled()

    filesStore.previewFile = { path: 'a.txt', type: 'text', content: 'A', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()
    expect(filesPanelMountMock).not.toHaveBeenCalled()

    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(1)

    await activate('shared-id', undefined, 'profile-b')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(1)

    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(2)

    await activate('shared-id', undefined, 'profile-a')
    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(true)
    expect(filesPanelMountMock).toHaveBeenCalledTimes(3)
  })

  it('remounts FilesPanel when switching between same-profile sessions that both browse files', async () => {
    await activate('session-a')
    const wrapper = mount(DetailPanel, mountOptions)
    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(1)

    await activate('session-b')
    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(2)

    await activate('session-a')
    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(true)
    expect(filesPanelMountMock).toHaveBeenCalledTimes(3)
  })

  it('ignores a slow preview restore after switching to another session', async () => {
    await activate('session-a')
    mount(DetailPanel, mountOptions)
    const filesStore = useFilesStore()
    filesStore.previewFile = { path: 'a.txt', type: 'text', content: 'A', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    await activate('session-b')
    filesStore.previewFile = { path: 'b.txt', type: 'text', content: 'B', language: 'plaintext' }
    filesStore.previewPanelRequestedAt += 1
    await nextTick()

    const slowA = deferred<{ content: string, path: string, size: number }>()
    readFileMock.mockImplementation((path: string) => (
      path === 'a.txt'
        ? slowA.promise
        : Promise.resolve({ content: `content:${path}`, path, size: path.length })
    ))

    await activate('session-a')
    await activate('session-b')
    await flushPromises()
    expect(filesStore.previewFile?.path).toBe('b.txt')

    slowA.resolve({ content: 'late A', path: 'a.txt', size: 6 })
    await flushPromises()
    expect(filesStore.previewFile?.path).toBe('b.txt')
    expect(filesStore.previewFile?.content).toBe('content:b.txt')
  })

  it('mounts at preview request start so a session switch cancels the pending file', async () => {
    await activate('session-a')
    const slowA = deferred<{ content: string, path: string, size: number }>()
    readFileMock.mockReturnValue(slowA.promise)
    const Host = defineComponent({
      components: { DetailPanel },
      setup() {
        const filesStore = useFilesStore()
        const mounted = ref(false)
        watch(() => filesStore.previewPanelRequestedAt, () => { mounted.value = true })
        return { mounted }
      },
      template: '<DetailPanel v-if="mounted" />',
    })
    const wrapper = mount(Host, mountOptions)
    const filesStore = useFilesStore()

    const request = filesStore.previewByDisplayPath('/workspace/a.txt', 'a.txt')
    await nextTick()
    expect(wrapper.find('.detail-panel').exists()).toBe(true)

    await activate('session-b')
    slowA.resolve({ content: 'late A', path: 'a.txt', size: 6 })
    await request
    await flushPromises()

    expect(filesStore.previewFile).toBeNull()
    expect(tabs(wrapper)).toHaveLength(0)
    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)
  })

  it('scopes a new empty workspace by the active profile', async () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'profile-a'
    await activateNew()
    const wrapper = mount(DetailPanel, mountOptions)
    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(1)

    profilesStore.activeProfileName = 'profile-b'
    await nextTick()
    await nextTick()
    expect(wrapper.find('.detail-overview').isVisible()).toBe(true)

    await wrapper.find('[aria-label="Browse workspace"]').trigger('click')
    expect(filesPanelMountMock).toHaveBeenCalledTimes(2)

    profilesStore.activeProfileName = 'profile-a'
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="files-panel"]').exists()).toBe(true)
    expect(filesPanelMountMock).toHaveBeenCalledTimes(3)
  })
})
