import { ref } from 'vue'

/**
 * Copy feedback that lives on the button that was pressed.
 *
 * Copying is the one action with no visible result of its own — nothing on the
 * page changes — so it is the one case where saying nothing at all would be
 * wrong. But it also does not belong in a toast at the edge of the screen: the
 * answer to "did that copy?" belongs on the thing you just clicked, and in a
 * long transcript the button in question may be nowhere near the toast.
 *
 * So the button briefly becomes a tick (or a warning), then goes back. This
 * mirrors what the code-block copy button does with its label — see
 * `flashCopyResult` in chat/highlight.ts — for buttons whose whole content is an
 * icon rather than text.
 *
 * A `key` is required because a transcript has many copy buttons and only the
 * pressed one may react.
 *
 *   const copy = useCopyFeedback()
 *   copy.run('bubble', () => copyToClipboard(text))
 *   // template: copy.state('bubble') === 'ok' ? tick : normal icon
 */
export type CopyState = 'idle' | 'ok' | 'fail'

/** How long the button holds its outcome before returning to rest. */
export const COPY_FEEDBACK_MS = 1600

export function useCopyFeedback() {
  const states = ref<Record<string, CopyState>>({})
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function set(key: string, next: CopyState) {
    states.value = { ...states.value, [key]: next }
  }

  function state(key: string): CopyState {
    return states.value[key] || 'idle'
  }

  /**
   * Run a copy and show its outcome on `key`'s button.
   *
   * Any pending reset for the same key is cleared first, so a second press mid
   * flash re-times the window rather than being cut short by the first one's
   * timer.
   */
  async function run(key: string, copy: () => Promise<boolean>): Promise<boolean> {
    const pending = timers.get(key)
    if (pending) clearTimeout(pending)

    let ok = false
    try {
      ok = await copy()
    } catch {
      ok = false
    }
    set(key, ok ? 'ok' : 'fail')
    timers.set(
      key,
      setTimeout(() => {
        set(key, 'idle')
        timers.delete(key)
      }, COPY_FEEDBACK_MS),
    )
    return ok
  }

  return { state, run }
}
