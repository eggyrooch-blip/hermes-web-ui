import { createI18n } from 'vue-i18n'
import { messages } from './messages'

const supportedLocales = ['en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'pt'] as const
type SupportedLocale = (typeof supportedLocales)[number]
const forcedLocale: SupportedLocale = 'zh'

export function resolveLocale(): SupportedLocale {
  localStorage.setItem('hermes_locale', forcedLocale)
  return forcedLocale
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(),
  fallbackLocale: 'zh',
  messages,
})
