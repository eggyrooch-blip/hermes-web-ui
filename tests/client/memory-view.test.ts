// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const isUserModeMock = vi.hoisted(() => vi.fn(() => false))
const fetchMemoryMock = vi.hoisted(() => vi.fn())
const saveMemoryMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  isUserMode: isUserModeMock,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchMemory: fetchMemoryMock,
  saveMemory: saveMemoryMock,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
      success: vi.fn(),
    }),
    NButton: { template: '<button @click="$emit(\'click\')"><slot name="icon" /><slot /></button>' },
  }
})

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: { props: ['content'], template: '<div class="markdown-renderer">{{ content }}</div>' },
}))

import MemoryView from '@/views/hermes/MemoryView.vue'

describe('MemoryView user mode', () => {
  beforeEach(() => {
    isUserModeMock.mockReturnValue(false)
    fetchMemoryMock.mockReset()
    saveMemoryMock.mockReset()
    fetchMemoryMock.mockResolvedValue({
      memory: 'memory',
      user: 'user',
      soul: 'soul',
      memory_mtime: null,
      user_mtime: null,
      soul_mtime: null,
    })
  })

  it('shows SOUL with editable memory sections in user mode', async () => {
    isUserModeMock.mockReturnValue(true)

    const wrapper = mount(MemoryView)
    await flushPromises()

    expect(wrapper.text()).toContain('memory.myNotes')
    expect(wrapper.text()).toContain('memory.userProfile')
    expect(wrapper.text()).toContain('memory.soul')
    expect(wrapper.text()).toContain('soul')
  })
})
