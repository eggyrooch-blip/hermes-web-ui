import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { changelog } from '@/data/changelog'
import { mergeMessagesWithFallback, supportedLocales } from '@/i18n/messages'
import en from '@/i18n/locales/en'
import de from '@/i18n/locales/de'
import es from '@/i18n/locales/es'
import fr from '@/i18n/locales/fr'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import { createI18n } from 'vue-i18n'

const SOURCE_ROOT = join(process.cwd(), 'packages/client/src')

const rawMessages: Record<string, Record<string, unknown>> = {
  en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru,
}

// Runtime i18n now loads locales lazily, so the merged-with-English view that
// used to be exported is rebuilt here for the coverage assertions.
const messages: Record<string, Record<string, unknown>> = {}
for (const [locale, localeMessages] of Object.entries(rawMessages)) {
  messages[locale] = locale === 'en'
    ? localeMessages
    : mergeMessagesWithFallback(en, localeMessages)
}

const allMessages: Record<string, Record<string, unknown>> = { en }

function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(path, files)
    } else if (/\.(ts|vue)$/.test(entry.name) && !path.replace(/\\/g, '/').includes('/i18n/locales/')) {
      files.push(path)
    }
  }
  return files
}

function collectLiteralTranslationKeys(): string[] {
  const keys = new Set<string>()
  const translationCall = /(?:\b|\$)t\(\s*['"]([^'"]+)['"]/g

  for (const file of walkFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(translationCall)) {
      keys.add(match[1])
    }
  }

  for (const entry of changelog) {
    for (const change of entry.changes) {
      keys.add(change)
    }
  }

  return [...keys].sort()
}

function getPath(messages: Record<string, unknown>, key: string): unknown {
  let current: unknown = messages
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function hasPath(messages: Record<string, unknown>, key: string): boolean {
  return typeof getPath(messages, key) !== 'undefined'
}

const SKILLS_USAGE_LOCALIZED_KEYS = [
  'sidebar.skillsUsage',
  'skillsUsage.title',
  'skillsUsage.subtitle',
  'skillsUsage.refresh',
  'skillsUsage.periodSelector',
  'skillsUsage.periodLabel',
  'skillsUsage.summary',
  'skillsUsage.totalActions',
  'skillsUsage.loads',
  'skillsUsage.edits',
  'skillsUsage.distinctSkills',
  'skillsUsage.topSkills',
  'skillsUsage.dailyTrend',
  'skillsUsage.periodSummary',
  'skillsUsage.skill',
  'skillsUsage.share',
  'skillsUsage.lastUsed',
  'skillsUsage.noData',
  'skillsUsage.loadFailed',
  'skillsUsage.otherSkills',
]

const SKILLS_USAGE_COMPACT_LABEL_LIMITS: Record<string, number> = {
  'skillsUsage.totalActions': 12,
  'skillsUsage.loads': 10,
  'skillsUsage.edits': 10,
  'skillsUsage.distinctSkills': 12,
  'skillsUsage.topSkills': 16,
  'skillsUsage.dailyTrend': 16,
  'skillsUsage.skill': 10,
  'skillsUsage.share': 10,
  'skillsUsage.lastUsed': 12,
  'skillsUsage.otherSkills': 16,
}

const APPROVAL_AND_WRITE_GATE_LOCALIZED_KEYS = [
  'chat.approvalAgree',
  'skills.writeApprovalTitle',
  'skills.writeApprovalDescription',
  'skills.writeApprovalEmpty',
  'skills.writeApprovalViewDiff',
  'skills.writeApprovalNoDiff',
  'skills.writeApprovalApprove',
  'skills.writeApprovalReject',
  'skills.writeApprovalPendingMemoryWrite',
  'skills.writeApprovalCurrentFile',
  'skills.writeApprovalPatchOldStringMissing',
  'settings.session.requireAuth',
  'settings.session.memoryWriteApproval',
  'settings.session.skillsWriteApproval',
]

// Figma 连接器卡：撤销按钮 + 确认弹窗的全部文案。2026-09-21 的真机走查把这张卡上的
// 英文当成了"zh 没生效"，实际是整个界面就跑在 en 上（同屏的侧边栏、页头、分组标题
// 一样是英文）。这组断言把两件事一次钉死：键在每个**原始** locale 文件里都在（不是靠
// en 兜底），且非英文 locale 的值真的被译过 —— 只有这样，下次看到英文才能确定是环境
// 而不是词条。
const FIGMA_CONNECTOR_LOCALIZED_KEYS = [
  'skillCredentials.figma.revoke',
  'skillCredentials.figma.revokeConfirm',
  'skillCredentials.figma.revoked',
  'skillCredentials.figma.failed',
  'skillCredentials.figma.cancel',
]

function labelLength(value: unknown): number {
  return typeof value === 'string' ? Array.from(value.replace(/\{[^}]+\}/g, '')).length : Infinity
}

