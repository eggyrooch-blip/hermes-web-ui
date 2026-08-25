<script setup lang="ts">
/**
 * One shimmering placeholder bar.
 *
 * It MUST be `inline-block`, never `block`. As a block the row's height becomes
 * the bar's own height and the line-height of the text it stands in for is
 * bypassed — a real 14px title line is 14 × 1.35 = 18.9px, so a 14px bar comes
 * out 2.1px short and a few rows in, the whole page shifts down when the data
 * arrives. Inline-block keeps the line box's strut, so the height matches the
 * real row automatically without hardcoding a number.
 */
withDefaults(defineProps<{ w?: number | string; h?: number }>(), { h: 12 })
</script>

<template>
  <i
    class="shimmer kp-skelbar"
    :style="{ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px` }"
  />
</template>

<style scoped lang="scss">
.kp-skelbar {
  display: inline-block;
  vertical-align: middle;
  border-radius: var(--r-card-s);
  background: var(--surface-3);
}
</style>
