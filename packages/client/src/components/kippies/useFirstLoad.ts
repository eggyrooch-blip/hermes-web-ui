import { onScopeDispose, ref } from 'vue'

/**
 * How long the skeleton is held at minimum.
 *
 * Deliberately short: it has to be seen, but it must not make navigation feel
 * sluggish. It is a *floor*, not a delay — a load that takes longer keeps the
 * skeleton for as long as it needs.
 */
export const FIRST_LOAD_MIN_MS = 380

/**
 * A list page's first paint: skeleton → data, or skeleton → full-page failure.
 *
 * List pages used to render straight into their data. That looks fine against
 * a mock, but against a real endpoint the first stretch is blank.
 *
 * The minimum hold exists so a fast response does not flash the skeleton for
 * one frame — a flash is more distracting than no skeleton at all. The `load`
 * promise and the floor are awaited together, so the skeleton lasts
 * max(FIRST_LOAD_MIN_MS, however long the request took).
 *
 * Call `start()` once from `onMounted`. Do not drive it from a watcher on the
 * route: pages remount on navigation anyway, and a watcher would flash the
 * skeleton on tab switches *within* one page too.
 */
export function useFirstLoad(load: () => Promise<unknown>) {
  const loading = ref(true)
  const failed = ref(false)
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })

  async function start() {
    loading.value = true
    failed.value = false
    const floor = new Promise((res) => setTimeout(res, FIRST_LOAD_MIN_MS))
    try {
      await Promise.all([load(), floor])
      if (disposed) return
      failed.value = false
    } catch {
      if (disposed) return
      failed.value = true
    } finally {
      if (!disposed) loading.value = false
    }
  }

  return { loading, failed, start, retry: start }
}
