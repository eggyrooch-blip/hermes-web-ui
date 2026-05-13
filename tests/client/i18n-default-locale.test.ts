// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('i18n default locale', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('forces Chinese on startup even when the browser or saved locale is English', async () => {
    localStorage.setItem('hermes_locale', 'en')
    Object.defineProperty(window.navigator, 'language', {
      value: 'en-US',
      configurable: true,
    })

    const { i18n } = await import('@/i18n')

    expect(i18n.global.locale.value).toBe('zh')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
  })
})
