<script setup lang="ts">
/**
 * Hairline rule.
 *
 * §9.6 puts a divider at 0.5pt, not 1px. On a 2x screen 1px is two physical
 * pixels — twice the spec — and a dozen of them down one page is what turns
 * "light presence" into a grid.
 */
defineProps<{ vertical?: boolean }>()
</script>

<template>
  <div class="kp-divider" :class="{ 'is-vertical': vertical }" />
</template>

<style scoped lang="scss">
.kp-divider {
  height: 0.5px;
  background: var(--divider);

  &.is-vertical {
    width: 0.5px;
    height: auto;
    align-self: stretch;
  }
}
</style>
