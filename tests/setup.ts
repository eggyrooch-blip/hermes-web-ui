import { vi } from 'vitest'

// Vite injects this at build time; unit tests need a stable fallback.
;(globalThis as any).__APP_VERSION__ = 'test'

// --- vi.waitFor 的默认预算（CI flaky 根治点之一）------------------------------
// vitest 给 vi.waitFor 的默认超时是 1000ms。开发机上够，CI runner 上不够：本仓有
// 188 处不带 timeout 的 vi.waitFor，其中不少在等真 git / node-pty 子进程落地文件或
// 触发 mock —— 机器一忙，1 秒就到期。表现就是"每条流水线红的文件和子用例都不一样"
// （2026-08-06 连续三条 MR 流水线 + main 自己的 #536039，全是超时、零断言失败）。
// 这里只抬"调用方没显式指定超时"的那一档；显式写了 timeout 的原样尊重，因为那通常
// 是用例特意钉死的语义。
// ponytail: 代价是真卡住的用例要多等 15s 才报红。想更快就去给那个调用点写显式
// timeout，别把这个默认值再往下调 —— 调下来就等于把 flaky 还回来。
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15_000
const originalWaitFor = vi.waitFor.bind(vi)
;(vi as any).waitFor = (callback: any, options?: any) => {
  if (options === undefined) return originalWaitFor(callback, { timeout: DEFAULT_WAIT_FOR_TIMEOUT_MS })
  // 数字形式就是调用方显式给的超时，不碰。
  if (typeof options === 'number') return originalWaitFor(callback, options)
  return originalWaitFor(callback, { ...options, timeout: options.timeout ?? DEFAULT_WAIT_FOR_TIMEOUT_MS })
}
const originalWaitUntil = vi.waitUntil.bind(vi)
;(vi as any).waitUntil = (callback: any, options?: any) => {
  if (options === undefined) return originalWaitUntil(callback, { timeout: DEFAULT_WAIT_FOR_TIMEOUT_MS })
  if (typeof options === 'number') return originalWaitUntil(callback, options)
  return originalWaitUntil(callback, { ...options, timeout: options.timeout ?? DEFAULT_WAIT_FOR_TIMEOUT_MS })
}
// Client-only setup (window/localStorage only exist in jsdom)
if (typeof window !== 'undefined') {
  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })

  // Mock localStorage
  const store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value }),
      removeItem: vi.fn((key: string) => { delete store[key] }),
      clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k] }),
      get length() { return Object.keys(store).length },
      key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
    },
  })
}
