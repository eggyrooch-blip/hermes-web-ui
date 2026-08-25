<script setup lang="ts">
/**
 * A KpBtn that owns its own action state.
 *
 * The pattern this replaces, which the app had ~450 of:
 *
 *   onClick={() => { await save(); showSavedToast() }}
 *
 * becomes:
 *
 *   <KpActionBtn :run="save" :ok-label="t('common.saved')" :fail-label="…">
 *
 * The point is not brevity. A toast puts the answer at the other end of the
 * screen and leaves the user to match it up with the press they just made — and
 * in a long list, the row that failed may well have scrolled out of view by
 * then. Success and failure now live on the button that caused them.
 *
 * Each button holds its own `useAction()`, so the call site is one element and
 * pages do not hoist a pile of hooks at the top.
 *
 * Failure STAYS on the button — pressing again is the retry. It never
 * self-clears, because a failure that disappears on a timer is a failure the
 * user may never have seen.
 */
import KpBtn from './KpBtn.vue'
import { useAction, type ActionConfig } from './useAction'

const props = defineProps<{
  /** The real work. Rejecting is what puts the button into `fail`. */
  run: () => Promise<unknown>
  okLabel?: string
  failLabel?: string
  /** Apply the result up front; pair with `rollback`. */
  optimistic?: () => void
  /** Undo `optimistic` on failure — the half nobody writes. */
  rollback?: () => void
  /** After `run` resolves, before `ok` shows. */
  done?: () => void
  /** When `ok` expires and the button returns to `idle`. */
  flip?: () => void
  /** Skip `ok` — for when success makes this whole view disappear. */
  noOk?: boolean
  kind?: InstanceType<typeof KpBtn>['$props']['kind']
  size?: InstanceType<typeof KpBtn>['$props']['size']
  icon?: string
  iconEnd?: string
  disabled?: boolean
  full?: boolean
}>()

const [state, run] = useAction()

function onClick(event: MouseEvent) {
  // Rows and cards are usually clickable themselves, and a button sitting on
  // one must not also trigger it.
  event.stopPropagation()
  run({
    run: props.run,
    optimistic: props.optimistic,
    rollback: props.rollback,
    done: props.done,
    flip: props.flip,
    noOk: props.noOk,
  } as ActionConfig)
}
</script>

<template>
  <KpBtn
    :kind="kind"
    :size="size"
    :icon="icon"
    :icon-end="iconEnd"
    :disabled="disabled"
    :full="full"
    :state="state"
    :ok-label="okLabel"
    :fail-label="failLabel"
    @click="onClick"
  >
    <slot />
  </KpBtn>
</template>
