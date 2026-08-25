<script setup lang="ts">
/**
 * The mascot artwork itself — shared by both usages so there is only ever one
 * copy of the character.
 *
 *   KpMascot     home    flat-bottomed (clipped at y=392), sits on the composer's
 *                        top edge, eyes track the pointer
 *   KpMascotFace failure full ball + ground, slow head-shake + blink, spinning spark
 *
 * Geometry facts that are invisible in the file but matter:
 *   · The flat bottom is not drawn — a clipPath cuts at y=392. That is why it
 *     suits sitting on an edge.
 *   · The viewBox is 578 wide but the body ends at x=468: the right 19% is
 *     transparent. Any "inset from the right" has to be computed, not written.
 *   · A flat-bottomed shape MUST have something to sit on. Centred in a page's
 *     whitespace with nothing beneath, that cut edge reads as "this image got
 *     cropped by its container". Floating ⇒ use the full shape plus a ground.
 *
 * ⚠️ `uid` exists because SVG ids are **document**-scoped, not per-<svg>. Two
 * mascots on one page sharing ids means the second one references the first's
 * gradients and filters.
 *
 * ⚠️ Each eye is wrapped TWICE and neither layer may be merged away:
 *     .mceye   ← head-shake translate / pointer tracking
 *     .mcblink ← blink scaleY, origin at that eye's own centre
 *   Both write `transform`; on one element the later one *replaces* the earlier
 *   (WAAPI composite: replace defaults), so a blink would wipe out the shake
 *   offset. And the innermost <rect> must not be touched at all — it carries the
 *   artwork's own `matrix(-1 0 0 1 …)` mirror, and writing transform there
 *   overwrites the mirror and the eye jumps.
 *   General rule: to animate art-supplied SVG, wrap — never write onto an
 *   element that already has a transform.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    uid: string
    eye?: 'open' | 'shut' | 'dot'
    spark?: boolean
    /** Clip the bottom flat at y=392 (the home treatment). */
    clip?: boolean
    /** Draw the ground glow. Only meaningful when not clipped. */
    ground?: boolean
  }>(),
  { eye: 'open', spark: true, clip: false, ground: false },
)

/**
 * Expression = two numbers on the eye's rounded rect. Original is 39 x 74,
 * rx 19.5, centred at y=288.
 *   open normal · shut "disconnected" · dot "stopped short"
 * `shut` was tried at 8: at a 90px render that is 1.8px, effectively invisible.
 * 14 is the floor at which "closed" still reads.
 */
const EYE = {
  open: { h: 74, rx: 19.5 },
  shut: { h: 14, rx: 7 },
  dot: { h: 22, rx: 11 },
} as const

/**
 * The spark's bounding box is x 396..468 / y 44..114 → centre (432,79). Spin and
 * scale both go around THAT, not the svg centre, or the spark orbits the whole
 * mascot. scale 1.28: the original 72x70 is only ~11px at a 90px render, smaller
 * than the eyes and unreadable in motion.
 */
const SPARK = { cx: 432, cy: 79, scale: 1.28 }

/** Inner body ellipse: matrix(-1 0 0 1 468 107) + cx 198 / ry 196 → centre (270,303). */
const BODY_CX = 270

// computed, not a plain const: a plain destructure at setup time would freeze the
// expression at its initial value and never respond to `eye` changing.
const e = computed(() => EYE[props.eye] ?? EYE.open)
const eyeY = computed(() => 288 - e.value.h / 2)

/** Eye centre = x − 19.5 (the rect is drawn 39 wide leftwards from x). */
const EYE_X = [307, 193]

const sparkTransform = `translate(${SPARK.cx} ${SPARK.cy}) scale(${SPARK.scale}) translate(${-SPARK.cx} ${-SPARK.cy})`
</script>

