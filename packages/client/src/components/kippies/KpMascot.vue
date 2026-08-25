<script setup lang="ts">
/**
 * The home mascot: flat-bottomed, sits on the composer's top edge, eyes track the
 * pointer.
 *
 * Body-follow and blinking are deliberately off here — on the home screen this is
 * a "keeping you company" role, and the more it moves the more it competes with
 * the composer. Eye tracking alone is enough.
 *
 * ⚠️ It is positioned `absolute` (`bottom: 100%`) against its wrapper, and that is
 * required rather than incidental: the moment it joins layout it pushes the
 * composer down, and the composer's vertical position is a fixed rhythm
 * (wordmark 104 + 32 gap). `pointer-events: none` for the same reason — it
 * overhangs the composer's top edge and must be clickable through.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import KpMascotArt from './KpMascotArt.vue'
import { MC, mcUid } from './mascot'

const props = withDefaults(defineProps<{ height?: number }>(), { height: 72 })

const uid = mcUid('mch')
const host = ref<HTMLElement | null>(null)

let raf = 0
let cleanup: (() => void) | null = null

onMounted(() => {
  const el = host.value
  if (!el) return
  const svg = el.querySelector('svg')
  const eyes = Array.from(el.querySelectorAll<SVGElement>('.mceye'))
  if (!svg || !eyes.length) return

  // Reduced motion switches tracking off entirely: this is pure garnish, and
  // continuous pointer-following is a real discomfort for vestibular sensitivity.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

  let inside = false
  let mx = 0
  let my = 0
  const cur = { x: 0, y: 0 }
  const tgt = { x: 0, y: 0 }

  // Record coordinates only — never write style in mousemove. One gesture fires
  // dozens of events, and writing a transform in each is dozens of layouts. The
  // actual write happens in the rAF, once per frame.
  const onMove = (ev: MouseEvent) => {
    mx = ev.clientX
    my = ev.clientY
    inside = true
  }
  const onOut = () => {
    inside = false
  }

  window.addEventListener('mousemove', onMove, { passive: true })
  window.addEventListener('mouseleave', onOut)
  window.addEventListener('blur', onOut)

  const tick = () => {
    const r = svg.getBoundingClientRect()
    if (r.width) {
      if (!inside) {
        tgt.x = 0
        tgt.y = 0
      } else {
        // Reference point is the EYES' height (viewBox y=288 / 392 ≈ 0.735), not
        // the geometric centre — using the centre gives a skewed direction when
        // the pointer is directly below.
        const cx = r.left + r.width / 2
        const cy = r.top + r.height * 0.735
        const dx = mx - cx
        const dy = my - cy
        const d = Math.hypot(dx, dy) || 1
        // Angle plus distance falloff: 1.6x its own width is "looking as hard as
        // it can", beyond that it only holds the heading. A linear map on raw
        // coordinates pins the eyes at their limit whenever the pointer is near a
        // screen corner.
        const reach = Math.min(1, d / (r.width * 1.6))
        tgt.x = (dx / d) * reach
        tgt.y = (dy / d) * reach
      }
      // Close 18% of the remaining distance each frame. Assigning directly tracks
      // too rigidly, like being dragged by the pointer; a little inertia reads as
      // looking.
      cur.x += (tgt.x - cur.x) * 0.18
      cur.y += (tgt.y - cur.y) * 0.18
      for (const g of eyes) {
        g.setAttribute(
          'transform',
          `translate(${(cur.x * MC.eyeMx).toFixed(2)} ${(cur.y * MC.eyeMy).toFixed(2)})`,
        )
      }
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  cleanup = () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseleave', onOut)
    window.removeEventListener('blur', onOut)
  }
})

onBeforeUnmount(() => cleanup?.())

const width = () => Math.round((props.height * MC.vw) / MC.vh)

/**
 * Inset the BODY 20px from the composer's right edge, not the svg's box — the box
 * carries ~19% transparent margin on the right. Derived, so it follows a change of
 * height (or of artwork, if bodyR moves).
 */
const rightInset = () =>
  Math.max(0, Math.round(20 - ((MC.vw - MC.bodyR) / MC.vw) * width()))
</script>

<template>
  <div class="kp-mascot" aria-hidden="true" ref="host" :style="{ right: `${rightInset()}px` }">
    <svg
      :width="width()"
      :height="height"
      :viewBox="`0 0 ${MC.vw} ${MC.vh}`"
      fill="none"
      style="display: block"
    >
      <!-- Home treatment: clipped flat (it sits on the composer's edge), spark
           present but not spinning, no ground. -->
      <KpMascotArt :uid="uid" eye="open" spark clip :ground="false" />
    </svg>
  </div>
</template>

<style scoped lang="scss">
.kp-mascot {
  position: absolute;
  bottom: 100%;
  z-index: 2;
  pointer-events: none;
  user-select: none;
}
</style>
