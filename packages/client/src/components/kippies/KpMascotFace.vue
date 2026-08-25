<script setup lang="ts">
/**
 * The floating mascot: full ball + ground, slow head-shake + blink, spinning spark.
 * Used on the full-page failure state and as a small thinking avatar.
 *
 * `mode`:
 *   halt  the failure page — slow shake every 2s + blink, spark spins CONTINUOUSLY
 *   idle  an avatar — no shake, blink only, spark spins one turn then rests
 *
 * `pad` cancels the viewBox's transparent margin with negative margins.
 * ⚠️ It does NOT crop the viewBox. Tightening the viewBox to `60 30 430 480` was
 * tried to make the body look bigger at small sizes — that cuts off the gaussian
 * blur around the ball and produces a hard edge that reads instantly as damage.
 * The right move is to keep the viewBox whole, render larger, and pull the extra
 * transparent margin back in.
 * General rule: **to make content bigger, scale up — never crop the canvas.**
 *
 * ⚠️ `flip` must go on the outermost <svg>. Inside, the artwork carries its own
 * `matrix(-1 0 0 1 …)` mirrors and `.mcspark` / `.mcblink` each hold animated
 * transforms; stacking a flip onto any of those overwrites one of them.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import KpMascotArt from './KpMascotArt.vue'
import {
  MC,
  MC_BLINK,
  MC_BLINK_MS,
  MC_CYCLE_BUSY,
  MC_FULL_VH,
  MC_SHAKE_GAP,
  MC_SHAKE_MS,
  MC_SPARK_GAP_BUSY,
  MC_SPARK_MS,
  MC_SPARK_ONCE,
  MC_SPARK_ORIGIN,
  MC_SWAY,
  canAnimate,
  mcReduced,
  mcUid,
} from './mascot'

const props = withDefaults(
  defineProps<{
    size?: number
    eye?: 'open' | 'shut' | 'dot'
    mode?: 'halt' | 'idle'
    flip?: boolean
    pad?: boolean
    ground?: boolean
    /** Optical vertical nudge, px (negative = up). */
    nudgeY?: number
    /** Is the thing this avatar represents currently working? */
    busy?: boolean
  }>(),
  { size: 94, eye: 'open', mode: 'halt', flip: false, pad: false, ground: true, nudgeY: 0, busy: false },
)

const uid = mcUid('mcf')
const host = ref<HTMLElement | null>(null)

let timers: ReturnType<typeof setTimeout>[] = []
let dead = false

function clearAll() {
  timers.forEach(clearTimeout)
  timers = []
}

