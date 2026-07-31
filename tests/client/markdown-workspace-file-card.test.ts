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
  isImageFile: (name: string) => /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(name),
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

  it('keeps non-workspace image cards on the safe download path', async () => {
    downloadFile.mockClear()
    previewByDisplayPath.mockClear()
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '[preview.gif](/tmp/preview.gif)' },
    })

    await wrapper.find('.markdown-file-card').trigger('click')

    expect(downloadFile).toHaveBeenCalledWith('/tmp/preview.gif', 'preview.gif')
    expect(previewByDisplayPath).not.toHaveBeenCalled()
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

  it('renders a remote MEDIA image directive as an inline image, not a blue link', () => {
    const url = 'https://251000800.vod2.myqcloud.com/8bd1c0c1/aigcImageGenFile.jpg'
    const wrapper = mount(MarkdownRenderer, {
      props: { content: `图片已生成 ✅\n\nMEDIA:${url}` },
    })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    // remote src must stay untouched — no /api/hermes/download proxy (VOD 404 lesson)
    expect(img.attributes('src')).toBe(url)
    expect(img.attributes('alt')).toBe('aigcImageGenFile.jpg')
    expect(wrapper.text()).not.toContain('MEDIA:')
  })

  it('renders a remote MEDIA non-image directive as a clickable link only', () => {
    const url = 'https://files.example.com/reports/report.pdf'
    const wrapper = mount(MarkdownRenderer, {
      props: { content: `MEDIA:${url}` },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    const link = wrapper.find('a')
    expect(link.attributes('href')).toBe(url)
    expect(link.text()).toBe('report.pdf')
    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('keeps remote MEDIA URLs with parens and query strings intact', () => {
    const url = 'https://cdn.example.com/a(1)/pic name.png?sign=a%2Fb&t=1'
    const wrapper = mount(MarkdownRenderer, {
      props: { content: `MEDIA:${url}` },
    })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    // only the space is encoded; parens and the pre-encoded %2F survive as-is
    expect(img.attributes('src')).toBe('https://cdn.example.com/a(1)/pic%20name.png?sign=a%2Fb&t=1')
    expect(img.attributes('alt')).toBe('pic name.png')
  })

  it('does not turn a non-http MEDIA scheme into a link or image', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: 'MEDIA:javascript:alert(1)//evil.jpg' },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).not.toMatch(/(href|src)="\s*javascript:/i)
    expect(wrapper.text()).toContain('MEDIA:javascript:alert(1)')
  })

  it('escapes a hostile remote MEDIA URL instead of producing an executable sink', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'MEDIA:https://evil.example.com/a" onerror="alert(1)<script>x</script>.jpg',
      },
    })

    expect(wrapper.html()).not.toContain('<script')
    expect(wrapper.element.querySelector('[onerror]')).toBeNull()
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    // the quote/space/angle brackets stay inside the src value, they cannot
    // close the attribute and start a new one
    expect(img.attributes('src')).toBe(
      'https://evil.example.com/a%22%20onerror=%22alert(1)%3Cscript%3Ex%3C/script%3E.jpg',
    )
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
