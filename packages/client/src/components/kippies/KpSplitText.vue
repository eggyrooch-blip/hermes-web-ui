<script setup lang="ts">
/**
 * Home wordmark — per-character entrance with a flowing gradient.
 *
 * ⚠️⚠️ The biggest trap: **the parent cannot own the gradient.** The obvious
 * shape is `background-clip: text` on the wrapper with the per-glyph spans
 * inheriting it. Measured result: the whole line is invisible — a parent's
 * `background-clip: text` only clips its own background box, and text living
 * inside `inline-block` children is not in that box. So **every glyph carries
 * its own slice** of one gradient: `background-size` is the full line width and
 * `background-position-x` is the negative of that glyph's left offset. Stitched
 * together they read as one continuous ramp.
 *
 * ⚠️ Offsets must be measured only after `document.fonts.ready`. The wordmark is
 * Outfit at weight 900; before it settles, every measurement is of the fallback
 * face and every offset is wrong, which shows up as the gradient breaking at the
 * seams between glyphs. (Same root cause as the button-width lock: anything that
 * measures-then-uses has to wait for the font.)
 *
 * ⚠️ Spaces get no animation and no gradient (no glyph), but must stay in the DOM
 * to hold their place, and must be a NBSP — once split, every span is
 * `inline-block` and an ordinary space collapses, giving "KippiesWork".
 *
 * The flow itself is dispatched per glyph through the Web Animations API, not one
 * CSS `@keyframes`: each glyph's `background-position` encodes *its own* offset
 * into the shared ramp, and a static keyframe can only carry one fixed set of
 * values — it cannot express "each glyph's own baseline plus one shared travel".
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { canAnimate } from './mascot'

const props = withDefaults(
  defineProps<{
    text?: string
    fontSize?: number
    /** Per-character entrance offset, ms. */
    stagger?: number
  }>(),
  { text: 'Kippies Work', fontSize: 56, stagger: 42 },
)

/**
 * Flow cycle, seconds. Taken from reactbits' GradientText `animationSpeed={8}`:
 * one round trip in 8s is slow enough not to compete for attention while still
 * visibly moving.
 */
const FLOW_S = 8

const host = ref<HTMLElement | null>(null)
const slices = ref<{ size: number; pos: number }[] | null>(null)

const chars = computed(() => props.text.split(''))

/** Index into `slices` — spaces are skipped, so it is not the char index. */
function sliceIndex(i: number) {
  return chars.value.slice(0, i).filter((c) => c !== ' ').length
}

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

let ro: ResizeObserver | null = null
let dead = false

/**
 * The flow animations this component owns.
 *
 * ⚠️ Load-bearing. `getAnimations()` returns EVERY animation on the element,
 * CSS ones included — so a blanket `.cancel()` also kills the `.splitch`
 * entrance (`kp-splitin`). And `measure()` runs on `document.fonts.ready`, which
 * for a locally-served 1.1KB subset resolves well inside the entrance's 620ms:
 * the wordmark would simply appear, its per-character rise cancelled a few frames
 * in. Only ever cancel animations we put here.
 */
const ownFlows = new WeakSet<Animation>()

function flow(spans: HTMLElement[], bases: number[], total: number) {
  if (prefersReduced()) return // reduced motion: hold the first frame
  // jsdom implements neither animate() nor getAnimations(); without this the
  // wordmark throws on mount under test. Degrading to a static gradient is also
  // the right fallback anywhere else WAAPI is missing.
  if (!canAnimate(spans[0])) return
  const anims = spans.map((el, i) => {
    // Cancel only OUR previous flow (a re-measure re-dispatches). WAAPI defaults
    // to composite: replace, so a stale flow would fight this one — but the
    // entrance animation must be left alone. See ownFlows above.
    el.getAnimations().forEach((a) => {
      if (ownFlows.has(a)) a.cancel()
    })
    const b = bases[i]
    // 0 → -2T → 0 is a ROUND TRIP, not a one-way loop. One-way needs first and
    // last stop to match or it jumps; a round trip is seamless for free.
    const anim = el.animate(
      [
        { backgroundPosition: `${b}px 0` },
        { backgroundPosition: `${b - total * 2}px 0` },
        { backgroundPosition: `${b}px 0` },
      ],
      { duration: FLOW_S * 1000, iterations: Infinity, easing: 'linear' },
    )
    ownFlows.add(anim)
    return anim
  })
  // Align every animation's start to the first one. Successive animate() calls
  // can straddle a frame; unaligned, glyphs sit a few ms out of phase and the
  // ramp visibly breaks at the seams. Has to wait on `ready` — startTime is null
  // until the timeline assigns it on the next frame.
  if (anims.length) {
    Promise.all(anims.map((a) => a.ready))
      .then(() => {
        const t0 = anims[0].startTime
        if (t0 != null) anims.forEach((a) => (a.startTime = t0))
      })
      .catch(() => {})
  }
}

