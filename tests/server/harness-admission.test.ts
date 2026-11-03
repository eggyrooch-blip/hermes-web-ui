import { writeFileSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isHarnessEnabledForProfile } from '../../packages/server/src/services/hermes/harness-admission'

describe('Harness runtime admission', () => {
  const readyFile = `/tmp/hermes-harness-admission-${process.pid}.ready`
  const revision = 'a'.repeat(40)

  beforeEach(() => {
    process.env.HERMES_WEBUI_HARNESS_SOURCE_REV = revision
    process.env.HERMES_WEBUI_HARNESS_READY_FILE = readyFile
    writeFileSync(readyFile, `${revision}\n`)
  })

  afterEach(() => {
    delete process.env.HERMES_WEBUI_HARNESS_ENABLED
    delete process.env.HERMES_WEBUI_HARNESS_PROFILES
    delete process.env.HERMES_WEBUI_HARNESS_SOURCE_REV
    delete process.env.HERMES_WEBUI_HARNESS_READY_FILE
    rmSync(readyFile, { force: true })
  })

  it('is visible to every trusted profile when runtime readiness is healthy', () => {
    process.env.HERMES_WEBUI_HARNESS_ENABLED = '1'
    process.env.HERMES_WEBUI_HARNESS_PROFILES = 'sunke'

    expect(isHarnessEnabledForProfile('sunke')).toBe(true)
    expect(isHarnessEnabledForProfile('another-profile')).toBe(true)
  })

  it('ignores the legacy profile allowlist', () => {
    process.env.HERMES_WEBUI_HARNESS_ENABLED = '1'
    process.env.HERMES_WEBUI_HARNESS_PROFILES = 'sunke'
    expect(isHarnessEnabledForProfile('zhaozhiguang')).toBe(true)
  })

  it('denies a missing or stale readiness marker', () => {
    process.env.HERMES_WEBUI_HARNESS_ENABLED = '1'
    process.env.HERMES_WEBUI_HARNESS_PROFILES = 'sunke'
    rmSync(readyFile)
    expect(isHarnessEnabledForProfile('sunke')).toBe(false)
  })

  it('denies a profile when the global switch is off', () => {
    process.env.HERMES_WEBUI_HARNESS_PROFILES = 'sunke'
    expect(isHarnessEnabledForProfile('sunke')).toBe(false)
  })
})
