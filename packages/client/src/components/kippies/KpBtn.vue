<script setup lang="ts">
/**
 * Keep pill button, aligned column-by-column with the DS §9.1 size table:
 *
 *   size  height  font/weight   side pad  icon  icon gap
 *   XL    50      16 / Medium   28        24    4
 *   L     48      16 / Medium   28        24    4
 *   M     36      14 / Medium   20        20    2
 *   S     28      12 / Medium   13        16    2
 *   XS    24      10 / Medium   13        12    2
 *
 * §9.1 states icon size = font size × 1.5 and radius = height / 2 (a full
 * pill). XL is the sanctioned dock-bottom step — use it there rather than
 * stretching L.
 *
 * Padding drops 4 on whichever side carries an icon. Icon glyphs ship with
 * their own ring of whitespace, so equal numeric padding reads as wider on
 * the icon side; taking 4 back makes the two sides *look* equal. That last
 * part is an implementation detail, not something §9.1 specifies.
 *
 * ── The four states ────────────────────────────────────────────────────────
 * Success and failure both stay ON the button. No bottom-docked toast, no line
 * of red text beside it: you pressed this, and this is what answers, so you
 * never have to pair the two up yourself.
 *
 *   idle     icon (optional) + label
 *   pending  full_loading_circle spinning + the ORIGINAL label + disabled
 *   ok       line_check + okLabel, colour UNCHANGED
 *   fail     the whole button flips to `danger` + full_warning + failLabel
 *
 * Success does not recolour: it is the expected outcome and does not need to
 * shout, and a dark button has nowhere to put green text anyway — recolouring
 * would need a rule per kind, whereas changing the label does not.
 * Failure *does* flip kind, because it has to be findable in a full screen;
 * `danger` is the §3 step that exists for exactly this.
 * Failure does not self-clear — pressing again is the retry — and it does not
 * state a reason: the button only says "that one didn't take".
 *
 * `okLabel` / `failLabel` are props rather than copy baked in here. The
 * prototype hardcodes 已安装 / 没成功 inside the atom, which cannot be
 * translated — and this app ships ten locales. With no label supplied, that
 * state keeps the idle text; the danger tint and the warning glyph still carry
 * the meaning on their own.
 */
import { computed } from 'vue'
import KpIcon from './KpIcon.vue'
import type { ActionState } from './useAction'

type Kind = 'primary' | 'dark' | 'soft' | 'line' | 'chip' | 'ghost' | 'danger'
type Size = 'xl' | 'l' | 'm' | 's' | 'xs'

const props = withDefaults(
  defineProps<{
    kind?: Kind
    size?: Size
    icon?: string
    iconEnd?: string
    disabled?: boolean
    full?: boolean
    /** Drive the four states — pair with `useAction`. */
    state?: ActionState
    /** Label for the `ok` state. Supplying either label makes the button width-stable. */
    okLabel?: string
    /** Label for the `fail` state. */
    failLabel?: string
  }>(),
  { kind: 'soft', size: 'm', state: 'idle' },
)

defineEmits<{ click: [MouseEvent] }>()

const STATE_ICON: Partial<Record<ActionState, { icon: string; spin?: boolean }>> = {
  pending: { icon: 'full_loading_circle', spin: true },
  ok: { icon: 'line_check' },
  fail: { icon: 'full_warning' },
}

/**
 * Having either label means this button is stateful — and then it has to hold
 * ONE width from start to finish. The text changes length (保存 → 已保存 →
 * 没保存上); letting the width follow makes a right-aligned column jump on
 * every press.
 */
const stateful = computed(() => !!(props.okLabel || props.failLabel))
const stateIcon = computed(() => STATE_ICON[props.state])
const kindNow = computed<Kind>(() => (props.state === 'fail' ? 'danger' : props.kind))
const iconNow = computed(() => stateIcon.value?.icon ?? props.icon)
const isDisabled = computed(() => props.disabled || props.state === 'pending')
/** `pending` is not greyed out — greyed reads as broken, and it is working fine. */
const isDimmed = computed(() => isDisabled.value && props.state !== 'pending')

/**
 * A stateful button always keeps an icon slot, even in `idle` where there may
 * be none: pending / ok / fail all carry one, so without a reserved slot the
 * left padding gains 4px the moment the state changes and the button hops.
 */
const iconSlot = computed(() => iconNow.value || (stateful.value ? 'line_add' : null))
/** In `pending` the label stays the idle one — the spinner already says "working". */
const labelState = computed<ActionState>(() => (props.state === 'pending' ? 'idle' : props.state))

interface BtnSpec {
  h: number
  fs: number
  pad: number
  ic: number
  gap: number
}

