import { computed, ref } from 'vue'

/**
 * Network reachability — ONE truth for the whole app.
 *
 * It drives three things, none of which is a popup:
 *   · an extra row at the bottom of the sidebar (absent entirely when online)
 *   · the composer's cloud pill flipping to "offline"
 *   · a live run reporting "reconnecting" instead of silently stalling
 *
 * That way "why did this fail" is stated in one place rather than repeated by
 * every button.
 *
 * The prototype reads `navigator.onLine` alone (plus a demo toggle). Here that is
 * only half the answer: this app talks to a Hermes gateway, and the far more
 * common failure is "the laptop has WiFi but the gateway is unreachable". So both
 * have to hold — the browser believing it has a network, AND our /health poll
 * getting through.
 *
 * ⚠️ Gateway health is PUSHED IN (`reportGatewayHealth`), not read out of the app
 * store. Importing the store here would be the natural shape, but the store
 * transitively pulls `@/api/client` → `@/router`, so every leaf component that
 * shows network state would drag the router into its module graph — which broke
 * 29 tests that mock `vue-router` without `createRouter`. Inverting it keeps this
 * composable dependency-free and trivially testable.
 *
 * ⚠️ Module-level state on purpose: the sidebar row, the pill and the run screen
 * have to agree. Per-caller refs would give each consumer its own listeners and
 * let them disagree mid-transition.
 */

const browserOnline = ref(typeof navigator === 'undefined' || navigator.onLine !== false)

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => (browserOnline.value = true))
  window.addEventListener('offline', () => (browserOnline.value = false))
}

const gatewayReachable = ref(true)
/**
 * Until the first health poll resolves, "unreachable" and "not asked yet" are the
 * same value. Without this guard every cold boot would announce itself offline for
 * the duration of the first poll.
 */
const gatewayProbed = ref(false)

/** Called by the app store's health poll — the only writer. */
export function reportGatewayHealth(reachable: boolean) {
  gatewayReachable.value = reachable
  gatewayProbed.value = true
}

const online = computed(
  () => browserOnline.value && (!gatewayProbed.value || gatewayReachable.value),
)

/** Which side is down — the sidebar row words itself differently for each. */
const reason = computed<'none' | 'browser' | 'gateway'>(() => {
  if (!browserOnline.value) return 'browser'
  if (gatewayProbed.value && !gatewayReachable.value) return 'gateway'
  return 'none'
})

export function useNet() {
  return { online, reason }
}

/** Test seam — resets the module state between cases. */
export function __resetNetForTests() {
  browserOnline.value = typeof navigator === 'undefined' || navigator.onLine !== false
  gatewayReachable.value = true
  gatewayProbed.value = false
}
