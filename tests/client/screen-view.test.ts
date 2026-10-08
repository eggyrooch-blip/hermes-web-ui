// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const desktopApi = vi.hoisted(() => ({
  observeDesktop: vi.fn(),
  ensureDesktop: vi.fn(),
  acquireDesktopLease: vi.fn(),
  releaseDesktopLease: vi.fn(),
  buildDesktopScreenWebSocketUrl: vi.fn((viewerId: string) => `ws://webui.test/api/hermes/desktop/ws?viewer_id=${viewerId}`),
}))
const routerPush = vi.hoisted(() => vi.fn())

type Handler = (event: { detail?: { clean?: boolean } }) => void

const rfbInstances = vi.hoisted(() => [] as any[])

vi.mock('@/api/hermes/desktop', () => desktopApi)
vi.mock('@/stores/hermes/profiles', async () => {
  const { reactive } = await import('vue')
  const store = reactive({ activeProfileName: 'alice' as string | null })
  return { useProfilesStore: () => store }
})
vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush }) }))
vi.mock('@/router', () => ({ default: { currentRoute: { value: { name: 'hermes.screen' } }, replace: vi.fn() } }))
vi.mock('@novnc/novnc', () => ({
  default: class FakeRfb {
    viewOnly = false
    scaleViewport = false
    resizeSession = true
    focusOnClick = false
    background = ''
    qualityLevel = 0
    handlers: Record<string, Handler[]> = {}
    disconnect = vi.fn()
    focus = vi.fn()
    constructor(public target: HTMLElement, public socket: FakeWebSocket, public options: Record<string, unknown>) {
      rfbInstances.push(this)
    }
    addEventListener(type: string, handler: Handler) {
      ;(this.handlers[type] ||= []).push(handler)
    }
    emit(type: string, detail?: { clean?: boolean }) {
      for (const handler of this.handlers[type] || []) handler({ detail })
    }
  },
}))

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
  binaryType = 'blob'
  closeCalls: Array<number | undefined> = []
  private closeListeners: Array<(event: { code: number }) => void> = []
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, listener: (event: { code: number }) => void) {
    if (type === 'close') this.closeListeners.push(listener)
  }
  close(code?: number) {
    this.closeCalls.push(code)
    this.readyState = FakeWebSocket.CLOSED
  }
  /** The bridge closed the stream with `code`; noVNC then reports a disconnect. */
  serverClose(code: number, rfb: any) {
    this.readyState = FakeWebSocket.CLOSED
    for (const listener of this.closeListeners) listener({ code })
    rfb.emit('disconnect', { clean: code === 1000 })
  }
}

const humanLease = { holder: 'human', viewer_hash: 'aaaaaaaaaaaa', epoch: 2 }
const agentLease = { holder: 'agent', viewer_hash: null, epoch: 1 }

function observeResult(overrides: Record<string, unknown> = {}) {
  return { enabled: true, running: true, viewer_id: 'viewer-1', lease: agentLease, you_hold: false, ...overrides }
}

async function mountScreen() {
  const ScreenView = (await import('@/views/hermes/ScreenView.vue')).default
  const wrapper = mount(ScreenView, { attachTo: document.body })
  await vi.waitFor(() => expect(rfbInstances.length).toBeGreaterThan(0))
  return wrapper
}

function button(wrapper: any, testId: string) {
  return wrapper.find(`[data-testid="${testId}"]`)
}

