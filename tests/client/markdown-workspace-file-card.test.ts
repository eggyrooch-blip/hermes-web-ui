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

vi.mock('@/api/hermes/download', () => ({
  downloadFile: vi.fn(),
  getDownloadUrl: vi.fn((path: string) => `/download?path=${encodeURIComponent(path)}`),
  fetchFileText: vi.fn(),
}))

const previewByDisplayPath = vi.fn()
vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => ({ previewByDisplayPath }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

describe('MarkdownRenderer workspace artifact file card', () => {
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

  it('routes a workspace HTML card click to previewByDisplayPath (panel preview, not download)', async () => {
    previewByDisplayPath.mockClear()
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '[report.html](/workspace/Downloads/report.html)' },
    })
    await wrapper.find('.markdown-file-card').trigger('click')
    expect(previewByDisplayPath).toHaveBeenCalledWith('/workspace/Downloads/report.html', 'report.html')
  })
})
