// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// Proves the in-chat artifact flow's client half: the server rewrites a produced
// file's MEDIA: line into a markdown link `[name](/workspace/rel)` (covered by
// tests/server/media-directives.test.ts); this test proves that such a link
// (a) renders as a clickable file card, and (b) clicking it routes to the files
// store's previewByDisplayPath (which opens the panel + renders — verified live).

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }
})

const downloadFile = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/api/hermes/download', () => ({
  downloadFile,
  getDownloadUrl: vi.fn((path: string) => `/download?path=${encodeURIComponent(path)}`),
  fetchFileText: vi.fn(),
}))

const previewByDisplayPath = vi.fn()
const requestBrowserArtifact = vi.fn()
vi.mock('@/stores/hermes/files', () => ({
  isHtmlFile: (name: string) => /\.html?$/i.test(name),
  useFilesStore: () => ({ previewByDisplayPath, requestBrowserArtifact }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

describe('MarkdownRenderer workspace artifact file card', () => {
  it('renders an inline absolute workspace path as a display-path file card', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Open `/Users/kite/.hermes/profiles/sunke/workspace/reports/report.html` now.',
      },
    })

    const card = wrapper.find('.markdown-file-card')
    expect(card.exists()).toBe(true)
    expect(card.attributes('data-path')).toBe('/workspace/reports/report.html')
    expect(card.attributes('data-filename')).toBe('report.html')
    expect(wrapper.text()).not.toContain('/Users/kite/.hermes')
  })

  it('renders an inline /workspace/ display path as a file card and escapes attributes', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Open `/workspace/reports/a"b.txt` now.',
      },
    })

    const card = wrapper.find('.markdown-file-card')
    expect(card.exists()).toBe(true)
    expect(card.attributes('data-path')).toBe('/workspace/reports/a"b.txt')
    expect(card.attributes('data-filename')).toBe('a"b.txt')
  })

  it('routes an inline previewable /workspace/ path through previewByDisplayPath', async () => {
    previewByDisplayPath.mockClear()
    requestBrowserArtifact.mockClear()
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Open `/workspace/reports/notes.md` now.',
      },
    })

    await wrapper.find('.markdown-file-card').trigger('click')

    expect(previewByDisplayPath).toHaveBeenCalledWith('/workspace/reports/notes.md', 'notes.md')
    expect(requestBrowserArtifact).not.toHaveBeenCalled()
  })

  it.each(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])(
    'routes a workspace .%s image card through the existing file preview',
    async (extension) => {
      previewByDisplayPath.mockClear()
      downloadFile.mockClear()
      const fileName = `preview.${extension}`
      const wrapper = mount(MarkdownRenderer, {
        props: { content: `[${fileName}](/workspace/${fileName})` },
      })

      await wrapper.find('.markdown-file-card').trigger('click')

      expect(previewByDisplayPath).toHaveBeenCalledWith(`/workspace/${fileName}`, fileName)
      expect(downloadFile).not.toHaveBeenCalled()
    },
  )

  it('downloads an inline non-previewable /workspace/ file card', async () => {
    downloadFile.mockClear()
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Open `/workspace/reports/archive.zip` now.',
      },
    })

    await wrapper.find('.markdown-file-card').trigger('click')

    expect(downloadFile).toHaveBeenCalledWith('/workspace/reports/archive.zip', 'archive.zip')
  })

  it('does not render fenced workspace paths or URLs as file cards', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```',
          '/workspace/reports/report.html',
          '```',
          '`https://example.com/report.html`',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('does not render directory-like or extensionless inline workspace paths as file cards', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '`/workspace/reports/` `/workspace/reports/README`',
      },
    })

    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('renders a unique workspace diff basename as a file card with addition and deletion counts', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Updated **app.ts**.',
        workspaceDiffFiles: [{
          id: 7,
          path: 'src/app.ts',
          change_id: 'change-1',
          session_id: 'session-1',
          additions: 3,
          deletions: 2,
        }],
      },
    })

    const card = wrapper.find('.markdown-file-card')
    expect(card.exists()).toBe(true)
    expect(card.attributes('data-path')).toBe('/workspace/src/app.ts')
    expect(card.attributes('data-filename')).toBe('app.ts')
    expect(wrapper.find('.markdown-file-diff-btn').text()).toContain('+3')
    expect(wrapper.find('.markdown-file-diff-btn').text()).toContain('−2')
  })

  it('renders zeroes instead of non-finite diff counts', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Updated **app.ts**.',
        workspaceDiffFiles: [{
          id: 7,
          path: 'src/app.ts',
          change_id: 'change-1',
          session_id: 'session-1',
          additions: Number.NaN,
          deletions: Number.POSITIVE_INFINITY,
        }],
      },
    })

    expect(wrapper.find('.markdown-file-diff-btn').text()).toContain('+0')
    expect(wrapper.find('.markdown-file-diff-btn').text()).toContain('−0')
  })

  it('appends unmatched workspace diff files in one fallback chip row', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Updated the generated output.',
        workspaceDiffFiles: [{
          id: 7,
          path: 'src/app.ts',
          change_id: 'change-1',
          session_id: 'session-1',
          additions: 3,
          deletions: 2,
        }],
      },
    })

    const fallback = wrapper.find('.markdown-diff-fallback-row')
    expect(fallback.exists()).toBe(true)
    expect(fallback.find('.markdown-file-card').attributes('data-path')).toBe('/workspace/src/app.ts')
    expect(fallback.find('.markdown-file-diff-btn').text()).toContain('+3')
  })

  it('does not duplicate an inline-matched diff file in the fallback row', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Updated **app.ts**.',
        workspaceDiffFiles: [{
          id: 7,
          path: 'src/app.ts',
          change_id: 'change-1',
          session_id: 'session-1',
        }],
      },
    })

    expect(wrapper.findAll('.markdown-file-card')).toHaveLength(1)
    expect(wrapper.find('.markdown-diff-fallback-row').exists()).toBe(false)
  })

  it('emits the workspace diff file when the chip body is clicked', async () => {
    previewByDisplayPath.mockClear()
    const diffFile = {
      id: 7,
      path: 'src/app.ts',
      change_id: 'change-1',
      session_id: 'session-1',
      additions: 3,
      deletions: 2,
    }
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Updated **app.ts**.',
        workspaceDiffFiles: [diffFile],
      },
    })

    await wrapper.find('.markdown-file-card').trigger('click')

    expect(wrapper.emitted('workspace-diff-file-click')).toEqual([[diffFile]])
    expect(previewByDisplayPath).not.toHaveBeenCalled()
  })

  it('renders ambiguous workspace diff basenames only in the fallback row', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Updated app.ts.',
        workspaceDiffFiles: [
          { id: 7, path: 'src/app.ts', change_id: 'change-1', session_id: 'session-1' },
          { id: 8, path: 'tests/app.ts', change_id: 'change-1', session_id: 'session-1' },
        ],
      },
    })

    expect(wrapper.find('.markdown-diff-fallback-row').exists()).toBe(true)
    expect(wrapper.findAll('.markdown-diff-fallback-row .markdown-file-card')).toHaveLength(2)
  })

  it('routes a workspace HTML card click to requestBrowserArtifact', async () => {
    previewByDisplayPath.mockClear()
    requestBrowserArtifact.mockClear()
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '[report.html](/workspace/Downloads/report.html)' },
    })

    await wrapper.find('.markdown-file-card').trigger('click')

    expect(requestBrowserArtifact).toHaveBeenCalledWith('report.html', '/workspace/Downloads/report.html')
    expect(previewByDisplayPath).not.toHaveBeenCalled()
  })

  it('keeps non-HTML workspace cards on the file preview path', async () => {
    previewByDisplayPath.mockClear()
    requestBrowserArtifact.mockClear()
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '[notes.md](/workspace/Downloads/notes.md)' },
    })

    await wrapper.find('.markdown-file-card').trigger('click')

    expect(previewByDisplayPath).toHaveBeenCalledWith('/workspace/Downloads/notes.md', 'notes.md')
    expect(requestBrowserArtifact).not.toHaveBeenCalled()
  })

  it('renders a /workspace/ markdown link as a clickable file card', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '文件已生成:\n\n[report.html](/workspace/Downloads/report.html)' },
    })
    const card = wrapper.find('.markdown-file-card')
    expect(card.exists()).toBe(true)
    expect(card.attributes('data-path')).toBe('/workspace/Downloads/report.html')
    expect(card.attributes('data-filename')).toBe('report.html')
  })

  it('turns a raw MEDIA: workspace-artifact line into a clickable file card', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '文件已生成 ✅\n\nMEDIA:/Users/kite/.hermes/profiles/feishu_g41a5b5g/workspace/hermes-intro.html',
      },
    })
    const card = wrapper.find('.markdown-file-card')
    expect(card.exists()).toBe(true)
    expect(card.attributes('data-path')).toBe('/workspace/hermes-intro.html')
    expect(card.attributes('data-filename')).toBe('hermes-intro.html')
    // the raw MEDIA: path text must be gone
    expect(wrapper.text()).not.toContain('MEDIA:/Users')
  })

  it('leaves a non-workspace MEDIA line as plain text (not linkable)', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: 'MEDIA:/etc/hosts' },
    })
    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('keeps the embedded-browser card click for run-changed HTML artifacts', async () => {
    previewByDisplayPath.mockClear()
    requestBrowserArtifact.mockClear()
    const diffFile = {
      id: 9,
      path: 'Downloads/report.html',
      change_id: 'change-1',
      session_id: 'session-1',
      additions: 5,
      deletions: 1,
    }
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[report.html](/workspace/Downloads/report.html)',
        workspaceDiffFiles: [diffFile],
      },
    })

    await wrapper.find('.markdown-file-card').trigger('click')
    expect(requestBrowserArtifact).toHaveBeenCalledWith('report.html', '/workspace/Downloads/report.html')
    expect(wrapper.emitted('workspace-diff-file-click')).toBeUndefined()

    await wrapper.find('.markdown-file-diff-btn').trigger('click')
    expect(wrapper.emitted('workspace-diff-file-click')).toEqual([[expect.objectContaining({ id: 9 })]])
  })

})
