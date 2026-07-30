import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

describe('ChatPanel session model picker badges', () => {
  it('renders vision / reasoning / default badges from the BFF capability metadata', () => {
    expect(SOURCE).toContain("sessionModelHasCapability(model, group, 'vision')")
    expect(SOURCE).toContain("sessionModelHasCapability(model, group, 'reasoning')")
    expect(SOURCE).toContain('isSessionModelProfileDefault(model, group.provider)')
    expect(SOURCE).toContain("t('models.capabilityVision')")
    expect(SOURCE).toContain("t('models.capabilityReasoning')")
    expect(SOURCE).toContain("t('models.defaultModelTooltip')")
    // Badges are their own flex cells, so the model name keeps its ellipsis row.
    expect(SOURCE).toContain('.session-model-badge-cap')
  })

  it('reads capabilities out of model_meta instead of re-deriving them client-side', () => {
    expect(SOURCE).toContain('group.model_meta?.[model]?.capabilities?.includes(capability)')
  })
})

describe('ChatPanel cross-family switch notice', () => {
  it('toasts on the BFF decision instead of keeping its own memory-only once-per-session state', () => {
    expect(SOURCE).toContain('if (res.familySwitchNotice)')
    expect(SOURCE).toContain('message.info(t("chat.modelFamilySwitchNotice")')
    // The decision and its one-shot marker live on the session row, so a
    // remount or a page reload cannot make the notice fire twice.
    expect(SOURCE).not.toContain('familySwitchNoticedSessions')
    expect(SOURCE).not.toContain('shouldNoticeFamilySwitch')
  })

  it('leaves the model switch itself unguarded — notice only, no confirm dialog', () => {
    const applyBlock = SOURCE.slice(
      SOURCE.indexOf('async function applySessionModelSwitch'),
      SOURCE.indexOf('async function selectSessionModel'),
    )
    expect(applyBlock).toContain('chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode)')
    expect(applyBlock).not.toContain('return false')
    expect(applyBlock).not.toMatch(/confirm|dialog/i)
  })

  it('stars the default through the store so the aggregate-fallback path keeps its ⭐', () => {
    expect(SOURCE).toContain('appStore.isProfileDefaultModel(sessionModelProfile.value, model, provider)')
  })
})
