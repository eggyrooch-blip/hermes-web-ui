import { config } from '../../config'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { GatewayRestartDisabledError } from '../../services/hermes/gateway-restart-guard'

function refuseInBrokerMode(ctx: any): boolean {
  if (!config.webuiRunBroker) return false
  const err = new GatewayRestartDisabledError()
  ctx.status = err.status
  ctx.body = { error: err.message, code: err.code }
  return true
}

export async function list(ctx: any) {
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  const gateways = await mgr.listAll()
  ctx.body = { gateways }
}

export async function start(ctx: any) {
  if (refuseInBrokerMode(ctx)) return
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  try {
    const status = await mgr.start(ctx.params.name)
    ctx.body = { success: true, gateway: status }
  } catch (err: any) { ctx.status = 500; ctx.body = { error: err.message } }
}

export async function stop(ctx: any) {
  if (refuseInBrokerMode(ctx)) return
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  try {
    await mgr.stop(ctx.params.name)
    ctx.body = { success: true }
  } catch (err: any) { ctx.status = 500; ctx.body = { error: err.message } }
}

export async function health(ctx: any) {
  const mgr = getGatewayManagerInstance()
  if (!mgr) { ctx.status = 503; ctx.body = { error: 'GatewayManager not initialized' }; return }
  const status = await mgr.detectStatus(ctx.params.name)
  ctx.body = { gateway: status }
}
