import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayManager } from '../../packages/server/src/services/hermes/gateway-manager'

describe('GatewayManager API-only lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('binds full profile gateway tools to the profile workspace', () => {
    const manager = new GatewayManager('default') as any
    const hermesHome = '/profiles/g41a5b5g'

    const env = manager.buildProfileEnv(hermesHome)

    expect(env.HERMES_HOME).toBe(hermesHome)
    expect(env.TERMINAL_CWD).toBe('/profiles/g41a5b5g/workspace')
    expect(env.HERMES_WRITE_SAFE_ROOT).toBe('/profiles/g41a5b5g/workspace')
    expect(env.TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE).toBe('true')
  })

  it('binds API-only gateway tools to the runtime profile workspace', () => {
    const manager = new GatewayManager('default') as any
    const runtimeHome = '/runtime/g41a5b5g'

    const env = manager.buildApiOnlyEnv(runtimeHome, 8654, '127.0.0.1')

    expect(env.HERMES_HOME).toBe(runtimeHome)
    expect(env.TERMINAL_CWD).toBe('/runtime/g41a5b5g/workspace')
    expect(env.HERMES_WRITE_SAFE_ROOT).toBe('/runtime/g41a5b5g/workspace')
    expect(env.TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE).toBe('true')
  })

  it('forces terminal config values to the profile workspace', () => {
    const manager = new GatewayManager('default') as any
    const cfg = manager.withProfileWorkspaceConfig({
      terminal: {
        cwd: '/tmp/old',
        docker_mount_cwd_to_workspace: false,
      },
    }, '/runtime/g41a5b5g/workspace')

    expect(cfg.terminal.cwd).toBe('/runtime/g41a5b5g/workspace')
    expect(cfg.terminal.docker_mount_cwd_to_workspace).toBe(true)
  })

  it('starts gateway processes from the same profile workspace used by tools', () => {
    const manager = new GatewayManager('default') as any
    const env = { HERMES_HOME: '/runtime/g41a5b5g' }

    const options = manager.buildGatewayRunOptions(env, '/runtime/g41a5b5g/workspace', 'ignore')

    expect(options.cwd).toBe('/runtime/g41a5b5g/workspace')
    expect(options.env).toBe(env)
    expect(options.detached).toBe(true)
  })

  it('stops only gateways that were started as API-only runtime', async () => {
    const manager = new GatewayManager('default') as any
    manager.gateways.set('g41a5b5g', {
      pid: 424242,
      port: 8654,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:8654',
      mode: 'api-only',
    })
    manager.checkHealth = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const result = await manager.stopApiOnly('g41a5b5g')

    expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM')
    expect(result).toMatchObject({
      profile: 'g41a5b5g',
      running: false,
      status: 'stopped',
    })
    expect(manager.gateways.has('g41a5b5g')).toBe(false)
  })

  it('does not stop a full profile gateway from the API-only control path', async () => {
    const manager = new GatewayManager('default') as any
    manager.gateways.set('g41a5b5g', {
      pid: 424242,
      port: 8654,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:8654',
      mode: 'profile',
    })
    manager.checkHealth = vi.fn().mockResolvedValue(true)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const result = await manager.stopApiOnly('g41a5b5g')

    expect(kill).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      profile: 'g41a5b5g',
      running: true,
      status: 'not_api_only',
    })
    expect(manager.gateways.has('g41a5b5g')).toBe(true)
  })

  it('recovers a detached API-only runtime from its pid file before stopping it', async () => {
    const manager = new GatewayManager('default') as any
    manager.readApiOnlyPidFile = vi.fn(() => 424242)
    manager.isProcessAlive = vi.fn(() => true)
    manager.checkHealth = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const result = await manager.stopApiOnly('g41a5b5g')

    expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM')
    expect(result).toMatchObject({
      profile: 'g41a5b5g',
      running: false,
      status: 'stopped',
    })
    expect(manager.gateways.has('g41a5b5g')).toBe(false)
  })

  it('stops a detached API-only runtime from its pid file even if the current port health check fails', async () => {
    const manager = new GatewayManager('default') as any
    manager.readApiOnlyPidFile = vi.fn(() => 424242)
    manager.isProcessAlive = vi.fn(() => true)
    manager.checkHealth = vi.fn().mockResolvedValue(false)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const result = await manager.stopApiOnly('g41a5b5g')

    expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM')
    expect(result).toMatchObject({
      profile: 'g41a5b5g',
      running: false,
      status: 'stopped',
    })
    expect(manager.gateways.has('g41a5b5g')).toBe(false)
  })
})
