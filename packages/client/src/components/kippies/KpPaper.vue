<script setup lang="ts">
/**
 * A miniature sheet of paper — heading bar over ruled lines.
 *
 * Used wherever "a document that isn't here yet" needs drawing (empty states
 * today). A plain rounded block reads as a loading failure; the ruling is what
 * makes it read as a document.
 *
 * Every measurement is a fraction of the width, exactly as the prototype
 * derives them, so the sheet stays in proportion at any size: inner padding
 * 12%, row gap 5.5%, heading 6% tall over a 4% underhang, lines 3% tall (both
 * with a floor, so they never vanish at small sizes). The line widths cycle
 * 76 / 88 / 58 so no two neighbouring rows end on the same edge.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    w?: number
    h?: number
    /** Sheet ground. Defaults to the --gray-f7 step. */
    tone?: string
    lines?: number
    title?: boolean
    /** Heading-bar colour, when it should read as something other than filler. */
    accent?: string
  }>(),
  { w: 96, h: 126, tone: 'var(--gray-f7)', lines: 7, title: true },
)

const lineWidths = computed(() =>
  Array.from({ length: props.lines }, (_, i) => (i % 3 === 2 ? '58%' : i % 3 === 1 ? '88%' : '76%')),
)

const sheetStyle = computed(() => ({
  width: `${props.w}px`,
  height: `${props.h}px`,
  flex: `0 0 ${props.w}px`,
  background: props.tone,
  padding: `${props.w * 0.12}px`,
  gap: `${props.w * 0.055}px`,
}))

const headStyle = computed(() => ({
  height: `${Math.max(4, props.w * 0.06)}px`,
  marginBottom: `${props.w * 0.04}px`,
  background: props.accent || 'var(--gray-99)',
}))

const lineHeight = computed(() => `${Math.max(2, props.w * 0.03)}px`)
</script>

<template>
  <div class="kp-paper" :style="sheetStyle">
    <span v-if="title" class="kp-paper__head" :style="headStyle" />
    <span
      v-for="(w, i) in lineWidths"
      :key="i"
      class="kp-paper__line"
      :style="{ width: w, height: lineHeight }"
    />
  </div>
</template>

<style scoped lang="scss">
.kp-paper {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-card-s);
}

.kp-paper__head {
  width: 52%;
  border-radius: var(--r-card-s);
}

.kp-paper__line {
  border-radius: var(--r-card-s);
  background: var(--gray-cc);
  opacity: 0.6;
}
</style>
