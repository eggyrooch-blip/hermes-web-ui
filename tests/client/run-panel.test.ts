// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

const mockChatStore = vi.hoisted(() => ({
  sessionArtifacts: [] as { name: string; path: string }[],
}))
const mockSettingsStore = vi.hoisted(() => ({ memory: {} as Record<string, unknown> }))
const mockDownloadFile = vi.hoisted(() => vi.fn())
const mockFilesStore = vi.hoisted(() => ({
  requestBrowserArtifact: vi.fn(),
  previewByDisplayPath: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}))

vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => mockChatStore }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => mockSettingsStore }))
vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (path: string) => `/download?path=${path}`,
  downloadFile: mockDownloadFile,
}))
vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => mockFilesStore,
  isHtmlFile: (name: string) => /\.html?$/i.test(name),
}))

const RunPanel = (await import('@/components/hermes/chat/RunPanel.vue')).default

function toolMessage(id: string, name: string, status: 'running' | 'done' | 'error') {
  return { id, role: 'tool', content: '', timestamp: 0, toolName: name, toolStatus: status }
}

describe('RunPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStore.sessionArtifacts = []
    mockSettingsStore.memory = reactive({})
  })

  it('builds the progress rail out of the run\'s actual tool calls', () => {
    const wrapper = mount(RunPanel, {
      props: {
        messages: [
          toolMessage('1', 'read_file', 'done'),
          toolMessage('2', 'run_command', 'done'),
          toolMessage('3', 'write_file', 'running'),
        ] as never,
        running: true,
      },
    })

    expect(wrapper.findAll('.run-rail__dot')).toHaveLength(3)
    expect(wrapper.findAll('.run-rail__dot.is-done')).toHaveLength(2)
    expect(wrapper.findAll('.run-rail__dot.is-running')).toHaveLength(1)
    expect(wrapper.text()).toContain('chat.runPanel.stepCount:2,3')
  })

  it('names the step it stopped on when a tool errored', () => {
    const wrapper = mount(RunPanel, {
      props: {
        messages: [toolMessage('1', 'read_file', 'done'), toolMessage('2', 'run_command', 'error')] as never,
        aborted: true,
      },
    })

    expect(wrapper.find('.run-rail__dot.is-error').exists()).toBe(true)
    expect(wrapper.text()).toContain('chat.runPanel.stoppedAt:run_command')
    expect(wrapper.text()).toContain('chat.runPanel.interrupted')
  })

  it('says a task ran no tools rather than showing an empty rail', () => {
    const wrapper = mount(RunPanel, {
      props: { messages: [{ id: '1', role: 'assistant', content: 'hi', timestamp: 0 }] as never },
    })

    expect(wrapper.findAll('.run-rail__dot')).toHaveLength(0)
    expect(wrapper.text()).toContain('chat.runPanel.noSteps')
  })

  it('lists produced files with a download target, and distinguishes pending from none', async () => {
    mockChatStore.sessionArtifacts = [{ name: 'report.docx', path: '/workspace/report.docx' }]
    const wrapper = mount(RunPanel, { props: { messages: [] as never } })

    // The row itself opens the artifact; the trailing icon is the download.
    const row = wrapper.get('.run-rows .run-row')
    expect(row.text()).toContain('report.docx')
    expect(row.get('.run-row__open').element.tagName).toBe('BUTTON')
    expect(row.get('.run-row__action').attributes('href')).toBe('/download?path=/workspace/report.docx')

    mockChatStore.sessionArtifacts = []
    const idle = mount(RunPanel, { props: { messages: [] as never } })
    expect(idle.text()).toContain('chat.runPanel.outputsNone')

    const busy = mount(RunPanel, { props: { messages: [] as never, running: true } })
    expect(busy.text()).toContain('chat.runPanel.outputsPending')
  })

  // The whole row used to be one `<a download>`, so clicking the name
  // downloaded instead of opening — the opposite of the message file card.
  it('opens an HTML artifact in the embedded browser on click, and never downloads it', async () => {
    mockChatStore.sessionArtifacts = [{ name: 'index.html', path: '/workspace/index.html' }]
    const wrapper = mount(RunPanel, { props: { messages: [] as never } })

    await wrapper.get('.run-rows .run-row .run-row__open').trigger('click')

    expect(mockFilesStore.requestBrowserArtifact).toHaveBeenCalledWith('index.html', '/workspace/index.html')
    expect(mockDownloadFile).not.toHaveBeenCalled()
  })

  it('previews a non-HTML previewable artifact rather than downloading it', async () => {
    mockChatStore.sessionArtifacts = [{ name: 'notes.md', path: '/workspace/notes.md' }]
    const wrapper = mount(RunPanel, { props: { messages: [] as never } })

    await wrapper.get('.run-rows .run-row .run-row__open').trigger('click')

    expect(mockFilesStore.previewByDisplayPath).toHaveBeenCalledWith('/workspace/notes.md', 'notes.md')
    expect(mockDownloadFile).not.toHaveBeenCalled()
  })

  // Nothing can render a .docx, so clicking it still has to do something.
  it('falls back to downloading an artifact it cannot render', async () => {
    mockChatStore.sessionArtifacts = [{ name: 'report.docx', path: '/workspace/report.docx' }]
    const wrapper = mount(RunPanel, { props: { messages: [] as never } })

    await wrapper.get('.run-rows .run-row .run-row__open').trigger('click')

    expect(mockDownloadFile).toHaveBeenCalledWith('/workspace/report.docx', 'report.docx')
    expect(mockFilesStore.requestBrowserArtifact).not.toHaveBeenCalled()
  })

  it('counts context as sources + capabilities + memory, and dedupes both', () => {
    mockSettingsStore.memory.memory_enabled = true
    const wrapper = mount(RunPanel, {
      props: {
        messages: [
          {
            id: '1',
            role: 'user',
            content: '',
            timestamp: 0,
            attachments: [
              { id: 'a', name: 'q3.xlsx', type: '', size: 0, url: '/f/q3' },
              { id: 'b', name: 'q3.xlsx', type: '', size: 0, url: '/f/q3' },
            ],
          },
          toolMessage('2', 'read_file', 'done'),
          toolMessage('3', 'read_file', 'done'),
        ] as never,
      },
    })

    // 1 source + 1 capability + memory
    expect(wrapper.text()).toContain('chat.runPanel.contextCount:3')
    expect(wrapper.findAll('.run-cap')).toHaveLength(1)
    expect(wrapper.text()).toContain('chat.runPanel.memoryOn')
  })

  it('jumps to the message carrying the reasoning', async () => {
    const wrapper = mount(RunPanel, {
      props: {
        messages: [
          toolMessage('1', 'read_file', 'done'),
          { id: '9', role: 'assistant', content: 'x', timestamp: 0, reasoning: 'because' },
        ] as never,
      },
    })

    await wrapper.get('.run-progress__reason').trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['9']])
  })
})
