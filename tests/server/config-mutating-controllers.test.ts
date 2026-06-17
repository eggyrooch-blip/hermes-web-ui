import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  pinSkill: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: vi.fn(),
}))

vi.mock('../../packages/server/src/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/schemas', () => ({
  MODEL_CONTEXT_TABLE: 'model_context',
}))

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadModelsController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/models')
}

async function loadSkillsController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/skills')
}

async function loadConfigController(env: Record<string, string> = {}) {
  vi.resetModules()
  process.env = {
    ...process.env,
    HERMES_HOME: hermesHome,
    HERMES_WEB_PLANE: 'chat',
    HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    ...env,
  }
  return import('../../packages/server/src/controllers/hermes/config')
}

function makeCtx(body: unknown): any {
  return {
    request: { body },
    status: 200,
    body: undefined,
    query: {},
    params: {},
    state: {},
    get: vi.fn(() => ''),
  }
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-controller-'))
  tempHomes.push(hermesHome)
  await mkdir(hermesHome, { recursive: true })
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  hermesHome = ''
})

describe('config mutating controllers', () => {
  it('setConfigModel updates only the model section and preserves existing config', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'terminal:',
      '  backend: local',
      'model:',
      '  default: old',
      '  provider: old-provider',
      '',
    ].join('\n'), 'utf-8')
    const { setConfigModel } = await loadModelsController()
    const ctx = makeCtx({ default: 'glm-5.1', provider: 'custom:glm' })

    await setConfigModel(ctx)

    expect(ctx.body).toEqual({ success: true })
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({ default: 'glm-5.1', provider: 'custom:glm' })
    expect(config.terminal.backend).toBe('local')
  })

  it('setConfigModel uses the requested profile header when auth has not populated state.profile', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: root-model\n', 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), 'model:\n  default: old-research\n', 'utf-8')
    const { setConfigModel } = await loadModelsController()
    const ctx = makeCtx({ default: 'research-model', provider: 'deepseek' })
    ctx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'research' : '')

    await setConfigModel(ctx)

    expect(ctx.body).toEqual({ success: true })
    const rootConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(rootConfig.model.default).toBe('root-model')
    expect(researchConfig.model).toEqual({ default: 'research-model', provider: 'deepseek' })
  })

  it('skill toggle preserves unrelated config while adding and removing disabled skills', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: glm-5.1',
      'skills:',
      '  disabled:',
      '    - old-skill',
      '',
    ].join('\n'), 'utf-8')
    const { toggle } = await loadSkillsController()

    await toggle(makeCtx({ name: 'new-skill', enabled: false }))
    await toggle(makeCtx({ name: 'old-skill', enabled: true }))

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model.default).toBe('glm-5.1')
    expect(config.skills.disabled).toEqual(['new-skill'])
  })

  it('chat-plane config exposes and writes only employee-visible settings sections', async () => {
    const employeeDir = join(hermesHome, 'profiles', 'employee')
    await mkdir(employeeDir, { recursive: true })
    await writeFile(join(employeeDir, 'config.yaml'), [
      'display:',
      '  compact: false',
      'session_reset:',
      '  enabled: true',
      'privacy:',
      '  redact_pii: true',
      'agent:',
      '  skip_confirmations: true',
      'memory:',
      '  enabled: true',
      'approvals:',
      '  mode: auto',
      '',
    ].join('\n'), 'utf-8')

    const { getConfig, updateConfig } = await loadConfigController()
    const baseCtx = makeCtx({})
    baseCtx.state.user = { openid: 'ou_employee', profile: 'employee', role: 'user' }

    await getConfig(baseCtx)

    expect(baseCtx.body).toEqual({
      display: { compact: false },
      session_reset: { enabled: true },
      privacy: { redact_pii: true },
    })

    const agentReadCtx = makeCtx({})
    agentReadCtx.query = { section: 'agent' }
    agentReadCtx.state.user = baseCtx.state.user

    await getConfig(agentReadCtx)

    expect(agentReadCtx.status).toBe(403)

    const agentWriteCtx = makeCtx({ section: 'agent', values: { skip_confirmations: false } })
    agentWriteCtx.state.user = baseCtx.state.user

    await updateConfig(agentWriteCtx)

    expect(agentWriteCtx.status).toBe(403)
    const config = YAML.load(await readFile(join(employeeDir, 'config.yaml'), 'utf-8')) as any
    expect(config.agent.skip_confirmations).toBe(true)
  })
})