function measure() {
  const el = host.value
  if (!el || dead) return
  const spans = Array.from(el.querySelectorAll<HTMLElement>('[data-ch]'))
  if (!spans.length) return
  const boxes = spans.map((s) => s.getBoundingClientRect())
  // The line width is the glyphs' actual span (first glyph's left edge to the
  // last one's right edge), not the container's — the container is centred, and
  // its side padding would squash the ramp.
  const left = Math.min(...boxes.map((b) => b.left))
  const right = Math.max(...boxes.map((b) => b.right))
  const total = Math.max(1, right - left)
  // The ramp is laid out at 3x the line width (GradientText uses
  // background-size: 300%): flowing means sliding that 3T band 2T across the
  // glyphs. At 1T it would slide clean off and leave bare text.
  slices.value = boxes.map((b) => ({ size: total * 3, pos: -(b.left - left) }))
  flow(
    spans,
    boxes.map((b) => -(b.left - left)),
    total,
  )
}

function schedule() {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    void document.fonts.ready.then(measure)
  } else {
    measure()
  }
}

onMounted(() => {
  schedule()
  // ResizeObserver rather than a window resize listener: collapsing the sidebar
  // changes this element's width without firing window.resize.
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    ro = new ResizeObserver(() => measure())
    ro.observe(host.value)
  }
})

onBeforeUnmount(() => {
  dead = true
  ro?.disconnect()
  ro = null
})

watch(() => [props.text, props.fontSize], schedule)

/**
 * Only the three values that genuinely differ per glyph go inline. The
 * clip-to-text switch lives in a class (`is-painted`) rather than inline,
 * because the vendor-prefixed pair has to be written as `-webkit-background-clip`
 * / `-webkit-text-fill-color` and a Vue style object cannot express those
 * reliably — a lowercase `webkitBackgroundClip` key emits the invalid
 * `webkit-background-clip`.
 */
function glyphStyle(i: number) {
  const sl = slices.value?.[sliceIndex(i)]
  if (!sl) return { animationDelay: `${i * props.stagger}ms` }
  return {
    backgroundImage: 'var(--grad-wordmark)',
    backgroundSize: `${sl.size}px 100%`,
    backgroundPosition: `${sl.pos}px 0`,
    animationDelay: `${i * props.stagger}ms`,
  }
}

function isPainted(i: number) {
  return !!slices.value?.[sliceIndex(i)]
}
</script>

<template>
  <div
    ref="host"
    class="kp-split"
    role="img"
    :aria-label="text"
    :style="{ fontSize: `${fontSize}px` }"
  >
    <template v-for="(c, i) in chars" :key="i">
      <span v-if="c === ' '" class="kp-split__sp">&#160;</span>
      <span
        v-else
        data-ch
        class="splitch kp-split__ch"
        :class="{ 'is-painted': isPainted(i) }"
        :style="glyphStyle(i)"
        >{{ c }}</span
      >
    </template>
  </div>
</template>

<style scoped lang="scss">
// The 620 cap and the fixed 104 height are load-bearing, not cosmetic — the
// composer's vertical position is derived from them (wordmark 104 + 32 gap).
// Glyphs are inline-block with a translateY entrance, so letting the text set
// its own height would push the composer down.
.kp-split {
  width: 100%;
  max-width: 620px;
  // Long-hand, NOT `margin: 0 auto`. Consumers put their own class on this same
  // root (MessageList's `.empty-wordmark { margin-bottom: 12px }`), and the
  // shorthand silently zeroes their vertical margin whenever source order puts
  // this rule last. Same trap that once welded the starter cards to the composer.
  margin-left: auto;
  margin-right: auto;
  text-align: center;
  white-space: nowrap;
  font-family: 'Outfit', var(--font-latin);
  font-weight: 900;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.kp-split__ch {
  display: inline-block;
  background-repeat: no-repeat;
  // Until the offsets are measured the glyph paints in ink. A blank frame would
  // be fine; a frame of visibly misaligned gradient would not.
  color: var(--logo-ink);
}

// Applied only once this glyph has its slice — clipping to text while there is
// no background yet would render it invisible rather than unstyled.
.kp-split__ch.is-painted {
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}

.kp-split__sp {
  display: inline-block;
  width: 0.26em;
}
</style>
