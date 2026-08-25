import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel session clicks', () => {
  it('allows session model switching for coding agent sessions', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    // The per-row 设置模型 menu entry was cut on the prototype-parity pass; the
    // switching machinery survives behind the composer's model menu.
    expect(source).toContain('await openSessionModelModal(sessionId)')
    expect(source).toContain('isSessionModelScopedCodingAgent')
    expect(source).toContain('!isCodingAgentAuthProvider(group.provider)')
    expect(source).toContain('showSessionModelModeModal')
    expect(source).toContain('pendingSessionModelSwitch')
    expect(source).toContain('chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode)')
    expect(source).not.toContain('header-model-button--readonly')
    expect(source).not.toContain('if (isActiveSessionCodingAgent.value) return')
  })
})
