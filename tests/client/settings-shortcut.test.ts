// @vitest-environment jsdom
import { nextTick, defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const apiMocks = vi.hoisted(() => ({
  fetchSessionsMock: vi.fn(),
  searchSessionsMock: vi.fn(),
  routerPushMock: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchSessions: apiMocks.fetchSessionsMock,
  searchSessions: apiMocks.searchSessionsMock,
}))

const chatStoreMock = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  loadSessions: vi.fn(),
  switchSession: vi.fn(),
  newChat: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

const routerCurrentRoute = { value: { name: 'hermes.logs' } as { name: string } }

vi.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: routerCurrentRoute,
    push: apiMocks.routerPushMock,
  }),
}))

import { useKeyboard } from '@/composables/useKeyboard'

const Dummy = defineComponent({
  setup() {
    useKeyboard()
    return () => h('div')
  },
})

function press(modifiers: Record<string, boolean>, key = ',') {
  const event = new KeyboardEvent('keydown', {
    key,
    ...modifiers,
    bubbles: true,
    cancelable: true,
  })
  window.dispatchEvent(event)
  return event
}

describe('settings keyboard shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routerCurrentRoute.value = { name: 'hermes.logs' }
  })

  it.each([
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
  ])('opens settings on %s+Comma', async (_label, modifiers) => {
    const wrapper = mount(Dummy)

    const event = press(modifiers)
    await nextTick()

    expect(apiMocks.routerPushMock).toHaveBeenCalledWith({ name: 'hermes.settings' })
    expect(event.defaultPrevented).toBe(true)

    wrapper.unmount()
  })

  it('does not open settings from the login page', async () => {
    routerCurrentRoute.value = { name: 'login' }
    const wrapper = mount(Dummy)

    const event = press({ metaKey: true })
    await nextTick()

    expect(apiMocks.routerPushMock).not.toHaveBeenCalledWith({ name: 'hermes.settings' })
    expect(event.defaultPrevented).toBe(false)

    wrapper.unmount()
  })

  it('ignores a bare comma without the modifier', async () => {
    const wrapper = mount(Dummy)

    const event = press({})
    await nextTick()

    expect(apiMocks.routerPushMock).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)

    wrapper.unmount()
  })

  it('stops listening once the component unmounts', async () => {
    const wrapper = mount(Dummy)
    wrapper.unmount()

    press({ metaKey: true })
    await nextTick()

    expect(apiMocks.routerPushMock).not.toHaveBeenCalled()
  })

  it('leaves the existing Cmd+J jobs shortcut working', async () => {
    const wrapper = mount(Dummy)

    press({ metaKey: true }, 'j')
    await nextTick()

    expect(apiMocks.routerPushMock).toHaveBeenCalledWith({ name: 'hermes.jobs' })

    wrapper.unmount()
  })
})
