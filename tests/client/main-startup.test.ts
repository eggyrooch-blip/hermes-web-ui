// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mountMock = vi.hoisted(() => vi.fn())
const useMock = vi.hoisted(() => vi.fn(() => ({ use: useMock, mount: mountMock })))
const isReadyMock = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {})))

vi.mock('vue', () => ({
  createApp: vi.fn(() => ({ use: useMock, mount: mountMock })),
}))

vi.mock('pinia', () => ({
  createPinia: vi.fn(() => ({ install: vi.fn() })),
}))

vi.mock('@/router', () => ({
  default: {
    isReady: isReadyMock,
    install: vi.fn(),
  },
}))

vi.mock('@/i18n', () => ({
  i18n: {
    install: vi.fn(),
  },
}))

vi.mock('@/App.vue', () => ({
  default: {},
}))

describe('client startup', () => {
  beforeEach(() => {
    vi.resetModules()
    mountMock.mockClear()
    useMock.mockClear()
    isReadyMock.mockClear()
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
  })

  it('mounts the shell even while initial router navigation is still pending', async () => {
    await import('@/main')

    expect(isReadyMock).toHaveBeenCalled()
    expect(mountMock).toHaveBeenCalledWith('#app')
  })
})