describe('ScreenView', () => {
  beforeEach(() => {
    rfbInstances.length = 0
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.clearAllMocks()
    desktopApi.observeDesktop.mockResolvedValue(observeResult())
    desktopApi.acquireDesktopLease.mockResolvedValue({ lease: humanLease, you_hold: true })
    desktopApi.releaseDesktopLease.mockResolvedValue({ lease: agentLease, you_hold: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('opens the live desktop view-only while the bot holds control', async () => {
    const wrapper = await mountScreen()
    const rfb = rfbInstances[0]

    expect(desktopApi.buildDesktopScreenWebSocketUrl).toHaveBeenCalledWith('viewer-1')
    expect(FakeWebSocket.instances[0].binaryType).toBe('arraybuffer')
    expect(rfb.socket).toBe(FakeWebSocket.instances[0])
    expect(rfb.viewOnly).toBe(true)
    expect(rfb.scaleViewport).toBe(true)
    expect(rfb.resizeSession).toBe(false)

    rfb.emit('connect')
    await flushPromises()
    expect(button(wrapper, 'screen-status').text()).toBe('观看中')
    expect(button(wrapper, 'screen-take-over').text()).toContain('接管')
  })

  it('takes over for keyboard and mouse, then hands back to watching', async () => {
    const wrapper = await mountScreen()
    const rfb = rfbInstances[0]
    rfb.emit('connect')
    await flushPromises()

    await button(wrapper, 'screen-take-over').trigger('click')
    await flushPromises()
    expect(desktopApi.acquireDesktopLease).toHaveBeenCalledWith('viewer-1')
    expect(rfb.viewOnly).toBe(false)
    expect(rfb.focus).toHaveBeenCalled()
    expect(button(wrapper, 'screen-status').text()).toBe('你正在操作')

    await button(wrapper, 'screen-hand-back').trigger('click')
    await flushPromises()
    expect(desktopApi.releaseDesktopLease).toHaveBeenCalledWith('viewer-1')
    expect(rfb.viewOnly).toBe(true)
    expect(button(wrapper, 'screen-status').text()).toBe('观看中')
  })

  it('drops back to watching on a fresh viewer when control is taken elsewhere (4000)', async () => {
    const wrapper = await mountScreen()
    const first = rfbInstances[0]
    first.emit('connect')
    await flushPromises()
    await button(wrapper, 'screen-take-over').trigger('click')
    await flushPromises()
    expect(first.viewOnly).toBe(false)

    desktopApi.observeDesktop.mockResolvedValue(observeResult({ viewer_id: 'viewer-2', lease: humanLease, you_hold: false }))
    FakeWebSocket.instances[0].serverClose(4000, first)
    await vi.waitFor(() => expect(rfbInstances).toHaveLength(2))

    const second = rfbInstances[1]
    expect(desktopApi.observeDesktop).toHaveBeenCalledTimes(2)
    expect(desktopApi.buildDesktopScreenWebSocketUrl).toHaveBeenLastCalledWith('viewer-2')
    expect(second.viewOnly).toBe(true)
    second.emit('connect')
    await flushPromises()
    expect(button(wrapper, 'screen-status').text()).toBe('观看中')
    expect(button(wrapper, 'screen-notice').text()).toContain('已回到观看')
  })

  it('shows 桌面已关闭 when the desktop stops (4001) and starts it on request', async () => {
    const wrapper = await mountScreen()
    rfbInstances[0].emit('connect')
    FakeWebSocket.instances[0].serverClose(4001, rfbInstances[0])
    await flushPromises()

    expect(button(wrapper, 'screen-stopped').text()).toContain('桌面已关闭')
    desktopApi.ensureDesktop.mockResolvedValue(observeResult({ viewer_id: 'viewer-3' }))
    await button(wrapper, 'screen-start').trigger('click')
    await vi.waitFor(() => expect(rfbInstances).toHaveLength(2))
    expect(desktopApi.ensureDesktop).toHaveBeenCalledWith('viewer-1')
    expect(desktopApi.buildDesktopScreenWebSocketUrl).toHaveBeenLastCalledWith('viewer-3')
  })

  it('re-observes when the viewer id is rejected (4401)', async () => {
    await mountScreen()
    desktopApi.observeDesktop.mockResolvedValue(observeResult({ viewer_id: 'viewer-4' }))
    FakeWebSocket.instances[0].serverClose(4401, rfbInstances[0])
    await vi.waitFor(() => expect(rfbInstances).toHaveLength(2))
    expect(desktopApi.buildDesktopScreenWebSocketUrl).toHaveBeenLastCalledWith('viewer-4')
  })

  it('stops reconnecting after repeated rapid evictions', async () => {
    const wrapper = await mountScreen()
    for (let round = 0; round < 4; round += 1) {
      const count = rfbInstances.length
      FakeWebSocket.instances[count - 1].serverClose(4000, rfbInstances[count - 1])
      await flushPromises()
    }
    await flushPromises()
    expect(rfbInstances).toHaveLength(4)
    expect(button(wrapper, 'screen-error').text()).toContain('反复被中断')
  })

  it('shows the stopped state up front when the desktop is not running', async () => {
    desktopApi.observeDesktop.mockResolvedValue(observeResult({ running: false }))
    const ScreenView = (await import('@/views/hermes/ScreenView.vue')).default
    const wrapper = mount(ScreenView)
    await flushPromises()
    expect(button(wrapper, 'screen-stopped').text()).toContain('桌面未启动')
    expect(rfbInstances).toHaveLength(0)
  })

  it('explains the four-viewer limit when observe answers 429', async () => {
    desktopApi.observeDesktop.mockRejectedValue(Object.assign(new Error('API Error 429: too many viewers'), { status: 429 }))
    const ScreenView = (await import('@/views/hermes/ScreenView.vue')).default
    const wrapper = mount(ScreenView)
    await flushPromises()
    expect(button(wrapper, 'screen-error').text()).toContain('最多 4 个')
  })

  it('starts over on a fresh viewer when a lease call says the viewer expired (403)', async () => {
    const wrapper = await mountScreen()
    rfbInstances[0].emit('connect')
    await flushPromises()
    desktopApi.acquireDesktopLease.mockRejectedValueOnce(Object.assign(new Error('API Error 403: viewer expired'), { status: 403 }))
    desktopApi.observeDesktop.mockResolvedValue(observeResult({ viewer_id: 'viewer-5' }))

    await button(wrapper, 'screen-take-over').trigger('click')
    await vi.waitFor(() => expect(rfbInstances).toHaveLength(2))
    expect(desktopApi.buildDesktopScreenWebSocketUrl).toHaveBeenLastCalledWith('viewer-5')
    expect(button(wrapper, 'screen-notice').text()).toContain('已重新连接')
  })

  it('treats a 503 on acquire as a stopped desktop, like 4001', async () => {
    const wrapper = await mountScreen()
    rfbInstances[0].emit('connect')
    await flushPromises()
    desktopApi.acquireDesktopLease.mockRejectedValueOnce(
      Object.assign(new Error('API Error 503: desktop_not_running'), { status: 503, code: 'desktop_not_running' }),
    )

    await button(wrapper, 'screen-take-over').trigger('click')
    await flushPromises()

    expect(button(wrapper, 'screen-stopped').text()).toContain('桌面已关闭')
    expect(rfbInstances[0].disconnect).toHaveBeenCalled()
    expect(desktopApi.observeDesktop).toHaveBeenCalledTimes(1)
  })

  it('shows Chinese text for broker error codes instead of the raw code', async () => {
    desktopApi.observeDesktop.mockRejectedValue(
      Object.assign(new Error('API Error 502: desktop_broker_unreachable'), { status: 502, code: 'desktop_broker_unreachable' }),
    )
    const ScreenView = (await import('@/views/hermes/ScreenView.vue')).default
    const wrapper = mount(ScreenView)
    await flushPromises()
    expect(button(wrapper, 'screen-error').text()).toContain('连不上云电脑服务')
    expect(button(wrapper, 'screen-error').text()).not.toContain('desktop_broker_unreachable')
  })

  it('keeps a Chinese broker message for an ensure failure', async () => {
    desktopApi.observeDesktop.mockResolvedValue(observeResult({ running: false }))
    desktopApi.ensureDesktop.mockRejectedValue(
      Object.assign(new Error('API Error 503: 桌面名额已满，稍后再试'), { status: 503, code: 'quota_exceeded' }),
    )
    const ScreenView = (await import('@/views/hermes/ScreenView.vue')).default
    const wrapper = mount(ScreenView)
    await flushPromises()
    await button(wrapper, 'screen-start').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('桌面名额已满，稍后再试')
  })

  it('re-dials with the same viewer id after a dropped stream so a held lease survives', async () => {
    const wrapper = await mountScreen()
    rfbInstances[0].emit('connect')
    await flushPromises()
    await button(wrapper, 'screen-take-over').trigger('click')
    await flushPromises()

    FakeWebSocket.instances[0].serverClose(1006, rfbInstances[0])
    await flushPromises()
    expect(button(wrapper, 'screen-error').text()).toContain('连接已断开')

    await button(wrapper, 'screen-reconnect').trigger('click')
    await vi.waitFor(() => expect(rfbInstances).toHaveLength(2))
    expect(desktopApi.observeDesktop).toHaveBeenCalledTimes(1)
    expect(desktopApi.buildDesktopScreenWebSocketUrl).toHaveBeenLastCalledWith('viewer-1')
    expect(rfbInstances[1].viewOnly).toBe(false)
  })

  it('closes with 1000 and releases a held lease when the page is left', async () => {
    const wrapper = await mountScreen()
    rfbInstances[0].emit('connect')
    await flushPromises()
    await button(wrapper, 'screen-take-over').trigger('click')
    await flushPromises()

    wrapper.unmount()
    expect(FakeWebSocket.instances[0].closeCalls[0]).toBe(1000)
    expect(rfbInstances[0].disconnect).toHaveBeenCalled()
    expect(desktopApi.releaseDesktopLease).toHaveBeenCalledWith('viewer-1')
  })
})

describe('BotScreenEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function mountEntry() {
    const BotScreenEntry = (await import('@/components/hermes/chat/BotScreenEntry.vue')).default
    const wrapper = mount(BotScreenEntry)
    await flushPromises()
    return wrapper
  }

  it('shows the 屏幕 entry only when the broker reports a desktop', async () => {
    desktopApi.observeDesktop.mockResolvedValue(observeResult())
    const wrapper = await mountEntry()
    const entry = wrapper.find('[data-testid="bot-screen-entry"]')
    expect(entry.exists()).toBe(true)
    await entry.trigger('click')
    expect(routerPush).toHaveBeenCalledWith({ name: 'hermes.screen' })
  })

  it('stays hidden when the desktop is disabled or the probe fails', async () => {
    desktopApi.observeDesktop.mockResolvedValue(observeResult({ enabled: false }))
    expect((await mountEntry()).find('[data-testid="bot-screen-entry"]').exists()).toBe(false)

    desktopApi.observeDesktop.mockRejectedValue(new Error('API Error 502'))
    expect((await mountEntry()).find('[data-testid="bot-screen-entry"]').exists()).toBe(false)
  })
})

describe('desktop API requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never raises the global access-denied toast for a desktop 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'viewer_forbidden', message: 'viewer belongs to another owner' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )))
    const notices: unknown[] = []
    const onNotice = (event: Event) => notices.push((event as CustomEvent).detail)
    window.addEventListener('hermes-auth-notice', onNotice)
    try {
      const api = await vi.importActual<typeof import('@/api/hermes/desktop')>('@/api/hermes/desktop')
      await expect(api.observeDesktop()).rejects.toMatchObject({ status: 403, code: 'viewer_forbidden' })
      await expect(api.acquireDesktopLease('viewer-1')).rejects.toMatchObject({ status: 403 })
      expect(notices).toEqual([])
    } finally {
      window.removeEventListener('hermes-auth-notice', onNotice)
    }
  })
})
