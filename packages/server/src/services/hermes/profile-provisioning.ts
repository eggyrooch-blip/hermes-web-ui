import { config } from '../../config'

export interface BrokerProfileProvisionRequest {
  ownerOpenId: string
  profileName: string
  upstreamProfile?: string
  displayLabel?: string
  description?: string
}

export async function provisionOwnedProfileViaBroker(request: BrokerProfileProvisionRequest): Promise<boolean> {
  const brokerUrl = config.runBrokerUrl?.replace(/\/+$/, '')
  if (!brokerUrl) return false

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Owner-Open-Id': request.ownerOpenId,
  }
  if (config.runBrokerKey) headers.Authorization = `Bearer ${config.runBrokerKey}`

  try {
    const response = await fetch(`${brokerUrl}/api/run-broker/profiles`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profile_name: request.profileName,
        upstream_profile: request.upstreamProfile,
        display_label: request.displayLabel || request.profileName,
        description: request.description,
      }),
    })
    if (response.ok) return true
    if (response.status === 404 || response.status === 501) return false
    const text = await response.text().catch(() => '')
    throw new Error(`Run broker profile provisioning failed (${response.status}): ${text || response.statusText}`)
  } catch (err: any) {
    if (err instanceof TypeError) return false
    throw err
  }
}
