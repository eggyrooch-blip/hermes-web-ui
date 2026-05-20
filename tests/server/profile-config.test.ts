import { describe, expect, it } from 'vitest'
import { applyDefaultModelConfig } from '../../packages/server/src/services/hermes/profile-config'

describe('profile config helpers', () => {
  it('preserves existing model config while setting the new default model', () => {
    const config = applyDefaultModelConfig({
      model: {
        provider: 'openai',
        default: 'gpt-4.1',
        temperature: 0.2,
      },
      platforms: { feishu: { enabled: false } },
    }, 'glm-5.1', 'zai')

    expect(config).toEqual({
      model: {
        provider: 'zai',
        default: 'glm-5.1',
        temperature: 0.2,
      },
      platforms: { feishu: { enabled: false } },
    })
  })
})
