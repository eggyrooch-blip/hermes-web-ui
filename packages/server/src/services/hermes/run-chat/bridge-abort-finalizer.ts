import type { SessionState } from './types'

type BridgeAbortFinalizer = (synced: boolean) => Promise<boolean>

const finalizers = new WeakMap<SessionState, BridgeAbortFinalizer>()

export function registerBridgeAbortFinalizer(state: SessionState, finalizer: BridgeAbortFinalizer): void {
  finalizers.set(state, finalizer)
}

export function unregisterBridgeAbortFinalizer(state: SessionState, finalizer?: BridgeAbortFinalizer): void {
  if (!finalizer || finalizers.get(state) === finalizer) finalizers.delete(state)
}

export async function finalizeBridgeAbort(state: SessionState, synced: boolean): Promise<boolean> {
  const finalizer = finalizers.get(state)
  return finalizer ? finalizer(synced) : false
}
