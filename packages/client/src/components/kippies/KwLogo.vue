<script setup lang="ts">
/**
 * Sidebar logo — the designer's finished combination mark: mascot + wordmark.
 *
 * This used to be a hand-built SVG outline of just the wordmark (each glyph of
 * "KippiesWork" taken from Outfit Black at -0.02em and merged into one path,
 * filled with --logo-ink). That path is still in git if it is ever wanted back;
 * the design now ships an actual asset, and it is more than a wordmark.
 *
 * ⚠️ The mark and the wordmark are **two images, each with its own height** —
 * not one image scaled as a unit. They started life as a single file, which
 * welded their sizes together: enlarging the mascot enlarged the lettering with
 * it and pushed the pair out of the sidebar head. The assets are now split at
 * the fully-transparent gutter between them, and only horizontally: both keep
 * the artwork's full 432px height. Cropping the wordmark tight would take its
 * ratio from 3.91 to 6.45, i.e. 82px wide to 135px at the same height, which
 * does not fit the head's budget.
 *
 * General rule: two things that will be adjusted separately must not be
 * delivered as one image.
 *
 * Sizes: the mark is 28 and the wordmark is 21. The wordmark's height is
 * unchanged from when they were one image — the brief was to enlarge the mascot
 * alone, and scaling the lettering to match would be enlarging the whole logo
 * (which also overflows the head). 28 is the next rung up the control ladder
 * from 24, which puts the mascot a third taller than the lettering so the pair
 * reads as "mark + name" rather than as a small prefix the size of the type.
 *
 * Width budget: the head gives the logo about 136px (248 sidebar − 24 aside
 * padding − 12/4 head padding − two 32px buttons − two 4px gaps). This comes to
 * 28 + 8 + 82 = 118, so there is room. It matters because the collapsed rail
 * puts `overflow: hidden` on the container: an oversized logo is not an overflow
 * error, it is silently sliced mid-glyph ("Kippies Wor|").
 *
 * Two files per piece, one per theme — the ink is baked into the pixels, so a
 * single file cannot serve both grounds (the dark wordmark is repainted white at
 * generation time; the mascot keeps its own colours but still ships a pair).
 * Both are always in the DOM and CSS shows one (`.kwlogo-l` / `.kwlogo-d` in
 * keep-motion.scss). Deliberately NOT "read the theme in JS and pick one": that
 * paints the default theme's file on the first frame and swaps it after, which
 * in dark mode is a visible flash of the light logo. CSS is correct from frame
 * one and needs no load on theme change (both are already decoded).
 *
 * ⚠️ Do NOT set `display` in an inline style here. The theme swap is a class
 * rule, and inline styles outrank class rules — writing `display: block` makes
 * `[data-theme='dark'] .kwlogo-l { display: none }` unable to win, so dark mode
 * silently keeps showing the light file. (Same trap as the thumbnail veil's
 * opacity and the wordmark's gradient: anything a class needs to switch must not
 * appear inline.)
 */
import markLight from '@/assets/kw-logo-mark-light.webp'
import markDark from '@/assets/kw-logo-mark-dark.webp'
import wordLight from '@/assets/kw-logo-word-light.webp'
import wordDark from '@/assets/kw-logo-word-dark.webp'
import { computed } from 'vue'

/** Both measured off the assets' VP8X canvases: 432x432 and 1689x432. */
const MARK_RATIO = 432 / 432
const WORD_RATIO = 1689 / 432

const props = withDefaults(
  defineProps<{
    /** Mascot height. The wordmark is sized independently — see `wordHeight`. */
    markHeight?: number
    /** Wordmark height. Unchanged when the mascot grows. */
    wordHeight?: number
  }>(),
  { markHeight: 28, wordHeight: 21 },
)

const markWidth = computed(() => Math.round(props.markHeight * MARK_RATIO))
const wordWidth = computed(() => Math.round(props.wordHeight * WORD_RATIO))
</script>

<template>
  <!-- `align-items: center`, never baseline: these are images, so their baseline
       is the box's bottom edge, and aligning a 28 and a 21 box on the bottom
       drops the wordmark below the mascot. -->
  <span class="kwlogo">
    <span class="kwlogo__piece" :style="{ width: `${markWidth}px`, height: `${markHeight}px` }">
      <img class="kwlogo-l" :src="markLight" :width="markWidth" :height="markHeight" alt="KippiesWork" />
      <!-- aria-hidden: the pair is one image, and the light copy already names it. -->
      <img class="kwlogo-d" :src="markDark" :width="markWidth" :height="markHeight" alt="" aria-hidden="true" />
    </span>
    <span class="kwlogo__piece" :style="{ width: `${wordWidth}px`, height: `${wordHeight}px` }">
      <!-- The mark above carries the accessible name for the whole logo, so
           neither wordmark copy repeats it. -->
      <img class="kwlogo-l" :src="wordLight" :width="wordWidth" :height="wordHeight" alt="" aria-hidden="true" />
      <img class="kwlogo-d" :src="wordDark" :width="wordWidth" :height="wordHeight" alt="" aria-hidden="true" />
    </span>
  </span>
</template>

<style scoped lang="scss">
.kwlogo {
  display: inline-flex;
  align-items: center;
  // The gutter in the artwork works out to about 8.8 at this scale; 8 is the
  // rung on the spacing ladder.
  gap: 8px;
  flex: 0 0 auto;
}

.kwlogo__piece {
  display: inline-flex;
  flex: 0 0 auto;
}
</style>
