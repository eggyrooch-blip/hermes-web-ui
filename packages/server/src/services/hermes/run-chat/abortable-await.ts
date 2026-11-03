export function awaitWithAbortSignal<T>(promise: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      value => finish(() => resolve(value)),
      err => finish(() => reject(err)),
    )
  })
}

export function awaitWithTimeoutAndAbortSignal<T>(
  promise: PromiseLike<T> | T,
  ms: number,
  message: string,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    const timer = setTimeout(() => finish(() => reject(new Error(message))), ms)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      value => finish(() => resolve(value)),
      err => finish(() => reject(err)),
    )
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}
