<script setup lang="ts">
/**
 * Icon-only action button (30x30, 14px glyph) with the four states.
 *
 * Only the glyph and its colour change across states; the size never does, so a
 * card corner or table row does not reflow mid-action.
 *
 * ⚠️ `fail` does NOT tint the ground. This button lives on the corner of a card
 * or in a table row, and giving it a pale red ground says "there is something
 * wrong with this card" — whereas what went wrong is the press just now. Failure
 * is carried by the warning glyph, the danger colour, and a title that says to
 * press again.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import KpIcon from './KpIcon.vue'
import { useAction, type ActionConfig } from './useAction'

const props = withDefaults(
  defineProps<{
    run: () => Promise<unknown>
    /** Resting glyph. */
    icon: string
    /** Tooltip / accessible name for the resting state. */
    title: string
    /** Shown when the press succeeded. */
    okIcon?: string
    /**
     * Tooltip for the failed state. Defaults to the shared "didn't work, press
     * again" line, which is what the prototype uses for every one of these —
     * the button says only that the press did not take, never why.
     */
    failTitle?: string
    /**
     * Resting glyph colour. The default is the prototype's ActionIcon spec.
     * Row affordances that already exist at `--fg-aux` pass their own so the
     * resting look does not shift when they gain the four states.
     */
    idleColor?: string
    optimistic?: () => void
    rollback?: () => void
    done?: () => void
    noOk?: boolean
    size?: number
    box?: number
    /** The 1px hairline ring. Off when the button sits inside another outline. */
    ring?: boolean
    disabled?: boolean
  }>(),
  { okIcon: 'line_check', size: 14, box: 30, ring: true, idleColor: 'var(--fg-secondary)' },
)

const { t } = useI18n()
const [state, run] = useAction()

const glyph = computed(() => {
  if (state.value === 'pending') return 'full_loading_circle'
  if (state.value === 'ok') return props.okIcon
  if (state.value === 'fail') return 'full_warning'
  return props.icon
})

const colour = computed(() => {
  if (state.value === 'fail') return 'var(--danger)'
  if (state.value === 'ok') return 'var(--keep-green)'
  return props.idleColor
})

const label = computed(() =>
  state.value === 'fail' ? (props.failTitle ?? t('common.retryHint')) : props.title,
)

function onClick(event: MouseEvent) {
  event.stopPropagation()
  run({
    run: props.run,
    optimistic: props.optimistic,
    rollback: props.rollback,
    done: props.done,
    noOk: props.noOk,
  } as ActionConfig)
}
</script>

<template>
  <button
    class="ab kp-action-icon"
    type="button"
    :class="{ 'has-ring': ring }"
    :style="{ width: `${box}px`, height: `${box}px` }"
    :title="label"
    :aria-label="label"
    :disabled="disabled || state === 'pending'"
    @click="onClick"
  >
    <KpIcon
      :name="glyph"
      :size="size"
      :color="colour"
      :class="{ spin: state === 'pending' }"
    />
  </button>
</template>

<style scoped lang="scss">
.kp-action-icon {
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--r-pill);
  // No ground in any state — see the note about not tinting on failure.
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;

  &:disabled {
    // Not dimmed while pending: dimmed reads as broken, and it is working.
    cursor: default;
  }
}

// Controls take a 1px hairline; the 0.5px step is for cards.
.kp-action-icon.has-ring {
  box-shadow: inset 0 0 0 1px var(--divider);
}
</style>