describe('i18n locale coverage', () => {
  const ALLOWED_MISSING_KEYS = new Set([
    'changelog.new_0_5_4_7',
    'chat.sessionNotFound',
  ])

  beforeAll(() => {
    for (const l of supportedLocales) {
      if (l !== 'en' && messages[l]) {
        allMessages[l] = messages[l]
      }
    }
  })

  it('keeps Cowork locale keys aligned and core task copy localized', () => {
    const locales = { de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    const keys = Object.keys(en.cowork).sort()
    for (const [locale, messages] of Object.entries(locales)) {
      expect(Object.keys(messages.cowork).sort(), locale).toEqual(keys)
      for (const key of ['newTask', 'fixedForTask', 'unavailable', 'retry', 'searchResults'] as const) {
        expect(messages.cowork[key], `${locale}.${key}`).not.toBe(en.cowork[key])
      }
    }
  })

  // The two "statically referenced key" tests below read the EFFECTIVE runtime
  // messages, which already merge en as a fallback — so a locale file missing a
  // whole key group still passes there and silently renders English. ru shipped
  // with zero chat.authorization* keys and no test noticed. This one reads the
  // raw locale modules instead. Scoped to the authorization prefix on purpose:
  // a full chat.* parity assertion fails today on 5-17 pre-existing gaps per
  // locale, which is a separate cleanup, not this feature's business.
  it('keeps the inline authorization card keys present in every locale file, not just via English fallback', () => {
    const locales = { de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    const authorizationKeys = (chat: Record<string, unknown>) =>
      Object.keys(chat).filter((key) => key.startsWith('authorization')).sort()
    const expected = authorizationKeys(en.chat as Record<string, unknown>)

    expect(expected.length).toBeGreaterThan(0)
    for (const [locale, localeMessages] of Object.entries(locales)) {
      expect(authorizationKeys(localeMessages.chat as Record<string, unknown>), locale).toEqual(expected)
    }
  })

  // Same reasoning as the authorization test above: the effective-messages
  // tests merge en as a fallback, so a locale missing the whole preview group
  // passes there and quietly renders English mid-panel. This reads the raw
  // locale modules and additionally requires the strings to be translated —
  // a copied English value is the failure it is meant to catch.
  it('ships the office preview strings in every locale file, translated', () => {
    const locales = { de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    const PREVIEW_KEYS = [
      'previewLoading',
      'previewFailed',
      'downloadInstead',
      'previewMimeMismatch',
      'previousPage',
      'nextPage',
      'pageStatus',
      'zoom',
      'pdfPageLimit',
      'worksheet',
      'tableTruncated',
    ] as const

    const englishFiles = en.files as Record<string, unknown>
    for (const key of PREVIEW_KEYS) {
      expect(typeof englishFiles[key], `en.files.${key}`).toBe('string')
    }

    const problems: string[] = []
    for (const [locale, localeMessages] of Object.entries(locales)) {
      const files = localeMessages.files as Record<string, unknown>
      for (const key of PREVIEW_KEYS) {
        const value = files?.[key]
        if (typeof value !== 'string') {
          problems.push(`${locale}.files.${key} missing`)
          continue
        }
        // A handful of these really are identical in the target language;
        // listed per key and per locale so a genuine copy-paste still fails.
        const identicalByDesign: Record<string, readonly string[]> = {
          zoom: ['de', 'es', 'fr', 'pt'],
          pageStatus: ['fr'],
        }
        if (value === englishFiles[key] && !identicalByDesign[key]?.includes(locale)) {
          problems.push(`${locale}.files.${key} still English`)
        }
      }
    }

    expect(problems).toEqual([])
  })

  it('keeps interpolation placeholders intact across the preview strings', () => {
    const locales = { en, de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    for (const [locale, localeMessages] of Object.entries(locales)) {
      const files = localeMessages.files as Record<string, string>
      expect(files.pageStatus, `${locale}.files.pageStatus`).toContain('{page}')
      expect(files.pageStatus, `${locale}.files.pageStatus`).toContain('{total}')
      expect(files.pdfPageLimit, `${locale}.files.pdfPageLimit`).toContain('{count}')
    }
  })

  it('defines every statically referenced translation key in the English source locale', () => {
    const missing = collectLiteralTranslationKeys()
      .filter((key) => !hasPath(en, key))
      .filter((key) => !ALLOWED_MISSING_KEYS.has(key))

    expect(missing).toEqual([])
  })

  it('defines every statically referenced translation key in effective runtime messages', () => {
    const requiredKeys = collectLiteralTranslationKeys()
    const missing = Object.entries(allMessages).flatMap(([locale, localeMessages]) =>
      requiredKeys
        .filter((key) => !hasPath(localeMessages, key))
        .filter((key) => !ALLOWED_MISSING_KEYS.has(key))
        .map((key) => `${locale}: ${key}`),
    )

    expect(missing).toEqual([])
  })

  it('localizes Skills Usage page copy in every non-English locale instead of falling back to English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return SKILLS_USAGE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes approval and write-gate copy in every non-English locale instead of falling back to English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return APPROVAL_AND_WRITE_GATE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })


  it('ships the Figma connector card copy in every locale file, not just via English fallback', () => {
    const locales = { de, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    const missing = Object.entries(locales).flatMap(([locale, localeMessages]) =>
      FIGMA_CONNECTOR_LOCALIZED_KEYS
        .filter((key) => !hasPath(localeMessages as Record<string, unknown>, key))
        .map((key) => `${locale}: ${key}`),
    )

    expect(FIGMA_CONNECTOR_LOCALIZED_KEYS.every((key) => hasPath(en, key))).toBe(true)
    expect(missing).toEqual([])
  })

  it('translates the Figma connector card copy instead of echoing English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return FIGMA_CONNECTOR_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('keeps Skills Usage summary and table labels compact across locales', () => {
    const oversized = Object.entries(messages).flatMap(([locale, localeMessages]) =>
      Object.entries(SKILLS_USAGE_COMPACT_LABEL_LIMITS).flatMap(([key, maxLength]) => {
        const localeValue = getPath(localeMessages, key)
        return labelLength(localeValue) > maxLength
          ? [`${locale}: ${key} (${labelLength(localeValue)} > ${maxLength})`]
          : []
      }),
    )

    expect(oversized).toEqual([])
  })

  it('keeps the coverage scanner rooted in client source files', () => {
    expect(relative(process.cwd(), SOURCE_ROOT)).toBe(join('packages', 'client', 'src'))
  })
})
