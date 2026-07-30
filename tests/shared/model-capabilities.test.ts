import { describe, expect, it } from 'vitest'

import {
  familyOf,
  isCrossFamilySwitch,
  modelCapabilities,
  shouldNoticeFamilySwitch,
  withModelCapabilities,
} from '../../packages/server/src/shared/model-capabilities'

describe('model capability table', () => {
  it('maps every documented model-name pattern', () => {
    expect(modelCapabilities('claude-sonnet-5')).toEqual(['vision', 'reasoning'])
    expect(modelCapabilities('claude-opus-4-1')).toEqual(['vision', 'reasoning'])
    expect(modelCapabilities('gpt-5.6-terra')).toEqual(['reasoning'])
    expect(modelCapabilities('gpt-4o-mini')).toEqual(['reasoning'])
    expect(modelCapabilities('glm-5v-turbo')).toEqual(['vision'])
    expect(modelCapabilities('glm-4v')).toEqual(['vision'])
    expect(modelCapabilities('glm-4.6')).toEqual(['reasoning'])
    expect(modelCapabilities('glm-4.6-preview')).toEqual(['reasoning'])
  })

  it('returns no capabilities for unknown models', () => {
    expect(modelCapabilities('deepseek-v4-flash')).toEqual([])
    expect(modelCapabilities('tencent-sonnet-4-6')).toEqual([])
    expect(modelCapabilities('')).toEqual([])
    expect(modelCapabilities(undefined as unknown as string)).toEqual([])
  })

  it('matches on the bare model name behind a provider prefix', () => {
    expect(modelCapabilities('anthropic/claude-sonnet-5')).toEqual(['vision', 'reasoning'])
    expect(modelCapabilities('custom:litellm-sre/gpt-5.6-terra')).toEqual(['reasoning'])
    expect(modelCapabilities('custom:litellm-sre/tencent-sonnet-4-6')).toEqual([])
  })

  it('never hands out a shared mutable capability array', () => {
    const first = modelCapabilities('claude-sonnet-5')
    first.pop()
    expect(modelCapabilities('claude-sonnet-5')).toEqual(['vision', 'reasoning'])
  })
})

describe('familyOf', () => {
  it('takes the leading segment of the bare model name', () => {
    expect(familyOf('claude-sonnet-5')).toBe('claude')
    expect(familyOf('gpt-5.6-terra')).toBe('gpt')
    expect(familyOf('glm-5v-turbo')).toBe('glm')
    expect(familyOf('anthropic/claude-sonnet-5')).toBe('claude')
    expect(familyOf('custom:litellm-sre/tencent-sonnet-4-6')).toBe('tencent')
    expect(familyOf('CLAUDE-Sonnet-5')).toBe('claude')
  })

  it('returns an empty family for empty input', () => {
    expect(familyOf('')).toBe('')
    expect(familyOf('   ')).toBe('')
    expect(familyOf(undefined as unknown as string)).toBe('')
  })

  it('detects cross-family switches only between two known families', () => {
    expect(isCrossFamilySwitch('glm-4.6', 'claude-sonnet-5')).toBe(true)
    expect(isCrossFamilySwitch('claude-sonnet-5', 'claude-opus-4-1')).toBe(false)
    expect(isCrossFamilySwitch('', 'claude-sonnet-5')).toBe(false)
    expect(isCrossFamilySwitch('claude-sonnet-5', '')).toBe(false)
  })
})

describe('shouldNoticeFamilySwitch', () => {
  const crossFamily = { previousModel: 'glm-4.6', nextModel: 'claude-sonnet-5' }

  it('fires once for a cross-family switch in a session that has history', () => {
    expect(shouldNoticeFamilySwitch({ ...crossFamily, messageCount: 4, alreadyNoticed: false })).toBe(true)
    expect(shouldNoticeFamilySwitch({ ...crossFamily, messageCount: 4, alreadyNoticed: true })).toBe(false)
  })

  it('stays silent without history', () => {
    expect(shouldNoticeFamilySwitch({ ...crossFamily, messageCount: 0, alreadyNoticed: false })).toBe(false)
  })

  it('stays silent within the same family', () => {
    expect(shouldNoticeFamilySwitch({
      previousModel: 'claude-sonnet-5',
      nextModel: 'claude-opus-4-1',
      messageCount: 9,
      alreadyNoticed: false,
    })).toBe(false)
  })
})

describe('withModelCapabilities', () => {
  it('annotates model_meta without touching other group fields', () => {
    const groups = [{
      provider: 'custom:litellm-sre',
      label: 'LiteLLM SRE',
      base_url: 'https://litellm.example/v1',
      api_key: '',
      models: ['claude-sonnet-5', 'deepseek-v4-flash'],
      model_meta: { 'claude-sonnet-5': { alias: 'Claude' } } as Record<string, { alias?: string; capabilities?: string[] }>,
    }]

    const annotated = withModelCapabilities(groups as any)

    expect(annotated[0].model_meta).toEqual({
      'claude-sonnet-5': { alias: 'Claude', capabilities: ['vision', 'reasoning'] },
    })
    expect(annotated[0].models).toEqual(groups[0].models)
    expect(annotated[0].provider).toBe('custom:litellm-sre')
    expect(annotated[0].base_url).toBe('https://litellm.example/v1')
  })

  it('leaves a group untouched when no model matches a rule', () => {
    const group = { provider: 'deepseek', models: ['deepseek-v4-flash'] }

    const annotated = withModelCapabilities([group] as any)

    expect(annotated[0]).toBe(group)
    expect(annotated[0].model_meta).toBeUndefined()
  })
})
