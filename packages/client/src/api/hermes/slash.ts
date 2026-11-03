import { request } from '../client'

export interface SlashCommand {
  name: string
  slash: string
  title: string
  description: string
  source: string
  type: string
  category: string
}

export interface SlashCommandsResponse {
  ok: boolean
  commands: SlashCommand[]
  broker?: {
    ok: boolean
    profile_name?: string
    error?: string
  }
}

export function fetchSlashCommands(profile?: string): Promise<SlashCommandsResponse> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  const query = params.toString()
  return request<SlashCommandsResponse>(`/api/hermes/slash/commands${query ? `?${query}` : ''}`)
}
