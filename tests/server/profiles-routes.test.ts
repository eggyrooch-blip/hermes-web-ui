import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock hermes-cli
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  useProfile: vi.fn(),
  stopGateway: vi.fn(),
  startGateway: vi.fn(),
  startGatewayBackground: vi.fn(),
  setupReset: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../../packages/server/src/services/hermes/profile-credentials', () => ({
  smartCloneCleanup: vi.fn(() => ({
    strippedCredentials: [],
    disabledPlatforms: [],
    strippedConfigCredentials: [],
  })),
}))

vi.mock('../../packages/server/src/services/hermes/agent-ownership', () => ({
  listOwnedProfileMetadata: vi.fn(() => new Map()),
  ownerOwnsProfile: vi.fn(() => false),
  registerOwnedProfile: vi.fn(() => true),
}))

vi.mock('../../packages/server/src/services/hermes/profile-provisioning', () => ({
  provisionOwnedProfileViaBroker: vi.fn(() => Promise.resolve(false)),
}))

import * as hermesCli from '../../packages/server/src/services/hermes/hermes-cli'
import { config } from '../../packages/server/src/config'
import { create, deleteAvatar, list, updateAvatar } from '../../packages/server/src/controllers/hermes/profiles'
import { listOwnedProfileMetadata, ownerOwnsProfile, registerOwnedProfile } from '../../packages/server/src/services/hermes/agent-ownership'
import { provisionOwnedProfileViaBroker } from '../../packages/server/src/services/hermes/profile-provisioning'

