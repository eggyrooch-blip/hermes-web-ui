import { existsSync } from 'fs'
import { join } from 'path'
import { safeFileStore } from '../safe-file-store'
import { getProfileDir } from './hermes-profile'
import { validateProfileName, validateText } from './hermes-cli'

export function applyDefaultModelConfig(
  config: Record<string, any>,
  model: string,
  provider?: string,
): Record<string, any> {
  const existingModel = typeof config.model === 'object' && config.model !== null ? config.model : {}
  return {
    ...config,
    model: {
      ...existingModel,
      ...(provider ? { provider } : {}),
      default: model,
    },
  }
}

export async function setProfileDefaultModel(profileName: string, model: string, provider?: string): Promise<void> {
  const safeProfileName = validateProfileName(profileName)
  const safeModel = validateText(model.trim(), 'model', 256)
  const safeProvider = provider ? validateText(provider.trim(), 'provider', 128) : undefined
  if (!safeModel) return

  const profileDir = getProfileDir(safeProfileName)
  if (safeProfileName !== 'default' && !profileDir.endsWith(join('profiles', safeProfileName))) {
    throw new Error(`Profile "${safeProfileName}" directory not found`)
  }
  if (!existsSync(profileDir)) {
    throw new Error(`Profile "${safeProfileName}" directory not found`)
  }

  await safeFileStore.updateYaml(
    join(profileDir, 'config.yaml'),
    config => applyDefaultModelConfig(config, safeModel, safeProvider),
    { backup: true },
  )
}
