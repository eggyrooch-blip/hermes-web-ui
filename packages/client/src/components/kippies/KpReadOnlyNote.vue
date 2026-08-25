<script setup lang="ts">
/**
 * "This is not available here" — a disabled button with a permanent note beside
 * it, instead of an enabled button that toasts an apology when pressed.
 *
 * The sites this replaces used to be: press → a line appears saying the thing
 * cannot be done. That is using an acknowledgement to fake feedback — nothing
 * actually happened, the toast only apologised for it, and the next press has to
 * apologise again. The information is the same either way, but here it is
 * present before the press, so nobody has to click the wrong thing once to find
 * out they cannot click it.
 *
 * Use it for genuinely unavailable actions. For actions that CAN fail, use
 * KpActionBtn — failure belongs on the button, not in a note.
 */
import KpBtn from './KpBtn.vue'

withDefaults(
  defineProps<{
    /** Why it is unavailable. Stays on screen — this is the whole point. */
    hint: string
    kind?: InstanceType<typeof KpBtn>['$props']['kind']
    size?: InstanceType<typeof KpBtn>['$props']['size']
    icon?: string
  }>(),
  { kind: 'ghost', size: 's' },
)
</script>

<template>
  <span class="kp-readonly-note">
    <span class="kp-readonly-note__hint">{{ hint }}</span>
    <KpBtn :kind="kind" :size="size" :icon="icon" disabled>
      <slot />
    </KpBtn>
  </span>
</template>

<style scoped lang="scss">
.kp-readonly-note {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  // Wraps because these sit in right-aligned action slots where the hint plus
  // the button can exceed a narrow column.
  flex-wrap: wrap;
  justify-content: flex-end;
}

.kp-readonly-note__hint {
  color: var(--fg-disabled);
  white-space: nowrap;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
}
</style>
