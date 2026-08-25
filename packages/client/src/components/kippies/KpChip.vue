<script setup lang="ts">
/** Filter / segment chip. Selected state is an ink fill, not a tint. */
import KpIcon from './KpIcon.vue'

defineProps<{
  icon?: string
  on?: boolean
  tone?: 'green'
}>()

defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button
    class="ab kp-chip"
    :class="[{ 'is-on': on }, tone ? `kp-chip--${tone}` : '']"
    @click="$emit('click', $event)"
  >
    <KpIcon v-if="icon" :name="icon" :size="14" />
    <slot />
  </button>
</template>

<style scoped lang="scss">
// Geometry is the DS §9.1 S step (28 high, 13 side padding, 12/Medium, gap 2)
// — the same box the segmented chip uses, so the two read as one family and
// differ only in fill.
.kp-chip {
  height: 28px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--r-pill);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
  background: var(--gray-f7);
  color: var(--fg-secondary);

  &.kp-chip--green {
    background: var(--keep-green-bg);
    color: var(--action-press);
  }

  &.is-on {
    background: var(--gray-33);
    color: var(--white);
  }
}
</style>
