<script setup lang="ts">
/**
 * Section heading — 16/600 with a 12px underhang and a divider rule.
 *
 * Deliberately identical to the catalog group heading. When these two
 * differed, the settings page and the five catalog pages had two separate
 * ways of starting a section inside one product.
 */
defineProps<{ note?: string }>()
</script>

<template>
  <div class="kp-section-title">
    <span class="kp-section-title__text"><slot /></span>
    <span v-if="note" class="t-meta kp-section-title__note">{{ note }}</span>
    <div class="kp-section-title__spacer" />
    <slot name="action" />
  </div>
</template>

<style scoped lang="scss">
// The 12px above and below the rule is §6.2's title-to-content gap, applied
// on both sides of it. The bottom margin used to be 4, which pulled every
// section's first row up against its own heading.
//
// §9.6 puts a divider at 0.5pt, not 1px: on a 2x screen 1px is two physical
// pixels — double the spec — and a dozen rules down one page is what turns
// "light presence" into a grid.
.kp-section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 0.5px solid var(--divider);
}

.kp-section-title__text {
  font: var(--w-semibold) var(--t-16) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
}

.kp-section-title__note {
  color: var(--fg-disabled);
}

.kp-section-title__spacer {
  flex: 1;
}
</style>
