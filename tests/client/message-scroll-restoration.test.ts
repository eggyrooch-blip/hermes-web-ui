// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia'

const dynamicScrollToBottomMock = vi.hoisted(() => vi.fn())
const dynamicScrollToPositionMock = vi.hoisted(() => vi.fn())
const dynamicScrollToItemMock = vi.hoisted(() => vi.fn())

vi.mock('vue-virtual-scroller', () => ({
  DynamicScroller: defineComponent({
    name: 'DynamicScroller',
    props: {
      items: { type: Array, default: () => [] },
    },
    emits: ['scroll', 'resize', 'visible'],
    setup(_props, { expose }) {
      expose({
        scrollToBottom: dynamicScrollToBottomMock,
        scrollToPosition: dynamicScrollToPositionMock,
        scrollToItem: dynamicScrollToItemMock,
      })
    },
    template: `
      <div class="virtual-message-list" @scroll="$emit('scroll')">
        <slot name="before" />
        <slot v-for="(item, index) in items" :item="item" :index="index" :active="true" />
        <slot name="after" />
      </div>
    `,
  }),
  DynamicScrollerItem: defineComponent({
    name: 'DynamicScrollerItem',
    props: {
      item: { type: Object, required: true },
      index: { type: Number, required: true },
      active: { type: Boolean, default: true },
    },
    template: '<div class="virtual-row"><slot /></div>',
  }),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({ template: '<div>message</div>' }),
}))
vi.mock('@/api/hermes/sessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/hermes/sessions')>(),
  fetchSessions: vi.fn(async () => []),
}))
vi.mock('@/stores/hermes/feedback', () => ({
  useFeedbackStore: () => ({ load: vi.fn() }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'
import {
  messageScrollPositionKey,
  rememberMessageScrollPosition,
  type MessageViewportScrollSnapshot,
} from '@/components/hermes/chat/message-scroll-position'

const snapshot: MessageViewportScrollSnapshot = {
  anchorMessageId: 'message-1',
  anchorOffset: 0,
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 500,
  wasNearBottom: false,
}

function setScrollerMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  el.scrollTop = metrics.scrollTop
}

function elementRect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 400,
    width: 400,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

describe('messageScrollPositionKey', () => {
  it('separates scroll positions by surface, profile, and session', () => {
    const chatKey = messageScrollPositionKey('chat', { id: 'session-1', profile: 'profile-a' })

    expect(chatKey).not.toBe(messageScrollPositionKey('history', { id: 'session-1', profile: 'profile-a' }))
    expect(chatKey).not.toBe(messageScrollPositionKey('chat', { id: 'session-1', profile: 'profile-b' }))
    expect(chatKey).not.toBe(messageScrollPositionKey('chat', { id: 'session-2', profile: 'profile-a' }))
  })

  it('returns null without a session id, and defaults a missing profile', () => {
    expect(messageScrollPositionKey('chat', null)).toBeNull()
    expect(messageScrollPositionKey('chat', { id: '   ' })).toBeNull()
    expect(messageScrollPositionKey('chat', { id: 'session-1' }))
      .toBe(messageScrollPositionKey('chat', { id: 'session-1', profile: 'default' }))
  })

  it('evicts the oldest snapshots when the in-memory cache reaches its limit', () => {
    const positions = new Map<string, MessageViewportScrollSnapshot>()

    rememberMessageScrollPosition(positions, 'session-a', snapshot, 2)
    rememberMessageScrollPosition(positions, 'session-b', snapshot, 2)
    rememberMessageScrollPosition(positions, 'session-c', snapshot, 2)

    expect([...positions.keys()]).toEqual(['session-b', 'session-c'])
  })

  it('refreshes an existing key to the newest slot instead of duplicating it', () => {
    const positions = new Map<string, MessageViewportScrollSnapshot>()

    rememberMessageScrollPosition(positions, 'session-a', snapshot, 2)
    rememberMessageScrollPosition(positions, 'session-b', snapshot, 2)
    rememberMessageScrollPosition(positions, 'session-a', { ...snapshot, scrollTop: 42 }, 2)
    rememberMessageScrollPosition(positions, 'session-c', snapshot, 2)

    expect([...positions.keys()]).toEqual(['session-a', 'session-c'])
    expect(positions.get('session-a')?.scrollTop).toBe(42)
  })
})

describe('VirtualMessageList viewport anchoring', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>
  let nextFrameId: number

  beforeEach(() => {
    vi.clearAllMocks()
    rafCallbacks = new Map()
    nextFrameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.set(++nextFrameId, callback)
      return nextFrameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id)
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
  })

  function drainFrames() {
    while (rafCallbacks.size > 0) {
      const [id, callback] = rafCallbacks.entries().next().value!
      rafCallbacks.delete(id)
      callback(performance.now())
    }
  }

  afterEach(() => {
    const pinia = getActivePinia()
    if (pinia) disposePinia(pinia)
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('restores the saved viewport after profile hydration takes longer than eight seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    setActivePinia(createPinia())
    const store = useChatStore()
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `slow-message-${index}`, role: 'user' as const, content: `${index}`, timestamp: index,
    }))
    const session = (profile: string, hydrated = true): Session => ({
      id: 'slow-profile-session', profile, title: profile,
      messages: hydrated ? [...messages] : [], createdAt: 0, updatedAt: 0,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroller = this.closest('.virtual-message-list') as HTMLElement | null
      const top = this.matches('.virtual-row')
        ? Number(this.dataset.virtualIndex) * 100 - (scroller?.scrollTop ?? 0) : 0
      return elementRect(top, top + (this.matches('.virtual-row') ? 100 : 400))
    })
    const flush = async () => { await nextTick(); await nextTick(); drainFrames() }
    store.activeSessionId = 'slow-profile-session'
    store.activeSession = session('profile-a')
    const wrapper = mount(MessageList)
    try {
      await flush()
      let scroller = wrapper.get<HTMLElement>('.virtual-message-list').element
      setScrollerMetrics(scroller, { scrollHeight: 2000, clientHeight: 400, scrollTop: 500 })
      await wrapper.get('.virtual-message-list').trigger('scroll')

      store.activeSession = session('profile-b')
      await flush()
      store.isLoadingMessages = true
      store.activeSession = session('profile-a', false)
      await flush()
      await vi.advanceTimersByTimeAsync(16000)
      await flush()

      scroller = wrapper.get<HTMLElement>('.virtual-message-list').element
      setScrollerMetrics(scroller, { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 })
      store.activeSession!.messages = [...messages]
      store.isLoadingMessages = false
      await flush()
      expect(scroller.scrollTop).toBe(500)
      expect(wrapper.findAll('.virtual-row')).toHaveLength(20)
    } finally {
      wrapper.unmount()
    }
  })

  it('tags every rendered row with its message id', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-a' }, { id: 'message-b' }],
        virtualized: false,
      },
      slots: { item: '<div>message</div>' },
    })
    await nextTick()

    const ids = wrapper.findAll('.virtual-row').map(row => row.attributes('data-message-id'))
    expect(ids).toEqual(['message-a', 'message-b'])
  })

  it('captures the top visible message as the viewport anchor', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-a' }, { id: 'message-b' }, { id: 'message-c' }],
        virtualized: false,
      },
      slots: { item: '<div>message</div>' },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    const rows = wrapper.findAll<HTMLElement>('.virtual-row')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1200,
      clientHeight: 400,
      scrollTop: 300,
    })
    vi.spyOn(scroller.element, 'getBoundingClientRect').mockReturnValue(elementRect(100, 500))
    vi.spyOn(rows[0].element, 'getBoundingClientRect').mockReturnValue(elementRect(40, 140))
    vi.spyOn(rows[1].element, 'getBoundingClientRect').mockReturnValue(elementRect(140, 300))
    vi.spyOn(rows[2].element, 'getBoundingClientRect').mockReturnValue(elementRect(300, 520))

    expect((wrapper.vm as any).captureViewportPosition()).toMatchObject({
      anchorMessageId: 'message-a',
      anchorOffset: -60,
      wasNearBottom: false,
    })
  })

  it('skips rows scrolled fully out of the viewport when choosing the anchor', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-a' }, { id: 'message-b' }],
        virtualized: false,
      },
      slots: { item: '<div>message</div>' },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    const rows = wrapper.findAll<HTMLElement>('.virtual-row')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1200,
      clientHeight: 400,
      scrollTop: 300,
    })
    vi.spyOn(scroller.element, 'getBoundingClientRect').mockReturnValue(elementRect(100, 500))
    // message-a sits entirely above the viewport top.
    vi.spyOn(rows[0].element, 'getBoundingClientRect').mockReturnValue(elementRect(0, 90))
    vi.spyOn(rows[1].element, 'getBoundingClientRect').mockReturnValue(elementRect(120, 400))

    expect((wrapper.vm as any).captureViewportPosition()).toMatchObject({
      anchorMessageId: 'message-b',
      anchorOffset: 20,
    })
  })

  it('restores a changed layout by aligning the saved message anchor', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-before' }, { id: 'message-anchor' }, { id: 'message-after' }],
        virtualized: false,
      },
      slots: { item: '<div>message</div>' },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    const anchorRow = wrapper.findAll<HTMLElement>('.virtual-row')[1]
    setScrollerMetrics(scroller.element, {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
    })
    vi.spyOn(scroller.element, 'getBoundingClientRect').mockReturnValue(elementRect(100, 500))
    vi.spyOn(anchorRow.element, 'getBoundingClientRect').mockImplementation(() =>
      elementRect(620 - scroller.element.scrollTop, 820 - scroller.element.scrollTop),
    )

    const restored = (wrapper.vm as any).restoreViewportPosition({
      anchorMessageId: 'message-anchor',
      anchorOffset: -24,
      scrollTop: 320,
      scrollHeight: 1200,
      clientHeight: 400,
      wasNearBottom: false,
    })
    expect(restored).toBe(true)
    await nextTick()
    drainFrames()

    expect(scroller.element.scrollTop).toBe(544)
  })

  it('falls back to the bottom when the saved message anchor is missing', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-current' }],
        virtualized: false,
      },
      slots: { item: '<div>message</div>' },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 100,
    })

    const restored = (wrapper.vm as any).restoreViewportPosition({
      anchorMessageId: 'message-missing',
      anchorOffset: 0,
      scrollTop: 100,
      scrollHeight: 900,
      clientHeight: 400,
      wasNearBottom: false,
    })
    expect(restored).toBe(false)
    await nextTick()
    drainFrames()

    expect(scroller.element.scrollTop).toBe(600)
  })

  it('ignores a null snapshot without touching the scroll position', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: {
        messages: [{ id: 'message-a' }],
        virtualized: false,
      },
      slots: { item: '<div>message</div>' },
    })
    await nextTick()

    const scroller = wrapper.find<HTMLElement>('.virtual-message-list')
    setScrollerMetrics(scroller.element, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 100,
    })

    expect((wrapper.vm as any).restoreViewportPosition(null)).toBe(false)
    await nextTick()
    drainFrames()

    expect(scroller.element.scrollTop).toBe(100)
  })
})