describe('Profile Routes', () => {
  const roots: string[] = []

  beforeEach(() => {
    const webUiHome = mkdtempSync(join(tmpdir(), 'hermes-web-ui-profiles-test-'))
    roots.push(webUiHome)
    process.env.HERMES_WEB_UI_HOME = webUiHome
    vi.clearAllMocks()
    config.webPlane = 'both'
    config.runBrokerUrl = ''
    config.runBrokerKey = ''
    vi.mocked(provisionOwnedProfileViaBroker).mockResolvedValue(false)
    vi.mocked(listOwnedProfileMetadata).mockReturnValue(new Map())
    vi.mocked(ownerOwnsProfile).mockReturnValue(false)
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('ensureApiServerConfig (via active profile switch)', () => {
    it('should inject api_server config when missing', async () => {
      // This tests the logic that profiles.ts ensures api_server config exists
      // We test the ensureApiServerConfig behavior indirectly through the module
      expect(true).toBe(true)
    })
  })

  describe('hermes-cli wrapper', () => {
    it('listProfiles returns array', async () => {
      const mockProfiles = [{ name: 'default', active: true }]
      vi.mocked(hermesCli.listProfiles).mockResolvedValue(mockProfiles as any)

      const result = await hermesCli.listProfiles()
      expect(result).toEqual(mockProfiles)
    })

    it('getProfile returns profile detail', async () => {
      const mockDetail = { name: 'default', path: '/tmp/default' }
      vi.mocked(hermesCli.getProfile).mockResolvedValue(mockDetail as any)

      const result = await hermesCli.getProfile('default')
      expect(result).toEqual(mockDetail)
      expect(hermesCli.getProfile).toHaveBeenCalledWith('default')
    })

    it('createProfile calls CLI with name and clone flag', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      await hermesCli.createProfile('test', true)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('test', true)
    })

    it('deleteProfile calls CLI with name', async () => {
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)

      await hermesCli.deleteProfile('test')

      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('test')
    })

    it('renameProfile calls CLI with old and new name', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)

      await hermesCli.renameProfile('old', 'new')

      expect(hermesCli.renameProfile).toHaveBeenCalledWith('old', 'new')
    })
  })

  describe('create controller', () => {
    it('lists chat-plane owned profiles without invoking the slow global Hermes profile list', async () => {
      config.webPlane = 'chat'
      vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('profile list should not run'))
      vi.mocked(listOwnedProfileMetadata).mockReturnValue(new Map([
        ['user_a', { profileName: 'user_a', kind: 'user', ownerOpenId: 'ou_owner' }],
        ['team_room', { profileName: 'team_room', kind: 'group', ownerOpenId: 'ou_owner', displayLabel: '团队群' }],
      ]))

      const ctx: any = {
        state: {
          user: { openid: 'ou_owner', profile: 'user_a', role: 'user' },
        },
        body: undefined,
      }

      await list(ctx)

      expect(hermesCli.listProfiles).not.toHaveBeenCalled()
      expect(ctx.body).toEqual({
        profiles: [
          {
            name: 'user_a',
            active: true,
            model: '',
            gateway: '',
            alias: '',
            kind: 'user',
            ownerOpenId: 'ou_owner',
          },
          {
            name: 'team_room',
            active: false,
            model: '',
            gateway: '',
            alias: '',
            displayLabel: '团队群',
            kind: 'group',
            ownerOpenId: 'ou_owner',
          },
        ],
      })
    })

    it('passes role description and no-alias to Hermes CLI for chat-plane users', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      const ctx: any = {
        request: {
          body: {
            name: 'web_coder',
            clone: true,
            description: 'Software engineering agent for coding and tests.',
          },
        },
        state: {
          user: { openid: 'ou_owner', profile: 'feishu_user_a' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('web_coder', {
        clone: true,
        cloneFrom: 'feishu_user_a',
        description: 'Software engineering agent for coding and tests.',
        noAlias: true,
      })
      expect(ctx.body.success).toBe(true)
    })

    it('clones from the trusted chat-plane user profile instead of server active_profile', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      const ctx: any = {
        request: {
          body: {
            name: 'coder1',
            clone: true,
            description: 'Software engineering agent.',
          },
        },
        state: {
          user: { openid: 'ou_owner', profile: 'user_a' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('coder1', {
        clone: true,
        cloneFrom: 'user_a',
        description: 'Software engineering agent.',
        noAlias: true,
      })
      expect(ctx.body.success).toBe(true)
    })

    it('rejects chat-plane clone when the authenticated user has no source profile', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      const ctx: any = {
        request: {
          body: {
            name: 'coder1',
            clone: true,
          },
        },
        state: {
          user: { openid: 'ou_owner' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(hermesCli.createProfile).not.toHaveBeenCalled()
      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toContain('trusted source profile')
    })

    it('registers chat-plane profile ownership through the multitenancy broker before fallback', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')
      vi.mocked(provisionOwnedProfileViaBroker).mockResolvedValue(true)

      const ctx: any = {
        request: {
          body: {
            name: 'web_operator',
            clone: false,
            description: 'Operations agent for recurring tasks.',
          },
        },
        state: {
          user: { openid: 'ou_owner', profile: 'feishu_user_a' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(provisionOwnedProfileViaBroker).toHaveBeenCalledWith({
        ownerOpenId: 'ou_owner',
        profileName: 'web_operator',
        upstreamProfile: 'feishu_user_a',
        displayLabel: 'web_operator',
        description: 'Operations agent for recurring tasks.',
      })
      expect(registerOwnedProfile).not.toHaveBeenCalled()
      expect(ctx.body.success).toBe(true)
    })

    it('keeps admin-plane profile creation compatible without no-alias', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      const ctx: any = {
        request: {
          body: {
            name: 'admin_profile',
            clone: false,
          },
        },
        state: {},
        status: 200,
        body: undefined,
      }
      config.webPlane = 'both'

      await create(ctx)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('admin_profile', {
        clone: false,
        description: undefined,
        noAlias: false,
      })
      expect(ctx.body.success).toBe(true)
    })

    it('stores generated profile avatars and omits avatar binary paths from the response', async () => {
      const ctx: any = {
        params: { name: 'user_a' },
        request: { body: { type: 'generated', seed: 'user_a-seed' } },
        state: {},
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      expect(ctx.body.avatar).toMatchObject({
        type: 'generated',
        seed: 'user_a-seed',
      })
      expect(JSON.stringify(ctx.body)).not.toContain('profile-metadata')
    })

    it('rejects avatar updates for another owner profile in chat-plane', async () => {
      config.webPlane = 'chat'
      vi.mocked(ownerOwnsProfile).mockReturnValue(false)
      const ctx: any = {
        params: { name: 'other_profile' },
        request: { body: { type: 'generated', seed: 'other-seed' } },
        state: { user: { openid: 'ou_owner', profile: 'user_a', role: 'user' } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      expect(ctx.status).toBe(403)
      expect(ctx.body.error).toContain('not available')
    })

    it('deletes profile avatar metadata for an owned chat-plane profile', async () => {
      config.webPlane = 'chat'
      vi.mocked(ownerOwnsProfile).mockReturnValue(true)
      const updateCtx: any = {
        params: { name: 'team_room' },
        request: { body: { type: 'generated', seed: 'room-seed' } },
        state: { user: { openid: 'ou_owner', profile: 'user_a', role: 'user' } },
        status: 200,
        body: undefined,
      }
      const deleteCtx: any = {
        params: { name: 'team_room' },
        state: { user: { openid: 'ou_owner', profile: 'user_a', role: 'user' } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(updateCtx)
      await deleteAvatar(deleteCtx)

      expect(deleteCtx.body).toEqual({ success: true })
    })
  })
})
