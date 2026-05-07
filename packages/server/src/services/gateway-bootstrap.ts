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
  const { GatewayManager } = await import('./hermes/gateway-manager')
  const { getActiveProfileName } = await import('./hermes/hermes-profile')
  const activeProfile = getActiveProfileName()
  gatewayManager = new GatewayManager(activeProfile)

  await gatewayManager.detectAllOnStartup()
  const autostartMode = resolveGatewayAutostartMode()
  if (autostartMode === 'none') {
    console.log('[bootstrap] gateway autostart disabled')
    return
  }
  if (autostartMode === 'active') {
    await gatewayManager.start(activeProfile)
    console.log('[bootstrap] active gateway started')
    return
  }
  await gatewayManager.startAll()
  console.log('[bootstrap] all gateways started')
}
