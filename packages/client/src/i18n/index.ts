import { createI18n } from 'vue-i18n'
import { loadLocaleMessages, mergeMessagesWithFallback, supportedLocales } from './messages'
import type { LocaleMessages, SupportedLocale } from './messages'

const saved = localStorage.getItem('hermes_locale')

function resolveLocale(saved: string | null): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }

  function normalize(tag: string): SupportedLocale | null {
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) {
      const isTraditional =
        lower.includes('hant') ||
        lower.includes('-tw') ||
        lower.includes('-hk') ||
        lower.includes('-mo')
      return isTraditional ? 'zh-TW' : 'zh'
    }
    const short = tag.slice(0, 2)
    if ((supportedLocales as readonly string[]).includes(tag)) return tag as SupportedLocale
    if ((supportedLocales as readonly string[]).includes(short)) return short as SupportedLocale
    return null
  }

  for (const lang of navigator.languages) {
    const resolved = normalize(lang)
    if (resolved) return resolved
  }

  return 'en'
}

function setHtmlLang(locale: SupportedLocale) {
  document.documentElement.lang = locale
}

const locale = resolveLocale(saved)
setHtmlLang(locale)

// Only the active locale (plus the English fallback) is fetched at boot; the
// other nine bundles stay out of the first-screen payload until switched to.
// A locale chunk can fail to arrive (offline, CDN 404, a stale index.html
// pointing at a purged hash). main.ts awaits this before createApp, so a
// rejection here is a white screen for every route, including login. Never
// reject: degrade to whatever messages did load and mount anyway.
const loadedLocales = new Set<SupportedLocale>()

async function createAppI18n() {
  const englishMessages = await loadLocaleMessages('en').catch((error) => {
    console.warn('[i18n] failed to load the en fallback bundle; starting with empty messages', error)
    return null
  })

  if (englishMessages) loadedLocales.add('en')

  let activeLocale: SupportedLocale = locale
  let initialMessages: Record<string, LocaleMessages> = { en: englishMessages ?? {} }

  if (locale !== 'en') {
    const localeMessages = await loadLocaleMessages(locale).catch((error) => {
      console.warn(`[i18n] failed to load the "${locale}" bundle; falling back to en`, error)
      return null
    })

    if (localeMessages) {
      loadedLocales.add(locale)
      initialMessages = {
        en: englishMessages ?? {},
        [locale]: mergeMessagesWithFallback(englishMessages ?? {}, localeMessages),
      }
    } else {
      // Keep the saved preference in localStorage so a later reload (or an
      // explicit switch once the network recovers) can still reach it.
      activeLocale = 'en'
      setHtmlLang('en')
    }
  }

  return createI18n({
    legacy: false,
    locale: activeLocale,
    fallbackLocale: 'en',
    messages: initialMessages,
  })
}

export const i18nReady = createAppI18n()

let localeSwitchSequence = 0

export async function switchLocale(newLocale: string): Promise<void> {
  if (!(supportedLocales as readonly string[]).includes(newLocale)) return

  const i18n = await i18nReady
  const globalI18n = i18n.global as any
  const nextLocale = newLocale as SupportedLocale
  const sequence = ++localeSwitchSequence
  if (!loadedLocales.has(nextLocale)) {
    // loadLocaleMessages drops its cache entry on failure, so a later retry
    // re-fetches. Swallow the error and keep the current locale rather than
    // leaving the caller with a rejected promise.
    const nextMessages = await loadLocaleMessages(nextLocale).catch((error) => {
      console.warn(`[i18n] failed to load the "${nextLocale}" bundle; keeping the current locale`, error)
      return null
    })
    if (!nextMessages) return
    if (sequence !== localeSwitchSequence) return
    globalI18n.setLocaleMessage(
      nextLocale,
      nextLocale === 'en'
        ? nextMessages
        : mergeMessagesWithFallback(globalI18n.getLocaleMessage('en'), nextMessages),
    )
    loadedLocales.add(nextLocale)
  }

  if (sequence !== localeSwitchSequence) return
  globalI18n.locale.value = nextLocale
  setHtmlLang(nextLocale)
  localStorage.setItem('hermes_locale', nextLocale)
}
