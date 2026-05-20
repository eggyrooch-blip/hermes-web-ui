import type { HermesProfile } from '@/api/hermes/profiles'

export function profileModelMap(profiles: Pick<HermesProfile, 'name' | 'model'>[]): Map<string, string> {
  return new Map(
    profiles
      .map(profile => [profile.name, profile.model?.trim() || ''] as const)
      .filter(([, model]) => !!model),
  )
}

export function formatAgentProfileLabel(profileName: string, models: Map<string, string>): string {
  const model = models.get(profileName)
  return model ? `${profileName} · ${model}` : profileName
}

export function formatAgentSenderLabel(
  senderName: string,
  agentProfile: string | undefined,
  models: Map<string, string>,
): string {
  if (!agentProfile) return senderName
  const model = models.get(agentProfile)
  return model ? `${senderName} · ${model}` : senderName
}
