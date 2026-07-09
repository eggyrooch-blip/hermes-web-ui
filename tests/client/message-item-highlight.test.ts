// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const UNIFIED_DIFF_SAMPLE = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-const value = 1
+const value = 2
 console.log(value)
`

const fetchWorkspaceRunChangeFileMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/sessions', () => ({
  fetchWorkspaceRunChangeFile: fetchWorkspaceRunChangeFileMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

describe('MessageItem tool details', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
    })
    fetchWorkspaceRunChangeFileMock.mockReset()
  })

  it('renders highlighted code blocks for tool arguments and tool results', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-1',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'web_search',
          toolArgs: '{"query":"syntax highlighting"}',
          toolResult: '{"results":[{"title":"Done"}]}',
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const blocks = wrapper.findAll('.tool-details .hljs-code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].find('.code-lang').text()).toBe('json')
    expect(blocks[1].find('.code-lang').text()).toBe('json')
  })

  it('renders patch tool results with diff highlighting instead of plain text', async () => {
    const patchResult = [
      '*** Begin Patch',
      '*** Update File: src/demo.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')

    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'patch-result',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'patch',
          toolResult: patchResult,
          toolStatus: 'done',
        } satisfies Message,
      },
      global: { stubs: { MarkdownRenderer: true } },
    })

    await wrapper.find('.tool-line').trigger('click')

    const code = wrapper.find('.tool-details code.hljs')
    expect(wrapper.find('.tool-details .code-lang').text()).toBe('diff')
    expect(code.findAll('span').length).toBeGreaterThan(0)
  })

  it('normalizes non-string runtime tool payloads before rendering', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-object-result',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'runtime_payload',
          toolArgs: { query: 'object args' },
          toolResult: 42,
          toolStatus: 'done',
        } as unknown as Message,
      },
      global: { stubs: { MarkdownRenderer: true } },
    })

    await wrapper.find('.tool-line').trigger('click')

    const blocks = wrapper.findAll('.tool-details .hljs-code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].find('.code-lang').text()).toBe('json')
    expect(blocks[0].find('code').text()).toContain('object args')
    expect(blocks[1].find('.code-lang').text()).toBe('json')
    expect(blocks[1].find('code').text()).toBe('42')
  })

  it('renders falsy non-string runtime tool payloads', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-zero-result',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'runtime_payload',
          toolResult: 0,
          toolStatus: 'done',
        } as unknown as Message,
      },
      global: { stubs: { MarkdownRenderer: true } },
    })

    await wrapper.find('.tool-line').trigger('click')

    const block = wrapper.find('.tool-details .hljs-code-block')
    expect(block.exists()).toBe(true)
    expect(block.find('.code-lang').text()).toBe('json')
    expect(block.find('code').text()).toBe('0')
  })

  it('keeps plain string false payloads as text', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-text-false-result',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'runtime_payload',
          toolResult: 'false',
          toolStatus: 'done',
        } satisfies Message,
      },
      global: { stubs: { MarkdownRenderer: true } },
    })

    await wrapper.find('.tool-line').trigger('click')

    const block = wrapper.find('.tool-details .hljs-code-block')
    expect(block.exists()).toBe(true)
    expect(block.find('.code-lang').text()).toBe('text')
    expect(block.find('code').text()).toBe('false')
  })

  it('copies tool detail code through the delegated click handler', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-copy',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'web_search',
          toolArgs: '{"query":"syntax highlighting"}',
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const expected = wrapper.find('.tool-details code.hljs').text()
    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(expected)
  })

  it('truncates large tool arguments for display but copies the full formatted payload', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const message = {
      content: 'x'.repeat(4000),
      ok: true,
    }
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-args-large',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'write_file',
          toolArgs: JSON.stringify(message),
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const expected = JSON.stringify(message, null, 2)
    const code = wrapper.find('.tool-details code.hljs')
    const displayed = JSON.parse(code.text())
    expect(wrapper.find('.tool-details .code-lang').text()).toBe('json')
    expect(wrapper.html()).toContain('chat.truncated')
    expect(displayed.content).toContain('chat.truncated')
    expect(code.findAll('span').length).toBeGreaterThan(0)

    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(expected)
  })

  it('copies the full large JSON tool result even when the display is truncated', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const fullResult = {
      content: 'x'.repeat(4000),
      ok: true,
    }
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-2',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'read_file',
          toolResult: JSON.stringify(fullResult),
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const code = wrapper.find('.tool-details code.hljs')
    const displayed = JSON.parse(code.text())
    expect(wrapper.find('.tool-details .code-lang').text()).toBe('json')
    expect(wrapper.html()).toContain('chat.truncated')
    expect(displayed.content).toContain('chat.truncated')
    expect(code.findAll('span').length).toBeGreaterThan(0)

    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(fullResult, null, 2))
  })

  it('truncates large JSON arrays at item boundaries so display remains parseable JSON', async () => {
    const fullResult = Array.from({ length: 100 }, (_, index) => ({
      index,
      value: `item-${index}-${'x'.repeat(80)}`,
    }))
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-array',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'browser_snapshot',
          toolResult: JSON.stringify(fullResult),
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const code = wrapper.find('.tool-details code.hljs')
    const displayed = JSON.parse(code.text())
    expect(Array.isArray(displayed)).toBe(true)
    expect(displayed.at(-1)).toContain('chat.truncated')
    expect(code.text().length).toBeLessThanOrEqual(1000)
  })

  it('copies the full large raw tool result even when the display is truncated', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const fullResult = 'line\n'.repeat(1200)
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-raw',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'read_file',
          toolResult: fullResult,
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const displayedResult = fullResult.slice(0, 1000) + '\nchat.truncated'
    const code = wrapper.find('.tool-details code.hljs')
    expect(wrapper.find('.tool-details .code-lang').text()).toBe('text')
    expect(code.text()).toBe(displayedResult)
    expect(code.findAll('span')).toHaveLength(0)

    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(fullResult)
  })

  it('renders raw unified diff tool payloads with semantic diff classes', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-diff',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'apply_patch',
          toolResult: UNIFIED_DIFF_SAMPLE,
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const toolDetails = wrapper.find('.tool-details')
    expect(toolDetails.find('.code-lang').text()).toBe('diff')
    expect(toolDetails.find('.hljs-unified-diff').exists()).toBe(true)
    expect(toolDetails.find('.diff-line-file-header').exists()).toBe(true)
    expect(toolDetails.find('.diff-line-hunk-header').exists()).toBe(true)
    expect(toolDetails.find('.diff-line-number-old').text()).toBe('1')
    expect(toolDetails.find('.diff-line-number-new').text()).toBe('1')
    expect(toolDetails.find('.diff-line-added .diff-line-content').text()).toBe('+const value = 2')
    expect(toolDetails.find('.diff-line-removed .diff-line-content').text()).toBe('-const value = 1')
  })

  it('does not truncate large unified diff tool results', async () => {
    const largeDiff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-${'a'.repeat(1600)}\n+${'b'.repeat(1600)}\n`
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-diff-large',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'git_show',
          toolResult: largeDiff,
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const toolDetails = wrapper.find('.tool-details')
    expect(toolDetails.find('.code-lang').text()).toBe('diff')
    expect(toolDetails.find('.diff-line-added .diff-line-content').text()).toContain('b'.repeat(1600))
    expect(toolDetails.text()).not.toContain('chat.truncated')
  })

  it('shows only an embedded difference field when a JSON tool result contains a unified diff', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const largeDiff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-${'a'.repeat(1600)}\n+${'b'.repeat(1600)}\n`
    const fullResult = {
      summary: 'metadata should stay out of the visible diff display',
      difference: largeDiff,
      ok: true,
    }
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-json-diff-large',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'git_show',
          toolResult: JSON.stringify(fullResult),
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const toolDetails = wrapper.find('.tool-details')
    const code = toolDetails.find('code.hljs')
    expect(toolDetails.find('.code-lang').text()).toBe('diff')
    expect(toolDetails.find('.hljs-unified-diff').exists()).toBe(true)
    expect(toolDetails.find('.diff-line-added .diff-line-content').text()).toContain('b'.repeat(1600))
    expect(code.text()).not.toContain('metadata should stay out')
    expect(toolDetails.text()).not.toContain('chat.truncated')

    await wrapper.find('.tool-details [data-copy-source="tool-result"] [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(fullResult, null, 2))
  })

  it('renders a workspace diff summary card and loads file patch details on demand', async () => {
    fetchWorkspaceRunChangeFileMock.mockResolvedValue({
      id: 7,
      change_id: 'change-1',
      session_id: 'session-1',
      path: 'src/app.ts',
      old_path: null,
      change_type: 'modified',
      additions: 2,
      deletions: 1,
      size_before: 10,
      size_after: 11,
      patch_bytes: UNIFIED_DIFF_SAMPLE.length,
      truncated: false,
      binary: false,
      created_at: 2,
      patch: UNIFIED_DIFF_SAMPLE,
    })
    const wrapper = mount(MessageItem, {
      props: {
        session: { id: 'session-1', profile: 'travel' } as any,
        message: {
          id: 'workspace-change:change-1',
          role: 'command',
          content: '',
          timestamp: Date.now(),
          commandAction: 'workspace.diff',
          commandData: {
            change_id: 'change-1',
            session_id: 'session-1',
            workspace: 'project',
            workspace_kind: 'git',
            files_changed: 1,
            additions: 2,
            deletions: 1,
            truncated: false,
            files: [{
              id: 7,
              path: 'src/app.ts',
              change_type: 'modified',
              additions: 2,
              deletions: 1,
              patch_bytes: UNIFIED_DIFF_SAMPLE.length,
              truncated: false,
              binary: false,
            }],
          },
        } as unknown as Message,
      },
    })

    expect(wrapper.find('.workspace-diff-card').exists()).toBe(true)
    expect(wrapper.text()).toContain('1')
    expect(wrapper.text()).toContain('+2')
    expect(wrapper.text()).toContain('-1')
    expect(wrapper.text()).toContain('src/app.ts')

    await wrapper.find('.workspace-diff-file').trigger('click')

    expect(fetchWorkspaceRunChangeFileMock).toHaveBeenCalledWith('session-1', 'change-1', 7, 'travel')
    const patch = wrapper.find('.workspace-diff-patch')
    expect(patch.exists()).toBe(true)
    expect(patch.find('.code-lang').text()).toBe('diff')
    expect(patch.find('.hljs-unified-diff').exists()).toBe(true)
    expect(patch.find('.diff-line-added .diff-line-content').text()).toBe('+const value = 2')
  })
})
