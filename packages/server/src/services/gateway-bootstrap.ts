let gatewayManager: any = null
type GatewayAutostartMode = 'all' | 'active' | 'none'

export function getGatewayManagerInstance(): any {
  return gatewayManager
}

export function resolveGatewayAutostartMode(): GatewayAutostartMode {
  const raw = (process.env.GATEWAY_AUTOSTART || 'all').trim().toLowerCase()
  if (raw === 'none' || raw === 'false' || raw === '0') return 'none'
  if (raw === 'active') return 'active'
  return 'all'
}

export async function initGatewayManager(): Promise<void> {
  // The local GatewayManager was removed: this fork routes all gateway/run
  // traffic through the external run broker and never spawns a local Hermes
  // gateway process. Initialization is therefore a no-op; getGatewayManagerInstance()
  // stays null and the /api/hermes/gateways controller returns its existing
  // 503 "GatewayManager not initialized" response.
  console.log('[bootstrap] local gateway manager disabled (external run broker)')
}
