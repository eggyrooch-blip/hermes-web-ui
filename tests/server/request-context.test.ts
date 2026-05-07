import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadRequestContext(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  process.env = { ...originalEnv, ...env }
  return import('../../packages/server/src/services/request-context')
}

function mockCtx(path: string, method = 'GET') {
  return {
    path,
    method,
    status: 200,
    body: undefined,
  } as any
}

describe('chat plane access control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('allows model list endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/available-models')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('keeps settings endpoints blocked in chat plane by default', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/config')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
  })

  it('allows settings endpoints in chat plane when explicitly enabled', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    })
    const ctx = mockCtx('/api/hermes/config')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('allows model listing but blocks model config and credential writes in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const allowedModelListCtx = mockCtx('/api/hermes/available-models', 'GET')
    const blockedModelCtx = mockCtx('/api/hermes/config/model', 'PUT')
    const blockedCredentialsCtx = mockCtx('/api/hermes/config/credentials', 'PUT')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(allowedModelListCtx, next)
    await enforcePlaneAccess(blockedModelCtx, next)
    await enforcePlaneAccess(blockedCredentialsCtx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(allowedModelListCtx.status).toBe(200)
    expect(blockedModelCtx.status).toBe(403)
    expect(blockedCredentialsCtx.status).toBe(403)
  })

  it('allows profile memory edits and sandboxed file management in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const memoryCtx = mockCtx('/api/hermes/memory', 'POST')
    const fileCtx = mockCtx('/api/hermes/files/list', 'GET')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(memoryCtx, next)
    await enforcePlaneAccess(fileCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(memoryCtx.status).toBe(200)
    expect(fileCtx.status).toBe(200)
  })

  it('keeps sandboxed file management available when settings are explicitly enabled', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    })
    const ctx = mockCtx('/api/hermes/files/list')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('does not reopen admin surface endpoints through the removed temporary flag', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN: '1',
    })
    const allowed = [
      '/api/hermes/config',
      '/api/hermes/profiles',
      '/api/hermes/gateways',
      '/api/hermes/logs',
      '/api/hermes/channels',
      '/api/hermes/group-chat/rooms',
      '/api/hermes/cron-history',
      '/api/hermes/model-context',
      '/api/hermes/auth/copilot/check-token',
      '/api/hermes/weixin/qrcode',
      '/api/hermes/skills/toggle',
    ]

    for (const path of allowed) {
      const ctx = mockCtx(path, path.includes('toggle') ? 'POST' : 'GET')
      const next = vi.fn(async () => {})

      await enforcePlaneAccess(ctx, next)

      expect(next, path).not.toHaveBeenCalled()
      expect(ctx.status, path).toBe(403)
    }
  })

  it('keeps sandboxed files available even when the removed temporary flag is set', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN: '1',
    })
    const ctx = mockCtx('/api/hermes/files/list')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })
})
