<script setup lang="ts">
/**
 * Hand-drawn navigation icons.
 *
 * The icon font can't animate: stroke weight is baked into the glyph and there
 * is no path to draw. These eight are redrawn as SVG with `pathLength="1"` on
 * every path — the length is *declared* as 1, so the stroke-draw hover can use
 * a flat `dasharray: 1` instead of measuring each path in JS.
 *
 * Anything without a path here falls back to the font. Icons outside the
 * sidebar (file tree, buttons) stay glyphs — they don't animate.
 */
import KpIcon from './KpIcon.vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 18,
})

// Coordinates are absolute on a 24×24 box. The AI spark inside the speech
// bubble is written out point by point rather than as relative `l` offsets:
// relative corners accumulate, so nudging the radius breaks the symmetry and
// drifts the whole shape — which is exactly how it once grew fat enough to
// touch the bubble wall.
const NAV_SVG: Record<string, string[]> = {
  line_add: ['M12 5V19', 'M5 12H19'],
  line_comment_ai: [
    'M6.5 4.5h11A2.5 2.5 0 0 1 20 7v6a2.5 2.5 0 0 1-2.5 2.5H10.5l-3.5 3.2V15.5H6.5A2.5 2.5 0 0 1 4 13V7a2.5 2.5 0 0 1 2.5-2.5Z',
    'M12 7.2C12.3 9.1 12.8 9.6 14.7 9.9 12.8 10.2 12.3 10.7 12 12.6 11.7 10.7 11.2 10.2 9.3 9.9 11.2 9.6 11.7 9.1 12 7.2Z',
  ],
  line_screening: ['M4.5 5.5h15l-6 7.2v5.4l-3 1.9v-7.3Z'],
  // "Apps" = a horizontal window plus a title bar.
  //
  // This was a 2×2 grid, which shattered the stroke-draw: each sub-path carries
  // its own pathLength="1", so four little squares all drew at once inside the
  // same 620ms — four places twitching together reads as noise, not as one
  // gesture. Rule: an icon gets at most "one long, one short" — a main path
  // plus at most one small part. (That is why line_comment_ai works: one big
  // bubble, one small spark.)
  //
  // It separates from line_box (the 12×12 square) by *silhouette*, not detail:
  // this one is a 16×12 landscape window. Small icons are read as shapes, and
  // square vs. wide reads instantly. line_screening can't be reused — it means
  // *filter*, which is what the actual filter button in the same rail uses.
  line_apps: ['M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z', 'M4.2 9.8h15.6'],
  line_box: ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z'],
  line_time: ['M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16Z', 'M12 7.6V12l3.1 1.9'],
  line_drawer: [
    'M6 6h12a2.4 2.4 0 0 1 0 4.8H6A2.4 2.4 0 0 1 6 6Z',
    'M6 13.2h12a2.4 2.4 0 0 1 0 4.8H6a2.4 2.4 0 0 1 0-4.8Z',
    // The two handles used to be `M9 8.4h.01`, whose measured length is 0.
    // pathLength="1" + stroke-dasharray cannot animate a zero-length path: it
    // doesn't draw, it just pops in on frame 0, out of sync with the two
    // drawers' 620ms stroke. A short segment (1.4 long) with the round linecap
    // still reads as a dot.
    'M8.3 8.4h1.4',
    'M8.3 15.6h1.4',
  ],
  line_photo_filter: [
    'M12 4.4a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 1 0 0-8.6Z',
    'M8.3 11a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 1 0 0-8.6Z',
    'M15.7 11a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 1 0 0-8.6Z',
  ],
  line_photo_template: [
    'M9.5 4.5h8A2 2 0 0 1 19.5 6.5v8',
    'M6.5 8.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z',
  ],
}
</script>

<template>
  <svg
    v-if="NAV_SVG[props.name]"
    viewBox="0 0 24 24"
    :width="props.size"
    :height="props.size"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- pathLength, not path-length: SVG attribute names are case sensitive,
         and the kebab spelling is silently ignored — which leaves the CSS
         `stroke-dasharray: 1` meaning one *pixel*, i.e. dotted icons. -->
    <path v-for="(d, i) in NAV_SVG[props.name]" :key="i" :d="d" pathLength="1" />
  </svg>
  <KpIcon v-else :name="props.name" :size="props.size" />
</template>

<style scoped>
svg {
  display: block;
  overflow: visible;
}
</style>
