import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// 推理强度 IS a user-facing choice (sunke 2026-08-21). The new UI briefly
// dropped it on the grounds that the strength should follow the model's agent
// config; that call was reversed, so these assertions pin it back — and pin
// WHERE it lives, because it has moved twice: it started as a standalone
// popselect in ChatInput's tool row, and now belongs to ChatPanel's model menu
// (one pill → one menu → 模型 / 推理强度). The composer tool row must stay as
// the prototype drew it, so the ChatInput assertions below stay negative.
const CHAT_PANEL = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
const CHAT_INPUT = readFileSync('packages/client/src/components/hermes/chat/ChatInput.vue', 'utf8')

describe('reasoning effort is user-selectable from the model menu', () => {
  it('offers the effort options and writes them through the chat store', () => {
    expect(CHAT_PANEL).toContain('reasoningEffortOptions')
    expect(CHAT_PANEL).toContain('onSessionModelReasoningEffortChange')
    expect(CHAT_PANEL).toContain('pickEffortFromMenu')
    expect(CHAT_PANEL).toContain('chatStore.setSessionReasoningEffort(')
    // Labels come from the i18n namespace, not hardcoded strings.
    expect(CHAT_PANEL).toContain('chat.reasoningEffort')
    for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(CHAT_PANEL).toContain(`chat.reasoningEffort.options.${value}`)
    }
  })

  it('carries the 推理强度 row and its flyout in the model menu', () => {
    expect(CHAT_PANEL).toContain('model-menu-effort-row')
    expect(CHAT_PANEL).toContain("keepModelSub('effort')")
    // The menu now has TWO level-2 targets: the model list and the effort list.
    expect(CHAT_PANEL).toContain('const modelMenuSub = ref<null | "model" | "effort">(null);')
    expect(CHAT_PANEL).toContain("keepModelSub('model')")
  })

  it('gates the row on the model actually being able to reason', () => {
    // Keyed off the shared rule table, NOT off the absence of server capability
    // metadata: the payload omits empty capability lists, so "no metadata" is
    // exactly the case the gate exists for.
    expect(CHAT_PANEL).toContain('const sessionModelSupportsReasoning = computed')
    expect(CHAT_PANEL).toContain('modelCapabilities(model).includes("reasoning")')
    expect(CHAT_PANEL).toContain('chat.reasoningEffort.unsupported')
  })

  it('shows the chosen effort on the composer pill', () => {
    expect(CHAT_PANEL).toContain('composer-model-button__effort')
    expect(CHAT_PANEL).toContain('activeSessionEffortLabel')
  })

  it('keeps no SECOND control in the composer tool row', () => {
    // The pill badge above is a readout, not a picker. The old popselect must
    // not come back alongside the menu row — two controls for one setting.
    expect(CHAT_INPUT).not.toContain('reasoning-effort-button')
    expect(CHAT_INPUT).not.toContain('onReasoningEffortChange')
    expect(CHAT_INPUT).not.toContain('currentReasoningEffort')
  })
})
