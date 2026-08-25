<script setup lang="ts">
/**
 * Segment filter: a pale pill when selected, plain text when not.
 *
 * A solid dark pill in a row of them shouts — a catalog's categories are a
 * filter, not the page's action.
 *
 * Same §9.1 S geometry as KpGhostBtn (28 / 12px Medium / 13 side padding /
 * pill), and the weight is pinned at Medium in both states: §9.1's five steps
 * are all Medium, so de-emphasis goes through colour (§7.2), never weight.
 *
 * The count is a separate `count` prop, never parentheses baked into the
 * label. Full-width （3）carries a lot of side bearing in a CJK face and
 * loosens a 28px pill; half-width (3) is tighter but the brackets say nothing
 * that the position and the muted colour have not already said. `tabular-nums`
 * keeps the pill from resizing as 9 ticks over to 10.
 */
defineProps<{ on?: boolean; count?: number | null }>()
defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button class="ab kp-seg-chip" :class="{ 'is-on': on }" @click="$emit('click', $event)">
    <slot />
    <span v-if="count !== null && count !== undefined" class="kp-seg-chip__count">{{ count }}</span>
  </button>
</template>

<style scoped lang="scss">
.kp-seg-chip {
  height: 28px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  cursor: pointer;
  white-space: nowrap;
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);

  &.is-on {
    background: var(--selected-bg);
    color: var(--fg-title);
  }
}

.kp-seg-chip__count {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-disabled);

  .is-on & {
    color: var(--fg-aux);
  }
}
</style>
