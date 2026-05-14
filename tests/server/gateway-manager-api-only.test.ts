import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { config } from '../../packages/server/src/config'
import { GatewayManager } from '../../packages/server/src/services/hermes/gateway-manager'

describe('GatewayManager API-only lifecycle', () => {
  const originalConfig = {
    webPlane: config.webPlane,
    webuiRunBroker: config.webuiRunBroker,
    webuiJobsBroker: config.webuiJobsBroker,
  }

  afterEach(() => {
    config.webPlane = originalConfig.webPlane
    config.webuiRunBroker = originalConfig.webuiRunBroker
    config.webuiJobsBroker = originalConfig.webuiJobsBroker
    vi.unstubAllEnvs()
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

  it('blocks API-only gateway startup in chat broker mode', async () => {
    config.webPlane = 'chat'
    config.webuiRunBroker = true
    config.webuiJobsBroker = true
    vi.stubEnv('HERMES_WEBUI_ALLOW_API_ONLY_GATEWAYS', '')

    const manager = new GatewayManager('default') as any
    manager.resolvePort = vi.fn().mockRejectedValue(new Error('resolvePort should not be called'))

    await expect(manager.startApiOnly('zhanglina')).rejects.toThrow(
      'API-only gateways are disabled in chat broker mode',
    )
    expect(manager.resolvePort).not.toHaveBeenCalled()
  })

  it('writes API-only configs with Hermes Agent readable fallback providers', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hermes-gateway-manager-'))
    try {
      const sourceDir = join(tmp, 'profiles', 'g41a5b5g')
      const runtimeDir = join(tmp, 'api-gateways', 'g41a5b5g')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'config.yaml'), yaml.dump({
        model: {
          default: 'zai/glm-5.1',
          provider: 'zai',
        },
        fallback: [
          'openrouter/anthropic/claude-3.5-haiku:beta',
          'openrouter/google/gemini-2.0-flash-exp:free',
        ],
      }), 'utf-8')

      const manager = new GatewayManager('default') as any
      manager.profileDir = vi.fn(() => sourceDir)
      manager.apiOnlyDir = vi.fn(() => runtimeDir)

      manager.prepareApiOnlyHome('g41a5b5g', 8656, '127.0.0.1')

      const runtimeConfig = yaml.load(readFileSync(join(runtimeDir, 'config.yaml'), 'utf-8')) as any
      expect(runtimeConfig.fallback_providers).toEqual([
        { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku:beta' },
        { provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free' },
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
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
