import { onScopeDispose, ref, type Ref } from 'vue'

export type ActionState = 'idle' | 'pending' | 'ok' | 'fail'

export interface ActionConfig<T = unknown> {
  /** The real work. Its rejection is what puts the button into `fail`. */
  run: () => Promise<T>
  /** Apply the result to the UI up front, before `run` settles. */
  optimistic?: () => void
  /** Undo `optimistic`. Called on rejection — the half nobody ever writes. */
  rollback?: () => void
  /** Ran after `run` resolves, before the `ok` state shows. */
  done?: (value: T) => void
  /** Ran when `ok` expires and the button returns to `idle`. */
  flip?: () => void
  /**
   * Skip the `ok` state. Use it when success means this whole view disappears:
   * sitting on "已加载" while the page still says "没能加载出来" contradicts
   * itself.
   */
  noOk?: boolean
}

/** How long the `ok` state holds before flipping back to `idle`. */
export const ACTION_OK_MS = 1600

/**
 * Bridge for the API functions that report failure by RETURNING `false` instead
 * of rejecting — a large part of this codebase's client layer (`renameSession`,
 * `setSessionWorkspace`, …), where the fetch is already caught inside and the
 * boolean is the verdict.
 *
 * `useAction` derives `fail` from a rejection, so those need converting or the
 * button would flash `ok` on a failed call. Wrap them:
 *
 *   :run="() => expectOk(renameSession(id, title))"
 *
 * ⚠️ Only for functions whose `false` MEANS failure. An API where `false` is a
 * legitimate result (a predicate, "no updates available") must not be wrapped —
 * that would report a successful answer as a failed action.
 */
export async function expectOk<T>(work: Promise<T>): Promise<T> {
  const value = await work
  if (value === false || value === null || value === undefined) {
    throw new Error('action reported failure')
  }
  return value
}

/**
 * The other failure convention in this client: resolving with `{ ok, error }`
 * (the MCP, devices and provider endpoints). The object is always truthy, so
 * `expectOk` cannot see the failure — this reads the flag and promotes the
 * server's own `error` string into the rejection, which is what a caller wants
 * to show when there is somewhere to show it.
 */
export async function unwrapOk<T extends { ok?: boolean; error?: string }>(
  work: Promise<T>,
  fallback?: string,
): Promise<T> {
  const res = await work
  if (!res.ok) throw new Error(res.error || fallback || 'action reported failure')
  return res
}

/**
 * One action's four states — pending, optimistic update, rollback on failure,
 * and staying in failure so the next press is the retry.
 *
 * The pattern this replaces is `mutate()` followed by a success toast, which has
 * neither a pending state (against a real endpoint those 300ms–3s are simply
 * blank, and nothing stops a double-click from firing twice) nor a rollback
 * (the other half of an optimistic update, without which the UI claims the
 * thing installed when it did not).
 *
 * Usage — note the labels come from the caller's own i18n keys; the example
 * spells them as placeholders rather than real `t(...)` calls so the
 * i18n-coverage test does not read this comment as live key usage:
 *
 *   const [state, run] = useAction()
 *   <KpBtn :state="state" :ok-label="OK_LABEL" :fail-label="FAIL_LABEL"
 *          @click="run({ run: () => api.install(id),
 *                        optimistic: () => rows.push(id),
 *                        rollback: () => rows.pop() })">
 *     {{ IDLE_LABEL }}
 *   </KpBtn>
 */
export function useAction(): [Ref<ActionState>, <T>(cfg: ActionConfig<T>) => void] {
  const state = ref<ActionState>('idle')
  // A ref, not `state === 'pending'`: the guard has to hold from the synchronous
  // instant of the click, and a reactive read can still be the previous value
  // within the same tick.
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  onScopeDispose(clear)

  function run<T>(cfg: ActionConfig<T>) {
    if (busy) return
    busy = true
    clear()
    state.value = 'pending'
    cfg.optimistic?.()

    cfg
      .run()
      .then((value) => {
        busy = false
        cfg.done?.(value)
        if (cfg.noOk) {
          state.value = 'idle'
          return
        }
        state.value = 'ok'
        timer = setTimeout(() => {
          cfg.flip?.()
          state.value = 'idle'
        }, ACTION_OK_MS)
      })
      .catch(() => {
        busy = false
        cfg.rollback?.()
        // Stays here. Pressing again is the retry.
        state.value = 'fail'
      })
  }

  return [state, run]
}
