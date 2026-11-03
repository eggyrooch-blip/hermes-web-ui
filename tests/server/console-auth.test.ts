import { afterEach, describe, expect, it, vi } from 'vitest'

function makeCtx(user?: Record<string, unknown>): any {
  return {
    state: { user },
    status: 200,
    body: null,
  }
}

describe('console auth middleware', () => {
  afterEach(() => {
    vi.doUnmock('../../packages/server/src/services/console-rbac')
    vi.resetModules()
  })

  it('requireConsoleAdmin returns 401 when there is no session openid', async () => {
    vi.doMock('../../packages/server/src/services/console-rbac', () => ({
      resolveConsoleRole: vi.fn(() => 'developer'),
    }))
    const { requireConsoleAdmin } = await import('../../packages/server/src/middleware/console-auth')
    const ctx = makeCtx()
    const next = vi.fn(async () => {})

    await requireConsoleAdmin(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('requireConsoleAdmin returns 404 for a logged-in non-admin', async () => {
    vi.doMock('../../packages/server/src/services/console-rbac', () => ({
      resolveConsoleRole: vi.fn(() => 'developer'),
    }))
    const { requireConsoleAdmin } = await import('../../packages/server/src/middleware/console-auth')
    const ctx = makeCtx({ openid: 'open-1' })
    const next = vi.fn(async () => {})

    await requireConsoleAdmin(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Not found' })
  })

  it('requireConsoleAdmin calls next for an admin', async () => {
    vi.doMock('../../packages/server/src/services/console-rbac', () => ({
      resolveConsoleRole: vi.fn(() => 'admin'),
    }))
    const { requireConsoleAdmin } = await import('../../packages/server/src/middleware/console-auth')
    const ctx = makeCtx({ openid: 'open-1' })
    const next = vi.fn(async () => {})

    await requireConsoleAdmin(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('requireConsoleUser returns 401 when there is no session openid', async () => {
    const { requireConsoleUser } = await import('../../packages/server/src/middleware/console-auth')
    const ctx = makeCtx()
    const next = vi.fn(async () => {})

    await requireConsoleUser(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('requireConsoleUser calls next when a session openid exists', async () => {
    const { requireConsoleUser } = await import('../../packages/server/src/middleware/console-auth')
    const ctx = makeCtx({ openid: 'open-1' })
    const next = vi.fn(async () => {})

    await requireConsoleUser(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })
})
