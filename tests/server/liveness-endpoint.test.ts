import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Lightweight liveness endpoint (`GET /livez`).
 *
 * The probe must answer from a static payload: no Hermes CLI version call, no
 * Agent Bridge readiness probe, no version-check metadata in the body.
 */

const defaultBridgeReadiness = {
  endpoint: 'tcp://127.0.0.1:8123',
  endpointKind: 'tcp',
  status: 'ready',
  reachable: true,
  ready: true,
  running: true,
}

async function loadHealthController() {
  vi.resetModules()
  delete (globalThis as any).__APP_VERSION__

  const getVersion = vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n')
  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion,
  }))

  const checkReadiness = vi.fn().mockResolvedValue(defaultBridgeReadiness)
  const getRuntimeState = vi.fn(() => ({ endpoint: defaultBridgeReadiness.endpoint }))
  const getAgentBridgeManager = vi.fn(() => ({ checkReadiness, getRuntimeState }))
  vi.doMock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
    getAgentBridgeManager,
  }))

  const health = await import('../../packages/server/src/controllers/health')

  return { ...health, getVersion, getAgentBridgeManager, checkReadiness }
}

function createMockCtx() {
  return { body: null as any }
}

describe('liveness controller', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns a static ok response without probing Hermes or Agent Bridge', async () => {
    const { livenessCheck, getVersion, getAgentBridgeManager } = await loadHealthController()
    const ctx = createMockCtx()

    livenessCheck(ctx)

    expect(ctx.body).toEqual({ status: 'ok' })
    expect(getVersion).not.toHaveBeenCalled()
    expect(getAgentBridgeManager).not.toHaveBeenCalled()
  })

  it('does not expose any version field', async () => {
    const { livenessCheck } = await loadHealthController()
    const ctx = createMockCtx()

    livenessCheck(ctx)

    expect(Object.keys(ctx.body)).toEqual(['status'])
    expect(JSON.stringify(ctx.body)).not.toMatch(/version/i)
  })

  it('is synchronous so the probe never awaits an upstream call', async () => {
    const { livenessCheck } = await loadHealthController()
    const ctx = createMockCtx()

    const result = livenessCheck(ctx)

    expect(result).toBeUndefined()
    expect(ctx.body).toEqual({ status: 'ok' })
  })
})

describe('liveness route registration', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('registers GET /livez on the public health router', async () => {
    vi.resetModules()
    const { healthRoutes } = await import('../../packages/server/src/routes/health')

    const livez = healthRoutes.stack.find(layer => layer.path === '/livez')

    expect(livez).toBeTruthy()
    expect(livez!.methods).toContain('GET')
  })
})
