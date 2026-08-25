<script setup lang="ts">
/**
 * Home wordmark.
 *
 * Ported from the React prototype's `WarpText`: a hand-written WebGL2 warp
 * shader rasterizes "Kippies Work" (Outfit weight 900) to a 2D canvas with a
 * linear gradient, uploads it as a texture, and animates a full-screen triangle
 * with pointer interaction + idle Lissajous drift + ripple.
 *
 * The static `.warpfall` gradient span stays in the DOM as the fallback — shown
 * (and the canvas skipped) when WebGL2 is unavailable, the shader fails to
 * compile/link, or the context is lost. The fallback uses the same gradient at
 * the same angle, just not moving: a fallback that changes color is the hardest
 * kind of inconsistency to track down.
 *
 * 56px because this is the one brand slot on the page; the 28px step reads as
 * an ordinary heading. Only the wordmark uses Outfit — it is deliberately kept
 * out of the token layer so it cannot be picked up for body text elsewhere.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    text?: string
    fontSize?: number
  }>(),
  { text: 'Kippies Work', fontSize: 56 },
)

// Dynamic params aligned to the prototype's reactbits config (colors/size fixed,
// only the "motion" layer moves).
const LETTER_SPACING = -0.02
const WEIGHT = 900
const WARP_STRENGTH = 0.12
const WARP_SCALE = 1.7
const SPEED = 0.55
const POINTER_INFLUENCE = 0.59
const POINTER_STRENGTH = 0.6
const REFRACTION = 0.016
const RIPPLE = true

const WARP_VERT = `#version 300 es
in vec2 position;
out vec2 vUv;
void main(){ vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`

const WARP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTextTexture;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uTime;
uniform float uWarpStrength;
uniform float uWarpScale;
uniform float uSpeed;
uniform float uPointerInfluence;
uniform float uPointerStrength;
uniform float uRefraction;
uniform float uRipple;
uniform float uMotion;
in vec2 vUv;
out vec4 fragColor;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float value = 0.0; float amplitude = 0.5;
  for (int i = 0; i < 4; i++){ value += amplitude * noise(p); p *= 2.02; amplitude *= 0.5; }
  return value;
}
vec4 sampleText(vec2 uv){
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uTextTexture, uv);
}
void main(){
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float time = uTime * uSpeed;
  float scale = max(uWarpScale, 0.001);
  vec2 drift = vec2(time * 0.055, -time * 0.045);
  float n1 = fbm(uv * scale * 3.1 + drift);
  float n2 = fbm((uv + 19.17) * scale * 3.4 - drift.yx);
  vec2 ambient = (vec2(n1, n2) - 0.5) * uWarpStrength * 0.045 * uMotion;
  vec2 pointerDelta = uv - uPointer;
  vec2 aspectDelta = vec2(pointerDelta.x * aspect, pointerDelta.y);
  float dist = length(aspectDelta);
  float radius = max(uPointerInfluence, 0.001);
  float t = clamp(dist / radius, 0.0, 1.0);
  float lens = smoothstep(radius, 0.0, dist) * uPointerActive;
  float bulge = t * (1.0 - t) * (1.0 - t) * 6.75 * uPointerActive;
  vec2 dir = dist > 0.0001 ? vec2(aspectDelta.x / aspect, aspectDelta.y) / dist : vec2(0.0);
  float rippleWave = sin(dist * 28.0 - time * 4.2) * 0.5 + 0.5;
  float rippleRing = (rippleWave - 0.5) * uRipple;
  vec2 pointerWarp = -dir * bulge * uPointerStrength * 0.045;
  pointerWarp += dir * rippleRing * bulge * uPointerStrength * 0.016;
  vec2 displaced = uv + ambient + pointerWarp;
  vec2 splitDir = ambient + pointerWarp;
  float splitLen = length(splitDir);
  splitDir = splitLen > 0.00001 ? splitDir / splitLen : vec2(0.7071, 0.7071);
  vec2 split = splitDir * uRefraction * 0.16 * (0.35 + lens * 0.9);
  vec4 base = sampleText(displaced);
  vec4 sa = sampleText(displaced + split);
  vec4 sb = sampleText(displaced - split);
  float a = base.a;
  vec3 color = vec3(sa.r, base.g, sb.b) + lens * base.a * 0.055;
  fragColor = vec4(color, a);
}
`

// --grad-brand stops (light) / --grad-brand-dark stops (dark). The WebGL stops
// must match the CSS --grad-brand / --grad-brand-dark verbatim, or the wordmark
// shifts color when it degrades to the static fallback span.
type Stop = readonly [number, string]
const WARP_STOPS_LIGHT: readonly Stop[] = [
  [0, '#6D51F4'],
  [1, '#5A87F9'],
]
const WARP_STOPS_DARK: readonly Stop[] = [
  [0, '#B7B0FF'],
  [0.45, '#6D51F4'],
  [0.72, '#5A87F9'],
  [1, '#A5BEFF'],
]
// Direction turned from the token's 194.6deg to 105deg: the wordmark is 7x wider
// than tall, so a near-vertical gradient wastes the stops; horizontal walks them
// across "Kippies Work".
const WARP_ANGLE = 105

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function warpGradient(
  ctx: CanvasRenderingContext2D,
  box: Box,
  stops: readonly Stop[],
): CanvasGradient {
  const rad = (WARP_ANGLE * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad) // CSS angle: 0deg points up, clockwise
  const len = Math.abs(box.w * dx) + Math.abs(box.h * dy)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const g = ctx.createLinearGradient(
    cx - (dx * len) / 2,
    cy - (dy * len) / 2,
    cx + (dx * len) / 2,
    cy + (dy * len) / 2,
  )
  stops.forEach(([at, c]) => g.addColorStop(at, c))
  return g
}

const hostRef = ref<HTMLDivElement | null>(null)
const failed = ref(false)

let cleanup: (() => void) | null = null

onMounted(() => {
  const host = hostRef.value
  if (!host) return

  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
  })
  if (!gl) {
    // jsdom / no WebGL2 — fall back to the static span cleanly.
    failed.value = true
    return
  }

  let disposed = false
  let lost = false
  let raf = 0
  let visible = true
  let pageVisible = !document.hidden
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  let reduce = mq ? mq.matches : false

  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
  })
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)

  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)
    if (!s) throw new Error('shader')
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader')
    }
    return s
  }

  let prog: WebGLProgram | null = null
  try {
    prog = gl.createProgram()
    if (!prog) throw new Error('program')
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, WARP_VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, WARP_FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'link')
    }
  } catch {
    if (canvas.parentNode === host) host.removeChild(canvas)
    failed.value = true
    return
  }
  gl.useProgram(prog)

  // Single full-screen triangle (one fewer interpolation branch than a quad).
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const posLoc = gl.getAttribLocation(prog, 'position')
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true) // canvas row 0 is the top; flip v

  const uniformNames = [
    'uTextTexture',
    'uResolution',
    'uPointer',
    'uPointerActive',
    'uTime',
    'uWarpStrength',
    'uWarpScale',
    'uSpeed',
    'uPointerInfluence',
    'uPointerStrength',
    'uRefraction',
    'uRipple',
    'uMotion',
  ] as const
  type UniformName = (typeof uniformNames)[number]
  const U = {} as Record<UniformName, WebGLUniformLocation | null>
  uniformNames.forEach((n) => {
    U[n] = gl.getUniformLocation(prog as WebGLProgram, n)
  })

  gl.uniform1i(U.uTextTexture, 0)
  gl.uniform1f(U.uWarpStrength, WARP_STRENGTH)
  gl.uniform1f(U.uWarpScale, WARP_SCALE)
  gl.uniform1f(U.uSpeed, SPEED)
  gl.uniform1f(U.uPointerInfluence, POINTER_INFLUENCE)
  gl.uniform1f(U.uPointerStrength, POINTER_STRENGTH)
  gl.uniform1f(U.uRefraction, REFRACTION)
  gl.uniform1f(U.uRipple, RIPPLE ? 1 : 0)
  gl.uniform1f(U.uMotion, reduce ? 0 : 1)
  gl.clearColor(0, 0, 0, 0)
  // No blend: single draw over a cleared transparent buffer, straight-alpha write.
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)

  const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, active: 0, activeTarget: 0 }
  const t0 = performance.now()
  let version = 0

  const draw = () => {
    if (!disposed && !lost) {
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }

  const measure = (ctx: CanvasRenderingContext2D, ls: number): number => {
    const chars = Array.from(props.text)
    return (
      chars.reduce((w, c) => w + ctx.measureText(c).width, 0) + Math.max(0, chars.length - 1) * ls
    )
  }

  const rasterize = async () => {
    const v = ++version
    if (document.fonts) {
      try {
        await document.fonts.load(WEIGHT + ' ' + props.fontSize + 'px Outfit', props.text)
        await document.fonts.ready
      } catch {
        /* font not ready — use the fallback letterform, don't block */
      }
    }
    if (disposed || lost || v !== version) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const tc = document.createElement('canvas')
    tc.width = Math.max(1, Math.floor(rect.width * dpr))
    tc.height = Math.max(1, Math.floor(rect.height * dpr))
    const ctx = tc.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.imageSmoothingQuality = 'high'
    let fs = props.fontSize
    let ls = LETTER_SPACING * props.fontSize
    // canvas ctx.font does not accept var() — spell the font stack out.
    const applyFont = () => {
      ctx.font = WEIGHT + ' ' + fs + 'px Outfit, "Keep Sans", system-ui, sans-serif'
    }
    applyFont()
    // Container keeps margin (glyphs fill 86% x 78%) so displaced pixels don't clip.
    const fit = Math.min(
      1,
      (rect.width * 0.86) / Math.max(measure(ctx, ls), 1),
      (rect.height * 0.78) / Math.max(fs, 1),
    )
    if (fit < 1) {
      fs *= fit
      ls *= fit
      applyFont()
    }
    const w = measure(ctx, ls)
    const x0 = rect.width / 2 - w / 2
    const cy = rect.height / 2
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    // Gradient spans the glyph bounding box, not the whole canvas.
    ctx.fillStyle = warpGradient(
      ctx,
      { x: x0, y: cy - fs * 0.5, w, h: fs },
      dark ? WARP_STOPS_DARK : WARP_STOPS_LIGHT,
    )
    let cur = x0
    const chars = Array.from(props.text)
    chars.forEach((c, i) => {
      ctx.fillText(c, cur, cy)
      cur += ctx.measureText(c).width + (i === chars.length - 1 ? 0 : ls)
    })
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc)
    draw()
  }

  const resize = () => {
    if (disposed || lost) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(rect.width * dpr)
    canvas.height = Math.floor(rect.height * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(U.uResolution, canvas.width, canvas.height)
    void rasterize()
  }

  const loop = (now: number) => {
    if (disposed || lost) return
    const el = (now - t0) * 0.001
    // No pointer: a very slow Lissajous drift keeps it alive, amplitude only ±0.12.
    const idleX = 0.5 + Math.sin(el * 0.33) * 0.12
    const idleY = 0.5 + Math.cos(el * 0.27) * 0.1
    const on = pointer.activeTarget > 0
    const damp = on ? 0.12 : 0.035
    pointer.x += ((on ? pointer.tx : idleX) - pointer.x) * damp
    pointer.y += ((on ? pointer.ty : idleY) - pointer.y) * damp
    pointer.active += ((on ? 1 : 0.18) - pointer.active) * 0.06
    gl.uniform2f(U.uPointer, pointer.x, pointer.y)
    gl.uniform1f(U.uPointerActive, reduce ? pointer.active * 0.35 : pointer.active)
    gl.uniform1f(U.uTime, reduce ? 0 : el)
    draw()
    raf = requestAnimationFrame(loop)
  }

  const start = () => {
    if (!raf && visible && pageVisible && !disposed && !lost) raf = requestAnimationFrame(loop)
  }
  const stop = () => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    const r = canvas.getBoundingClientRect()
    if (r.width <= 0) return
    pointer.tx = (e.clientX - r.left) / r.width
    pointer.ty = 1 - (e.clientY - r.top) / r.height
    pointer.activeTarget = 1
  }
  const onLeave = () => {
    pointer.activeTarget = 0
  }
  const onLost = (e: Event) => {
    e.preventDefault()
    lost = true
    stop()
    failed.value = true
  }
  const onVis = () => {
    pageVisible = !document.hidden
    if (pageVisible) start()
    else stop()
  }
  const onReduce = (e: MediaQueryListEvent) => {
    reduce = e.matches
    gl.uniform1f(U.uMotion, reduce ? 0 : 1)
    draw()
  }
  const onTheme = () => {
    void rasterize()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(host)
  const io = new IntersectionObserver(
    ([en]) => {
      visible = en.isIntersecting
      if (visible) start()
      else stop()
    },
    { threshold: 0 },
  )
  io.observe(host)
  const mo = new MutationObserver(onTheme)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('webglcontextlost', onLost, false)
  document.addEventListener('visibilitychange', onVis)
  mq && mq.addEventListener('change', onReduce)

  resize()
  start()

  cleanup = () => {
    disposed = true
    stop()
    ro.disconnect()
    io.disconnect()
    mo.disconnect()
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerleave', onLeave)
    canvas.removeEventListener('webglcontextlost', onLost)
    document.removeEventListener('visibilitychange', onVis)
    mq && mq.removeEventListener('change', onReduce)
    if (!lost) {
      try {
        gl.deleteTexture(tex)
        gl.deleteBuffer(buf)
        gl.deleteProgram(prog)
        const ext = gl.getExtension('WEBGL_lose_context')
        ext && ext.loseContext()
      } catch {
        /* cleanup failures on unmount shouldn't affect anything else */
      }
    }
    if (canvas.parentNode === host) host.removeChild(canvas)
  }
})

