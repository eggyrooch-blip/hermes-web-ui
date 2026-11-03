import { describe, expect, it } from 'vitest'
import { parseProfileListRuntimeInfo } from '../../packages/server/src/services/hermes/profile-list-parser'

describe('profile list parser', () => {
  it('parses gateway status when profile or model fills the table column', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
  daily_assistant deepseek-v4-flash            running      —            —
  long_model      provider/model-name-that-fills-column stopped      —            —
`
    const info = parseProfileListRuntimeInfo(output, ['daily_assistant', 'long_model'])

    expect(info.get('daily_assistant')).toMatchObject({ active: false, gatewayStatus: 'running' })
    expect(info.get('long_model')).toMatchObject({ active: false, gatewayStatus: 'stopped' })
  })

  it('matches the longest profile name first when names share a prefix', () => {
    const output = `
 Profile          Model                        Gateway      Alias
 ───────────────    ───────────────────────────    ───────────    ───────────
 ◆agent           claude-sonnet                running      —
  agent_long      claude-sonnet                stopped      worker
`
    const info = parseProfileListRuntimeInfo(output, ['agent', 'agent_long'])

    expect(info.get('agent')).toMatchObject({ active: true, gatewayStatus: 'running' })
    expect(info.get('agent_long')).toMatchObject({ active: false, gatewayStatus: 'stopped', alias: 'worker' })
  })
})
