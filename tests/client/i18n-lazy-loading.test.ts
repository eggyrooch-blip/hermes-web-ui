// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('i18n lazy loading', () => {
  afterEach(() => {
    localStorage.removeItem('hermes_locale')
    vi.resetModules()
  })

  it('loads only the initial locale and adds another locale on demand', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()

    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady

    expect(i18n.global.availableLocales).toEqual(['en'])

    await switchLocale('zh')

    expect(i18n.global.availableLocales).toEqual(['en', 'zh'])
    expect(i18n.global.locale.value).toBe('zh')
    expect(document.documentElement.lang).toBe('zh')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
    expect(i18n.global.t('common.cancel')).not.toBe('common.cancel')
  })

  it('loads the English fallback alongside a non-English initial locale', async () => {
    localStorage.setItem('hermes_locale', 'zh')
    vi.resetModules()

    const { i18nReady } = await import('@/i18n')
    const i18n = await i18nReady

    expect(i18n.global.availableLocales.sort()).toEqual(['en', 'zh'])
    expect(i18n.global.locale.value).toBe('zh')
  })

  it('ignores an unsupported locale instead of switching to it', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()

    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady

    await switchLocale('kl')

    expect(i18n.global.locale.value).toBe('en')
    expect(i18n.global.availableLocales).toEqual(['en'])
    expect(localStorage.getItem('hermes_locale')).toBe('en')
  })

  // Regression: main.ts awaits i18nReady before createApp, so a rejected
  // i18nReady is a white screen on every route including login. A missing
  // locale chunk must degrade to English, never block the mount.
  it('still resolves with English when the active locale bundle fails to load', async () => {
    localStorage.setItem('hermes_locale', 'zh')
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.doMock('@/i18n/locales/zh', () => {
      throw new Error('chunk 404')
    })

    const { i18nReady } = await import('@/i18n')
    const i18n = await i18nReady

    expect(i18n.global.availableLocales).toEqual(['en'])
    expect(i18n.global.locale.value).toBe('en')
    expect(i18n.global.t('common.cancel')).not.toBe('common.cancel')
    expect(warn).toHaveBeenCalled()
    // The saved preference survives so a later reload can still reach it.
    expect(localStorage.getItem('hermes_locale')).toBe('zh')

    warn.mockRestore()
    vi.doUnmock('@/i18n/locales/zh')
  })

  it('recovers on a later switch after a failed locale load', async () => {
    localStorage.setItem('hermes_locale', 'zh')
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.doMock('@/i18n/locales/zh', () => {
      throw new Error('chunk 404')
    })

    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady
    expect(i18n.global.locale.value).toBe('en')

    // Network recovers: the failed bundle is no longer memoized, so a retry
    // re-imports it and the switch goes through.
    vi.doUnmock('@/i18n/locales/zh')
    await switchLocale('zh')

    expect(i18n.global.locale.value).toBe('zh')
    expect(i18n.global.availableLocales.sort()).toEqual(['en', 'zh'])
    expect(localStorage.getItem('hermes_locale')).toBe('zh')

    warn.mockRestore()
  })

  it('keeps the current locale when a switch target fails to load', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.doMock('@/i18n/locales/ja', () => {
      throw new Error('chunk 404')
    })

    const { i18nReady, switchLocale } = await import('@/i18n')
    const i18n = await i18nReady

    await expect(switchLocale('ja')).resolves.toBeUndefined()

    expect(i18n.global.locale.value).toBe('en')
    expect(i18n.global.availableLocales).toEqual(['en'])
    expect(localStorage.getItem('hermes_locale')).toBe('en')
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
    vi.doUnmock('@/i18n/locales/ja')
  })

  it.each(['en', 'zh'])('retries English after its first load fails and switching to %s', async (intermediateLocale) => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('@/i18n/locales/en', () => { throw new Error('chunk 404') })
    try {
      const { i18nReady, switchLocale } = await import('@/i18n')
      const i18n = await i18nReady
      expect(i18n.global.t('common.cancel')).toBe('common.cancel')

      vi.doUnmock('@/i18n/locales/en')
      if (intermediateLocale !== 'en') await switchLocale(intermediateLocale)
      await switchLocale('en')

      expect(i18n.global.locale.value).toBe('en')
      expect(i18n.global.t('common.cancel')).toBe('Cancel')
      expect(document.documentElement.lang).toBe('en')
    } finally {
      vi.doUnmock('@/i18n/locales/en')
      warn.mockRestore()
    }
  })

  it('memoizes a locale bundle so switching back does not reload it', async () => {
    localStorage.setItem('hermes_locale', 'en')
    vi.resetModules()

    const { loadLocaleMessages } = await import('@/i18n/messages')

    expect(await loadLocaleMessages('ja')).toBe(await loadLocaleMessages('ja'))
  })
})