onBeforeUnmount(() => {
  if (cleanup) {
    cleanup()
    cleanup = null
  }
})
</script>

<template>
  <div
    ref="hostRef"
    class="kp-warp"
    role="img"
    :aria-label="text"
    :style="{ height: `${Math.round(fontSize * 1.857)}px` }"
  >
    <!--
      WebGL unavailable (old machine, blacklisted GPU, context lost) falls back
      to this static gradient wordmark — same gradient, same size, just still.
      Kept in the DOM so the wordmark text is available to screen readers.
    -->
    <span
      class="kp-warp__text warpfall"
      :style="{ fontSize: `${fontSize}px`, display: failed ? 'grid' : 'none' }"
      >{{ text }}</span
    >
  </div>
</template>

<style scoped lang="scss">
// The Outfit @font-face moved to keep-tokens.scss. It lived here, but an SFC's
// styles are only injected once the module is loaded — so with the home hero
// switched to KpSplitText, the face that KpSplitText itself needs would come and
// go with whether this component happens to be imported anywhere.

// The 620 cap is load-bearing, not cosmetic: the canvas fills the host and the
// shader scales the glyphs to `rect.width * 0.86`, so the host's width *is* the
// wordmark's size. Left to stretch to its 800 column the mark comes out about a
// third too large.
.kp-warp {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
}

.kp-warp__text {
  place-items: center;
  font-family: 'Outfit', var(--font-latin);
  font-weight: 900;
  letter-spacing: -0.02em;
  line-height: 1;
  white-space: nowrap;
}
</style>
