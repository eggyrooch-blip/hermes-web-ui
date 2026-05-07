import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readRootPackage() {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    name: string
    version: string
  }
}

async function loadHealthControllerWithoutInjectedVersion() {
  vi.resetModules()
  delete (globalThis as any).__APP_VERSION__

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
    getGatewayManagerInstance: vi.fn(() => ({
      getUpstream: () => 'http://127.0.0.1:9999',
    })),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithInjectedVersion(version: string) {
  vi.resetModules()
  ;(globalThis as any).__APP_VERSION__ = version

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
    getGatewayManagerInstance: vi.fn(() => ({
      getUpstream: () => 'http://127.0.0.1:9999',
    })),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithHermesVersionMock(getVersion: ReturnType<typeof vi.fn>) {
  vi.resetModules()
  ;(globalThis as any).__APP_VERSION__ = 'test'

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion,
  }))

  vi.doMock('../../packages/server/src/services/gateway-bootstrap', () => ({
    getGatewayManagerInstance: vi.fn(() => ({
      getUpstream: () => 'http://127.0.0.1:9999',
    })),
  }))

  return import('../../packages/server/src/controllers/health')
}

function createMockCtx() {
  return {
    body: null as any,
  }
}

describe('health controller version metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = 'test'
  })

  it('reads the root package version in ts-node/dev mode instead of falling back to 0.0.0', async () => {
    const pkg = readRootPackage()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe(pkg.version)
    expect(ctx.body.webui_version).not.toBe('0.0.0')
  })

  it('uses the injected build version when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedVersion('9.9.9-test')
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe('9.9.9-test')
  })

  it('does not expose Web UI latest-version or update-available metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const mod = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    await mod.healthCheck(ctx)

    expect('checkLatestVersion' in mod).toBe(false)
    expect('startVersionCheck' in mod).toBe(false)
    expect(ctx.body).not.toHaveProperty('webui_latest')
    expect(ctx.body).not.toHaveProperty('webui_update_available')
  })

  it('coalesces concurrent Hermes version probes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const getVersion = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'Hermes Agent v0.11.0\n'
    })

    const { healthCheck } = await loadHealthControllerWithHermesVersionMock(getVersion)
    const ctxA = createMockCtx()
    const ctxB = createMockCtx()

    await Promise.all([healthCheck(ctxA), healthCheck(ctxB)])

    expect(getVersion).toHaveBeenCalledTimes(1)
    expect(ctxA.body.version).toBe('v0.11.0')
    expect(ctxB.body.version).toBe('v0.11.0')
  })
})
