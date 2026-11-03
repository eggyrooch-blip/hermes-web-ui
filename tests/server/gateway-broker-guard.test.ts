import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hermes-agent 0.21.4 keeps one gateway per host. In Run Broker mode that host
// gateway is the MT router, so every WebUI entry that would stop/start a gateway
// must refuse before spawning anything.

const { mockExecHermesWithBin, mockSpawnHermesWithBin, mockStartGatewayRunManaged, mockRetireManagedGateway } = vi.hoisted(() => ({
  mockExecHermesWithBin: vi.fn(),
  mockSpawnHermesWithBin: vi.fn(),
  mockStartGatewayRunManaged: vi.fn(() => ({ pid: 4242 })),
  mockRetireManagedGateway: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  resolveHermesInvocation: (bin: string) => ({ command: bin, argsPrefix: [] }),
  execHermesWithBin: mockExecHermesWithBin,
  execHermes: vi.fn(),
  spawnHermesWithBin: mockSpawnHermesWithBin,
  spawnHermes: vi.fn(),
  resolveHermesBin: () => 'hermes',
}))

vi.mock('../../packages/server/src/services/hermes/gateway-runner', () => ({
  startGatewayRunManaged: mockStartGatewayRunManaged,
  retireManagedGatewayForProfile: mockRetireManagedGateway,
}))

const originalEnv = { ...process.env }
let hermesHome = ''

async function loadAutostart(broker: boolean) {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = hermesHome
  if (broker) process.env.HERMES_WEBUI_RUN_BROKER = '1'
  else delete process.env.HERMES_WEBUI_RUN_BROKER
  return import('../../packages/server/src/services/hermes/gateway-autostart')
}

async function loadGatewaysController(broker: boolean) {
  vi.resetModules()
  if (broker) process.env.HERMES_WEBUI_RUN_BROKER = '1'
  else delete process.env.HERMES_WEBUI_RUN_BROKER
  return import('../../packages/server/src/controllers/hermes/gateways')
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockExecHermesWithBin.mockReset()
  hermesHome = await mkdtemp(join(tmpdir(), 'hwui-gateway-broker-guard-'))
  await mkdir(join(hermesHome, 'profiles', 'research'), { recursive: true })
})

afterEach(async () => {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (hermesHome) await rm(hermesHome, { recursive: true, force: true })
  hermesHome = ''
})

describe('restartGatewayForProfile in Run Broker mode', () => {
  it('refuses with a Chinese MT-router message and spawns no gateway command', async () => {
    const { restartGatewayForProfile } = await loadAutostart(true)
    const { GATEWAY_RESTART_DISABLED_CODE } = await import('../../packages/server/src/services/hermes/gateway-restart-guard')

    const err: any = await restartGatewayForProfile('research').catch(e => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(GATEWAY_RESTART_DISABLED_CODE)
    expect(err.status).toBe(409)
    expect(err.message).toBe('Run Broker 模式下 WebUI 不再启停 Hermes gateway，以免影响 MT router；请重启 MT router 使改动生效。')
    expect(mockExecHermesWithBin).not.toHaveBeenCalled()
    expect(mockSpawnHermesWithBin).not.toHaveBeenCalled()
    expect(mockStartGatewayRunManaged).not.toHaveBeenCalled()
  })

  it('still stops and starts the profile gateway outside broker mode', async () => {
    mockExecHermesWithBin.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'profile') return { stdout: '', stderr: '' }
      return { stdout: 'Gateway is running', stderr: '' }
    })
    const { restartGatewayForProfile } = await loadAutostart(false)

    await expect(restartGatewayForProfile('research')).resolves.toEqual({ running: true, profile: 'research' })

    const argvs = mockExecHermesWithBin.mock.calls.map(call => (call[1] as string[]).join(' '))
    expect(argvs).toContain('gateway stop')
    const started = mockStartGatewayRunManaged.mock.calls.length > 0 || argvs.includes('gateway start')
    expect(started).toBe(true)
  })
})

describe('prepareGatewayForProfileDelete in Run Broker mode', () => {
  it('marks the profile stopped but never runs `gateway stop`', async () => {
    const { prepareGatewayForProfileDelete } = await loadAutostart(true)

    await expect(prepareGatewayForProfileDelete('research')).resolves.toBeUndefined()

    expect(mockExecHermesWithBin).not.toHaveBeenCalled()
    expect(mockSpawnHermesWithBin).not.toHaveBeenCalled()
    const state = JSON.parse(await readFile(join(hermesHome, 'profiles', 'research', 'gateway_state.json'), 'utf-8'))
    expect(state.desired_state).toBe('stopped')
  })

  it('still runs `gateway stop` outside broker mode', async () => {
    mockExecHermesWithBin.mockResolvedValue({ stdout: '', stderr: '' })
    const { prepareGatewayForProfileDelete } = await loadAutostart(false)

    await prepareGatewayForProfileDelete('research')

    const argvs = mockExecHermesWithBin.mock.calls.map(call => (call[1] as string[]).join(' '))
    expect(argvs).toContain('gateway stop')
  })
})

describe('GatewayManager start/stop routes in Run Broker mode', () => {
  function makeCtx(): any {
    return { params: { name: 'research' }, status: 200, body: undefined }
  }

  it.each(['start', 'stop'] as const)('%s returns 409 with the MT-router message', async (action) => {
    const ctrl = await loadGatewaysController(true)
    const ctx = makeCtx()

    await ctrl[action](ctx)

    expect(ctx.status).toBe(409)
    expect(ctx.body.code).toBe('GATEWAY_RESTART_DISABLED_IN_BROKER_MODE')
    expect(ctx.body.error).toBe('Run Broker 模式下 WebUI 不再启停 Hermes gateway，以免影响 MT router；请重启 MT router 使改动生效。')
  })

  it.each(['start', 'stop'] as const)('%s keeps the existing 503 outside broker mode', async (action) => {
    const ctrl = await loadGatewaysController(false)
    const ctx = makeCtx()

    await ctrl[action](ctx)

    expect(ctx.status).toBe(503)
    expect(ctx.body).toEqual({ error: 'GatewayManager not initialized' })
  })
})
