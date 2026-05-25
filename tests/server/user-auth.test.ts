import { beforeEach, describe, expect, it, vi } from 'vitest'

const getRequestProfileMock = vi.fn()

vi.mock('../../packages/server/src/services/request-context', () => ({
  getRequestProfile: getRequestProfileMock,
}))

describe('Hermes user-auth middleware adapter', () => {
  beforeEach(() => {
    getRequestProfileMock.mockReset()
  })

  it('exposes upstream-style user and profile state from the Feishu request context', async () => {
    getRequestProfileMock.mockReturnValue('feishu_group_alpha')
    const { populateHermesUserProfile } = await import('../../packages/server/src/middleware/user-auth')
    const next = vi.fn(async () => {})
    const ctx: any = {
      state: {
        user: {
          openid: 'ou_user_a',
          profile: 'user_a',
          role: 'user',
          name: 'user_a',
        },
      },
      get: vi.fn(),
      query: {},
      request: { body: {} },
    }

    await populateHermesUserProfile(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(getRequestProfileMock).toHaveBeenCalledWith(ctx)
    expect(ctx.state.user).toMatchObject({
      id: 'ou_user_a',
      username: 'user_a',
      role: 'user',
      openid: 'ou_user_a',
      profile: 'user_a',
      profiles: ['user_a'],
    })
    expect(ctx.state.profile).toEqual({ name: 'feishu_group_alpha' })
  })

  it('does not trust a raw requested profile when request-context falls back to the signed profile', async () => {
    getRequestProfileMock.mockReturnValue('user_a')
    const { populateHermesUserProfile } = await import('../../packages/server/src/middleware/user-auth')
    const next = vi.fn(async () => {})
    const ctx: any = {
      state: {
        user: {
          openid: 'ou_user_a',
          profile: 'user_a',
          role: 'user',
        },
      },
      get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'feishu_group_other' : '',
      query: {},
      request: { body: {} },
    }

    await populateHermesUserProfile(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.state.profile).toEqual({ name: 'user_a' })
  })

  it('leaves unauthenticated token-mode requests compatible with existing auth-disabled behavior', async () => {
    getRequestProfileMock.mockReturnValue('default')
    const { populateHermesUserProfile } = await import('../../packages/server/src/middleware/user-auth')
    const next = vi.fn(async () => {})
    const ctx: any = {
      state: {},
      get: vi.fn(() => ''),
      query: {},
      request: { body: {} },
    }

    await populateHermesUserProfile(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.state.user).toBeUndefined()
    expect(ctx.state.profile).toEqual({ name: 'default' })
  })
})