function start() {
  const el = host.value
  if (!el || mcReduced()) return
  dead = false

  /**
   * The avatar (mode idle) only animates WHILE working; once the answer is done it
   * stops. Reason: with the result on screen the leads are the prose and the
   * artifacts, and an avatar that keeps blinking and spinning becomes a perpetual
   * decoration unrelated to the content, pulling the eye back to the corner.
   * The failure page's mascot is exempt — it is the only thing moving there, and
   * stopping it would make the whole page a still image.
   */
  const live = props.mode === 'halt' || props.busy
  const eyes = Array.from(el.querySelectorAll<SVGElement>('.mceye'))
  const lids = Array.from(el.querySelectorAll<SVGElement>('.mcblink'))
  const sp = el.querySelector<SVGElement>('.mcspark')

  // No WAAPI (jsdom) → render the artwork still rather than throwing.
  if (!canAnimate(lids[0] ?? eyes[0] ?? sp)) return

  const spin1 = (ms: number) =>
    sp?.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: ms,
      easing: 'cubic-bezier(.4,0,.2,1)',
    })

  if (sp) {
    sp.style.transformBox = 'view-box'
    sp.style.transformOrigin = `${MC_SPARK_ORIGIN.cx}px ${MC_SPARK_ORIGIN.cy}px`
    if (props.mode === 'halt') {
      // Failure page: spins forever — it is the "still trying" signal on a page
      // where nothing else moves.
      sp.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
        duration: MC_SPARK_MS,
        iterations: Infinity,
        easing: 'linear',
      })
    } else if (live) {
      // Avatar while thinking: one turn, a rest, another turn. Spinning
      // continuously on a 30px avatar becomes a little pinwheel that never stops
      // and keeps stealing the eye.
      const burst = () => {
        timers.push(
          setTimeout(() => {
            if (dead) return
            spin1(MC_SPARK_ONCE)
            burst()
          }, MC_SPARK_ONCE + MC_SPARK_GAP_BUSY),
        )
      }
      spin1(MC_SPARK_ONCE)
      burst()
    }
    // Done working (live false): schedule nothing new. The turn in flight finishes
    // and stops where it is — deliberately NOT cancelled, since a hard cancel
    // snaps the spark back to 0deg and reads as a flicker.
  }

  // One blink. Cancel whatever is still playing on this lid first — WAAPI
  // defaults to composite: replace, and without the cancel the two compose into a
  // stuck intermediate. The gap (≥1200) now far exceeds the duration (480) so
  // they cannot actually collide; the cancel is insurance.
  const blink = () =>
    lids.forEach((g) => {
      g.getAnimations().forEach((a) => a.cancel())
      g.animate(MC_BLINK, { duration: MC_BLINK_MS })
    })

  const cycle = () =>
    props.busy
      ? MC_BLINK_MS + MC_CYCLE_BUSY
      : (props.mode === 'halt' ? 3500 : 2400) + Math.random() * (props.mode === 'halt' ? 3500 : 2200)

  const idle = () => {
    timers.push(
      setTimeout(() => {
        if (dead) return
        blink()
        idle()
      }, cycle()),
    )
  }

  const shake = () => {
    if (dead || props.mode !== 'halt') return
    eyes.forEach((g) => {
      g.getAnimations().forEach((a) => a.cancel())
      g.animate(MC_SWAY, { duration: MC_SHAKE_MS, easing: 'cubic-bezier(.4,0,.2,1)' })
    })
    // A blink right after the shake — this one is the sigh that ends the gesture,
    // a different beat from the idle "it's sitting there" blink, so it is
    // scheduled separately.
    timers.push(setTimeout(blink, MC_SHAKE_MS - 60))
    timers.push(setTimeout(shake, MC_SHAKE_MS + MC_SHAKE_GAP))
  }

  // Shake once on entry — failure page only.
  if (props.mode === 'halt') timers.push(setTimeout(shake, 400))
  if (live) idle()
}

function stop() {
  dead = true
  clearAll()
}

onMounted(start)
onBeforeUnmount(stop)

/**
 * `busy` and `mode` restart the whole thing on purpose: `busy` IS the run/stop
 * switch, so flipping it true schedules the loops and flipping it false lets the
 * teardown collect every timer, leaving the animation stopped where it was.
 * The cost is that the entry gesture replays on start; since it runs straight into
 * the loop, that is not visible.
 */
watch(
  () => [props.mode, props.busy],
  () => {
    stop()
    start()
  },
)

const scale = () => props.size / MC_FULL_VH
const width = () => Math.round((props.size * MC.vw) / MC_FULL_VH)

/**
 * Transparent margin inside the viewBox, in user units: left 72, right 100 (the
 * spark reaches ~478 once scaled), top 34 (spark tip), bottom 101 (body ends at
 * 499 of 600). Times the scale gives the px to cancel.
 *
 * ⚠️ The bottom is only HALF cancelled: the ground glow is painted down there and
 * cancelling all of it would clip it.
 *
 * `nudgeY` is an optical correction and is MEASURED, not guessed:
 * `align-items: center` centres the BOX, but the ball sits high inside the viewBox
 * (y 107..499, with 101 units below it reserved for the ground) — so a centred box
 * puts the ball visually low next to adjacent text. Measured 2.7px low at the 46px
 * step, hence -3. Re-measure when changing size: the offset scales with it.
 */
const boxStyle = () => {
  if (!props.pad) return undefined
  const s = scale()
  return {
    marginLeft: `${-Math.round(72 * s)}px`,
    marginRight: `${-Math.round(100 * s)}px`,
    marginTop: `${-Math.round(34 * s) + props.nudgeY}px`,
    marginBottom: `${-Math.round((props.ground ? 50 : 101) * s) - props.nudgeY}px`,
  }
}
</script>

<template>
  <div ref="host" class="kp-mascot-face" aria-hidden="true" :style="boxStyle()">
    <svg
      :width="width()"
      :height="size"
      :viewBox="`0 0 ${MC.vw} ${MC_FULL_VH}`"
      fill="none"
      :style="{ display: 'block', transform: flip ? 'scaleX(-1)' : undefined }"
    >
      <KpMascotArt :uid="uid" :eye="eye" spark :clip="false" :ground="ground" />
    </svg>
  </div>
</template>

<style scoped lang="scss">
.kp-mascot-face {
  flex: 0 0 auto;
  user-select: none;
  display: flex;
}
</style>
