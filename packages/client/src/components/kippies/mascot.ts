/**
 * Mascot geometry and motion timings — one declaration site for both usages.
 *
 * All motion runs through `element.animate()` (Web Animations API), NOT a CSS
 * class plus `@keyframes`. Learned the hard way: after putting a class on an
 * element inside an <svg>, the computed `animation-name` was correct yet
 * `getAnimations()` came back empty and `transform` stayed `none` — the animation
 * simply never ran. Replaying via a class also needs the
 * remove-class / force-reflow / re-add-class hack, which is a hack by itself.
 */

/** Artwork frame. Body spans x 72..468, so the right 19% of the box is empty. */
export const MC = { vw: 578, vh: 392, bodyL: 72, bodyR: 468, eyeMx: 34, eyeMy: 26 } as const

/**
 * Full-shape viewBox height. The outer body ellipse carries a 37-stdDeviation
 * blur that reaches to y≈548, so the ground has to be drawn beyond that to read
 * at all (499 and 523 were both swallowed by the blur) — hence 600 when the
 * bottom is not clipped.
 */
export const MC_FULL_VH = 600

/**
 * The head-shake moves the EYES, not the whole mascot. The first attempt rotated
 * and translated the entire character around its base: that reads as "this image
 * is moving", not "it is shaking its head" — a translating body reads as an
 * object being pushed. Body still, expression moving, is what makes it the
 * mascot's own gesture.
 *
 * Offsets are in viewBox user units (a <g> transform is in user units), so they
 * survive a change of render size: at 90px tall, 1 unit ≈ 0.15px, so ±30 units
 * ≈ ±4.5px against an eye 39 units ≈ 5.9px wide — a sway of nearly one eye width.
 */
export const MC_SWAY: Keyframe[] = [0, -30, 25, -18, 11, -5, 0].map((v, i, a) => ({
  transform: `translateX(${v}px)`,
  offset: i / (a.length - 1),
}))

/** 720 → 1050 → 1400. Slow reads as "no good"; fast reads as a twitch. */
export const MC_SHAKE_MS = 1400
/** Pause after a shake before the next one. */
export const MC_SHAKE_GAP = 2000
/**
 * Failure page: how long one spark revolution takes. Deliberately NOT tied to the
 * shake — a slow head against a quick spark is the contrast that reads as
 * "still trying".
 */
export const MC_SPARK_MS = 1500
/** Avatar: one revolution. */
export const MC_SPARK_ONCE = 620
/** Thinking: pause between revolutions. */
export const MC_SPARK_GAP_BUSY = 500

export const MC_SPARK_ORIGIN = { cx: 432, cy: 79 } as const

/**
 * A blink is ONE close, a long pause, then another. Never a double-blink.
 *
 * Double blinks were tried (two at 220ms, and "two + pause + one") and all of
 * them read as a twitch: on a 46px avatar the eye is only a few px tall, and two
 * deformations inside 220ms read as "that block of pixels jittered", not "it
 * blinked twice". The smaller the motion, the more it needs a single gesture with
 * a long gap — leaning on repetition to add presence is large-format advice and
 * inverts at small sizes.
 *
 * Three things make it smooth:
 *   1. 480ms (was 260) — 260ms split across close / hold / open is under 10 frames
 *      each, which at this size is a few jumped frames.
 *   2. Per-keyframe easing, not one easing for the whole run — the closing leg
 *      eases in (accelerating, like a lid falling), the opening leg eases out.
 *      One shared curve forces a hard inflection at the turn.
 *   3. Squash to 0.12, not 0.06 — the eye is 74 units tall, so 0.06 leaves 4.4
 *      units and the rounded rect degenerates into a line that reads as
 *      "vanished for a frame". 0.12 leaves 9 units: a slit.
 * The hold in the middle is 0.06 of the offset (~25ms): longer becomes "eyes
 * closed" rather than a blink, but with no hold at all the lowest point shows a
 * corner.
 */
export const MC_BLINK_MS = 480
export const MC_BLINK: Keyframe[] = [
  { transform: 'scaleY(1)', offset: 0, easing: 'cubic-bezier(.45,.05,.55,.95)' },
  { transform: 'scaleY(0.12)', offset: 0.38, easing: 'linear' },
  { transform: 'scaleY(0.12)', offset: 0.44, easing: 'cubic-bezier(.35,.45,.35,1)' },
  { transform: 'scaleY(1)', offset: 1 },
]

/**
 * Gap between blinks, measured from the previous one's START (so the 480ms
 * duration has to be added back in).
 *   thinking — a flat 1200ms → roughly one blink every 1.6s: quiet but alive
 *   idle     — 2.4–4.6s random; an even interval is legible as a loop
 *   failure  — 3.5–7s random; that page's lead is the head-shake, the blink only
 *              keeps it from being a dead image
 */
export const MC_CYCLE_BUSY = 1200

/**
 * Whether the Web Animations API is actually usable on this element.
 *
 * jsdom implements neither `Element.animate` nor `Element.getAnimations`, so every
 * one of these components would throw on mount under test. Feature-detecting is
 * also the honest degradation: without WAAPI the artwork still renders, just
 * still — which is exactly what reduced-motion asks for anyway.
 */
export function canAnimate(el: Element | null | undefined): boolean {
  return (
    !!el &&
    typeof (el as HTMLElement).animate === 'function' &&
    typeof el.getAnimations === 'function'
  )
}

export function mcReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

let seq = 0
/** SVG ids are document-scoped — every instance needs its own prefix. */
export function mcUid(prefix: string): string {
  seq += 1
  return `${prefix}${seq}`
}
