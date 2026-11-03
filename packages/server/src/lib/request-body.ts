const REJECTED_REQUEST_DRAIN_TIMEOUT_MS = 2 * 60 * 1000

export function nonDestroyingRequestBody(req: any): any {
  return typeof req?.iterator === 'function'
    ? req.iterator({ destroyOnReturn: false })
    : req
}

export function drainRejectedRequest(req: any): Promise<void> {
  if (!req || typeof req.resume !== 'function' || req.readableEnded || req.destroyed) return Promise.resolve()
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer)
      req.off?.('end', finish)
      req.off?.('close', finish)
      req.off?.('error', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      req.destroy?.()
      finish()
    }, REJECTED_REQUEST_DRAIN_TIMEOUT_MS)
    timer.unref?.()
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', finish)
    req.resume()
  })
}
