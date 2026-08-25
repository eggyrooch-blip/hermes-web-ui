// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({ getFileDownloadUrl: vi.fn(() => '/download/stub') }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/hermes/files', () => ({ getFileDownloadUrl: mocks.getFileDownloadUrl }))

// Real MarkdownRenderer drags in markdown-it/katex/naive-ui drawers; this test
// is about the reader shell, not markdown rendering.
vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: { props: ['content'], template: '<div class="md-stub">{{ content }}</div>' },
}))

const AgentArtifactPreview = (await import('@/components/hermes/agents/AgentArtifactPreview.vue')).default

const ENTRY = {
  name: 'hermes_intro.html',
  path: 'hermes_intro.html',
  isDir: false,
  size: 2048,
  modTime: '2026-08-18T06:52:47.000Z',
}

function mountPreview(props: Record<string, unknown> = {}) {
  return mount(AgentArtifactPreview, {
    props: { entry: ENTRY, kind: 'html', content: '<h1>hi</h1>', profile: 'test1', ...props },
  })
}

describe('AgentArtifactPreview', () => {
  it('renders HTML in a script-less sandboxed frame, never a live page', () => {
    const wrapper = mountPreview()
    const frame = wrapper.find('iframe')

    expect(frame.attributes('srcdoc')).toBe('<h1>hi</h1>')
    // allow-scripts here — with allow-same-origin — would let an artifact strip
    // its own sandbox. Preview must not be a way to execute a file.
    expect(frame.attributes('sandbox')).toBe('allow-same-origin')
    expect(frame.attributes('sandbox')).not.toContain('allow-scripts')
    expect(frame.attributes('referrerpolicy')).toBe('no-referrer')
  })

  it('flips the same HTML to raw source and back', async () => {
    const wrapper = mountPreview()

    await wrapper.find('[data-testid="agent-artifact-source-toggle"]').trigger('click')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('.artifact-doc__source').text()).toBe('<h1>hi</h1>')

    await wrapper.find('[data-testid="agent-artifact-source-toggle"]').trigger('click')
    expect(wrapper.find('iframe').exists()).toBe(true)
  })

  it('renders markdown through the shared renderer', () => {
    const wrapper = mountPreview({ kind: 'markdown', content: '# hi' })
    expect(wrapper.find('.md-stub').text()).toBe('# hi')
  })

  it('streams an image from the profile-scoped download URL', () => {
    const wrapper = mountPreview({ kind: 'image', content: '' })
    expect(mocks.getFileDownloadUrl).toHaveBeenCalledWith('hermes_intro.html', 'hermes_intro.html', 'test1')
    expect(wrapper.find('img').attributes('src')).toBe('/download/stub')
  })

  it('offers download rather than a dead end for a file it cannot render', () => {
    const wrapper = mountPreview({ kind: 'binary', content: '' })

    expect(wrapper.text()).toContain('agentDetail.artifacts.previewUnsupported')
    expect(wrapper.find('iframe').exists()).toBe(false)
    wrapper.find('.kp-ghost-btn').trigger('click')
    expect(wrapper.emitted('download')).toHaveLength(1)
  })

  it('emits close and download from the header', async () => {
    const wrapper = mountPreview()

    await wrapper.find('[data-testid="agent-artifact-download"]').trigger('click')
    await wrapper.find('[data-testid="agent-artifact-close"]').trigger('click')

    expect(wrapper.emitted('download')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('shows the load error in place of the document', () => {
    const wrapper = mountPreview({ error: '预览失败' })
    expect(wrapper.text()).toContain('预览失败')
    expect(wrapper.find('iframe').exists()).toBe(false)
  })
})
