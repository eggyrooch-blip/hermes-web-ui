<script setup lang="ts">
/**
 * Side-panel toggle glyph — a rounded frame with a rail down its left edge.
 *
 * Drawn rather than taken from the icon font: the font's nearest name renders
 * as a hamburger, which reads as "menu", not "show/hide the panel".
 */
withDefaults(defineProps<{ size?: number }>(), { size: 17 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="3" stroke="currentColor" stroke-width="1.5" />
    <path d="M8.4 3.6V16.4" stroke="currentColor" stroke-width="1.5" />
  </svg>
</template>

<style scoped>
svg {
  display: block;
}
</style>