const SPEC: Record<Size, BtnSpec> = {
  xl: { h: 50, fs: 16, pad: 28, ic: 24, gap: 4 },
  l: { h: 48, fs: 16, pad: 28, ic: 24, gap: 4 },
  m: { h: 36, fs: 14, pad: 20, ic: 20, gap: 2 },
  s: { h: 28, fs: 12, pad: 13, ic: 16, gap: 2 },
  xs: { h: 24, fs: 10, pad: 13, ic: 12, gap: 2 },
}

const spec = computed<BtnSpec>(() => SPEC[props.size] ?? SPEC.m)
const iconSize = computed(() => spec.value.ic)

const style = computed(() => {
  const sp = spec.value
  return {
    height: `${sp.h}px`,
    paddingLeft: `${sp.pad - (iconSlot.value ? 4 : 0)}px`,
    paddingRight: `${sp.pad - (props.iconEnd ? 4 : 0)}px`,
    gap: `${sp.gap}px`,
    fontSize: `${sp.fs}px`,
    display: props.full ? 'flex' : 'inline-flex',
    width: props.full ? '100%' : undefined,
  }
})
</script>

<template>
  <!--
    Icons on dark/primary buttons are white on an ink ground, so they must
    carry `onink` to switch off stroke thinning — otherwise that ring of
    ground-colored stroke paints white around a white glyph, reading heavier
    rather than lighter.
  -->
  <button
    class="ab kp-btn"
    :class="[
      `kp-btn--${kindNow}`,
      { 'is-disabled': isDimmed, onink: kindNow === 'dark' || kindNow === 'primary' },
    ]"
    :disabled="isDisabled"
    :style="style"
    @click="$emit('click', $event)"
  >
    <!--
      The reserved slot keeps its width while `idle` has no icon of its own:
      `visibility: hidden` still occupies the box, whereas `v-if` would let the
      button resize the instant the state changes.
    -->
    <KpIcon
      v-if="iconSlot"
      :name="iconSlot"
      :size="iconSize"
      :class="{ spin: stateIcon?.spin }"
      :style="{ visibility: iconNow ? undefined : 'hidden' }"
    />
    <!--
      The width is held by CSS, not measured in JS: all three labels stack in one
      grid cell, the widest sets the width, and only the current one is visible.
      Measuring would mean waiting on `document.fonts.ready` to be accurate —
      before the icon font settles, glyph widths come back from the fallback face
      and land a few px off, and only on the first paint, which is the hardest
      kind of bug to catch.
    -->
    <span v-if="stateful" class="kp-btn__labels">
      <span :style="{ visibility: labelState === 'idle' ? undefined : 'hidden' }"><slot /></span>
      <span v-if="okLabel" :style="{ visibility: labelState === 'ok' ? undefined : 'hidden' }">{{
        okLabel
      }}</span>
      <span
        v-if="failLabel"
        :style="{ visibility: labelState === 'fail' ? undefined : 'hidden' }"
        >{{ failLabel }}</span
      >
    </span>
    <slot v-else />
    <KpIcon v-if="iconEnd" :name="iconEnd" :size="iconSize" />
  </button>
</template>

<style scoped lang="scss">
.kp-btn {
  padding-top: 0;
  padding-bottom: 0;
  border: 0;
  border-radius: var(--r-pill);
  justify-content: center;
  align-items: center;
  font-family: var(--font-cn);
  font-weight: var(--w-medium);
  line-height: var(--lh-1);
  white-space: nowrap;
  cursor: pointer;
  // The kind flips on failure, so the recolour has to be a transition or the
  // button snaps from soft grey to danger red in one frame.
  transition: background var(--motion-fast) var(--ease-std),
    color var(--motion-fast) var(--ease-std);

  &.is-disabled {
    opacity: 0.4;
    cursor: default;
  }
}

// All three labels occupy the same grid cell, so the widest one sets the width
// and switching state cannot resize the button.
.kp-btn__labels {
  display: grid;
  align-items: center;
  justify-items: center;

  > span {
    grid-area: 1 / 1;
  }
}

.kp-btn--primary {
  background: var(--action);
  color: var(--action-fg);
}

.kp-btn--dark {
  background: var(--gray-33);
  color: var(--white);
}

.kp-btn--soft {
  background: var(--surface-2);
  color: var(--fg-primary);
}

.kp-btn--line {
  background: var(--bg);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 1px var(--divider);
}

.kp-btn--chip {
  background: var(--bg);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 1px var(--divider);
}

.kp-btn--ghost {
  background: transparent;
  color: var(--fg-secondary);
}

.kp-btn--danger {
  background: var(--danger-bg);
  color: var(--danger);
}
</style>
