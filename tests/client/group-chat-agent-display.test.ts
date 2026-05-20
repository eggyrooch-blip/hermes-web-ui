import { describe, expect, it } from 'vitest'
import { formatAgentProfileLabel, formatAgentSenderLabel, profileModelMap } from '@/components/hermes/group-chat/agent-display'

describe('group chat agent display helpers', () => {
  it('adds the profile model to agent labels when metadata is available', () => {
    const models = profileModelMap([
      { name: 'coder', active: false, model: 'glm-5.1', gateway: '', alias: '' },
    ])

    expect(formatAgentProfileLabel('coder', models)).toBe('coder · glm-5.1')
  })

  it('falls back to the profile name when the model is missing', () => {
    expect(formatAgentProfileLabel('legacy', new Map())).toBe('legacy')
  })

  it('adds the model to agent message sender labels', () => {
    const models = new Map([['coder', 'glm-5.1']])

    expect(formatAgentSenderLabel('Alice', 'coder', models)).toBe('Alice · glm-5.1')
  })
})