<template>
  <g :clip-path="clip ? `url(#${uid}c)` : undefined">
    <!--
      Ground: not a drop shadow — it is the mascot's own light hitting the floor,
      so it uses #838FFF from the body ramp rather than grey. A grey shadow would
      fight the "glowing ball" and §7.1 admits no new shadows; this is an
      illustration element painted in an existing palette color. Drawn BEFORE the
      body so the body sits on top of it.
    -->
    <ellipse
      v-if="ground && !clip"
      :cx="BODY_CX"
      cy="558"
      rx="182"
      ry="30"
      :fill="`url(#${uid}g)`"
    />
    <!--
      The spark is wrapped twice as well: the outer .mcspark only rotates, the
      inner g only holds the static scale. Together on one element, the rotation
      would replace the scale and the spark shrinks the moment it spins.
    -->
    <g v-if="spark" class="mcspark">
      <g :transform="sparkTransform">
        <path
          d="M396 76.3047C414.358 76.3047 429.238 61.8457 429.238 44H434.762C434.762 61.8457 449.642 76.3047 468 76.3047V81.6953C449.642 81.6953 434.762 96.1543 434.762 114H429.238C429.238 96.1543 414.358 81.6953 396 81.6953V76.3047Z"
          :fill="`url(#${uid}0)`"
        />
      </g>
    </g>
    <g class="mcbody">
      <g :filter="`url(#${uid}f0)`">
        <ellipse
          cx="209.5"
          cy="220.5"
          rx="209.5"
          ry="220.5"
          transform="matrix(-1 0 0 1 491 107)"
          :fill="`url(#${uid}1)`"
        />
      </g>
      <g :filter="`url(#${uid}f1)`">
        <ellipse
          cx="198"
          cy="196"
          rx="198"
          ry="196"
          transform="matrix(-1 0 0 1 468 107)"
          :fill="`url(#${uid}2)`"
        />
      </g>
    </g>
    <!--
      Eyes span x 268..307 / 154..193. Clearance: left eye to the body's left edge
      82, right eye to the right edge 161. The BINDING side is that 82 on the left
      (this artwork is mirrored, so the tight side is the left one) — size any
      travel against it, not against the roomy number on the right.
    -->
    <g v-for="x in EYE_X" :key="x" class="mceye">
      <g
        class="mcblink"
        :style="{ transformBox: 'view-box', transformOrigin: `${x - 19.5}px 288px` }"
      >
        <rect
          width="39"
          :height="e.h"
          :rx="e.rx"
          :transform="`matrix(-1 0 0 1 ${x} ${eyeY})`"
          fill="white"
        />
      </g>
    </g>
  </g>
  <defs>
    <filter
      :id="`${uid}f0`"
      x="-2"
      y="33"
      width="567"
      height="589"
      filterUnits="userSpaceOnUse"
      color-interpolation-filters="sRGB"
    >
      <feFlood flood-opacity="0" result="bg" />
      <feBlend mode="normal" in="SourceGraphic" in2="bg" result="shape" />
      <feGaussianBlur stdDeviation="37" result="b" />
    </filter>
    <filter
      :id="`${uid}f1`"
      x="38"
      y="73"
      width="464"
      height="460"
      filterUnits="userSpaceOnUse"
      color-interpolation-filters="sRGB"
    >
      <feFlood flood-opacity="0" result="bg" />
      <feBlend mode="normal" in="SourceGraphic" in2="bg" result="shape" />
      <feGaussianBlur stdDeviation="17" result="b" />
    </filter>
    <linearGradient
      :id="`${uid}0`"
      x1="396"
      y1="44"
      x2="465.972"
      y2="115.971"
      gradientUnits="userSpaceOnUse"
    >
      <stop stop-color="#FFB7F5" />
      <stop offset="0.22" stop-color="#D274FF" />
      <stop offset="0.39" stop-color="#A273FF" />
      <stop offset="0.59" stop-color="#838FFF" />
      <stop offset="0.77" stop-color="#8F9CFF" />
      <stop offset="1" stop-color="#BED8FF" />
    </linearGradient>
    <linearGradient
      :id="`${uid}1`"
      x1="402.848"
      y1="17"
      x2="33.332"
      y2="368.082"
      gradientUnits="userSpaceOnUse"
    >
      <stop stop-color="#FFB7F5" />
      <stop offset="0.22" stop-color="#D274FF" />
      <stop offset="0.39" stop-color="#A273FF" />
      <stop offset="0.59" stop-color="#838FFF" />
      <stop offset="0.77" stop-color="#8F9CFF" />
      <stop offset="1" stop-color="#BED8FF" />
    </linearGradient>
    <linearGradient
      :id="`${uid}2`"
      x1="396"
      y1="0"
      x2="4.02018"
      y2="395.98"
      gradientUnits="userSpaceOnUse"
    >
      <stop stop-color="#FFB7F5" />
      <stop offset="0.22" stop-color="#D274FF" />
      <stop offset="0.39" stop-color="#A273FF" />
      <stop offset="0.59" stop-color="#838FFF" />
      <stop offset="0.77" stop-color="#8F9CFF" />
      <stop offset="1" stop-color="#BED8FF" />
    </linearGradient>
    <radialGradient :id="`${uid}g`">
      <stop stop-color="#838FFF" stop-opacity=".7" />
      <stop offset=".5" stop-color="#8F9CFF" stop-opacity=".34" />
      <stop offset="1" stop-color="#838FFF" stop-opacity="0" />
    </radialGradient>
    <clipPath :id="`${uid}c`">
      <rect width="578" height="392" fill="white" transform="matrix(-1 0 0 1 578 0)" />
    </clipPath>
  </defs>
</template>
