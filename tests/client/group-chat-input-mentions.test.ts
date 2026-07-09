// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import GroupChatInput from '@/components/hermes/group-chat/GroupChatInput.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

function mockViewport(matches: boolean) {
  let currentMatches = matches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQuery = {
    get matches() {
      return currentMatches
    },
    media: '(max-width: 768px)',
    addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.delete(listener)
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => mediaQuery),
  })

  return {
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches
      const event = { matches: nextMatches, media: mediaQuery.media } as MediaQueryListEvent
      listeners.forEach(listener => listener(event))
    },
  }
}

describe('GroupChatInput mentions', () => {
  beforeEach(() => {
    localStorage.clear()
    mockViewport(false)
  })

  it('updates mention suggestions after the textarea has a custom height', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const store = useGroupChatStore()
    store.agents = [{ id: 'agent-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-1', description: '', invited: 1 }]
    store.emitTyping = vi.fn()

    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    const textarea = wrapper.get('textarea')
    const resizeHandle = wrapper.get('.resize-handle')
    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    await textarea.setValue('@')
    await nextTick()
    expect(wrapper.find('.mention-dropdown').exists()).toBe(true)
    expect(wrapper.find('.mention-dropdown').text()).toContain('@Worker')
  })

  it('uses configured desktop input height and lets drag override it until settings change', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 132 }

    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 132px')

    Object.defineProperty(wrapper.get('.input-wrapper').element, 'clientHeight', { value: 132, configurable: true })
    await wrapper.get('.resize-handle').trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 70 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 162px')

    settingsStore.display = { chat_input_height: 118 }
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 118px')
  })

  it('keeps mobile group chat input auto-height instead of applying configured height', async () => {
    mockViewport(true)
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 180 }

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()

    expect(wrapper.get('.input-wrapper').attributes('style') || '').not.toContain('height: 180px')
  })

  it('clears dragged desktop height after switching to mobile so input restores auto-height', async () => {
    const viewport = mockViewport(false)
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 132 }

    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()

    Object.defineProperty(wrapper.get('.input-wrapper').element, 'clientHeight', { value: 132, configurable: true })
    await wrapper.get('.resize-handle').trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 70 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(wrapper.get('.input-wrapper').attributes('style')).toContain('height: 162px')

    viewport.setMatches(true)
    await nextTick()

    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', { value: 84, configurable: true })
    await textarea.setValue('mobile group text')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('84px')
  })
})
