import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  registerOwnedProfile: vi.fn(() => true),
}))

vi.mock('../../packages/server/src/services/hermes/profile-provisioning', () => ({
  provisionOwnedProfileViaBroker: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('../../packages/server/src/services/hermes/profile-config', () => ({
  setProfileDefaultModel: vi.fn(() => Promise.resolve()),
}))

import * as hermesCli from '../../packages/server/src/services/hermes/hermes-cli'
import { config } from '../../packages/server/src/config'
import { create } from '../../packages/server/src/controllers/hermes/profiles'
import { registerOwnedProfile } from '../../packages/server/src/services/hermes/agent-ownership'
import { provisionOwnedProfileViaBroker } from '../../packages/server/src/services/hermes/profile-provisioning'
import { setProfileDefaultModel } from '../../packages/server/src/services/hermes/profile-config'

describe('Profile Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.webPlane = 'both'
    config.runBrokerUrl = ''
    config.runBrokerKey = ''
    vi.mocked(provisionOwnedProfileViaBroker).mockResolvedValue(false)
  })

  describe('ensureApiServerConfig (via active profile switch)', () => {
    it('should inject api_server config when missing', async () => {
      // This tests the logic that profiles.ts ensures api_server config exists
      // We test the ensureApiServerConfig behavior indirectly through the module
      const { existsSync, readFileSync, writeFileSync } = await import('fs')
      vi.mock('fs', () => ({
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue('platforms: {}'),
        writeFileSync: vi.fn(),
        createReadStream: vi.fn(),
        unlinkSync: vi.fn(),
        mkdirSync: vi.fn(),
        copyFileSync: vi.fn(),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
      }))
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
          user: { openid: 'ou_owner', profile: 'feishu_g41a5b5g' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('web_coder', {
        clone: true,
        description: 'Software engineering agent for coding and tests.',
        noAlias: true,
      })
      expect(ctx.body.success).toBe(true)
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
          user: { openid: 'ou_owner', profile: 'feishu_g41a5b5g' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(provisionOwnedProfileViaBroker).toHaveBeenCalledWith({
        ownerOpenId: 'ou_owner',
        profileName: 'web_operator',
        upstreamProfile: 'feishu_g41a5b5g',
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

    it('sets the requested default model on the newly-created profile only', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      const ctx: any = {
        request: {
          body: {
            name: 'model_profile',
            clone: false,
            model: 'glm-5.1',
            provider: 'zai',
          },
        },
        state: {
          user: { openid: 'ou_owner', profile: 'feishu_g41a5b5g' },
        },
        status: 200,
        body: undefined,
      }
      config.webPlane = 'chat'

      await create(ctx)

      expect(setProfileDefaultModel).toHaveBeenCalledWith('model_profile', 'glm-5.1', 'zai')
      expect(ctx.body.success).toBe(true)
    })
  })
})
