// Kept apart from gateway-autostart so controllers can recognise the refusal
// even where tests mock gateway-autostart wholesale.
export const GATEWAY_RESTART_DISABLED_CODE = 'GATEWAY_RESTART_DISABLED_IN_BROKER_MODE'
export const GATEWAY_RESTART_DISABLED_MESSAGE =
  'Run Broker 模式下 WebUI 不再启停 Hermes gateway，以免影响 MT router；请重启 MT router 使改动生效。'

export class GatewayRestartDisabledError extends Error {
  readonly code = GATEWAY_RESTART_DISABLED_CODE
  readonly status = 409
  constructor() {
    super(GATEWAY_RESTART_DISABLED_MESSAGE)
  }
}

export function isGatewayRestartDisabledError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === GATEWAY_RESTART_DISABLED_CODE
}
