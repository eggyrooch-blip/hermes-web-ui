<script setup lang="ts">
/**
 * Sidebar navigation row.
 *
 * Padding and justification are identical in both states. Collapsed, the
 * rail's inner width is 40 and the row's left padding is 12, so the glyph
 * centers on 32 — exactly the middle of the 64px rail. There is no switch
 * to `center` and the icon does not move at all during the animation.
 * (Snapping the padding from 12 to 0 made the icon jump 12px sideways.)
 *
 * The glyph is 18, not 14's usual companion 16: a nav icon is the row's
 * primary identifier — collapsed it is the row's only content — and 16
 * next to a 14px label reads lighter than the text it labels. §9.1's
 * "icon = font size x 1.5" governs icons *inside buttons*, where the glyph
 * is the supporting element; it does not apply here.
 *
 * It renders through KpNavIcon, not KpIcon: the hand-drawn SVGs are what
 * the `.navico` stroke-draw hover animates. A font glyph has its stroke
 * baked in and only gets the fallback lift. The wrapping `.navico` span is
 * a required layout box, not decoration — it holds 18x18 steady while the
 * inner shape moves, so the icon animation and the 300ms rail-width
 * transition do not fight over the same element.
 */
import KpNavIcon from './KpNavIcon.vue'
import { useLabelFade } from './useLabelFade'

const props = defineProps<{
  icon: string
  label: string
  active?: boolean
  hint?: string
  collapsed?: boolean
}>()

defineEmits<{ click: [] }>()

const labelStyle = useLabelFade(() => !!props.collapsed)
</script>

<template>
  <div
    class="row kp-nav-row"
    :class="{ 'is-active': active, 'is-collapsed': collapsed }"
    :title="collapsed ? label : undefined"
    @click="$emit('click')"
  >
    <span class="navico kp-nav-row__icon">
      <KpNavIcon :name="icon" :size="18" />
    </span>
    <span class="kp-nav-row__label" :style="labelStyle">{{ label }}</span>
    <span v-if="hint && !collapsed" class="t-meta kp-nav-row__hint">{{ hint }}</span>
    <slot v-if="!collapsed" name="extra" />
  </div>
</template>

<style scoped lang="scss">
.kp-nav-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin-bottom: 2px;
  padding: 0 12px;
  border-radius: var(--r-ctl);
  cursor: pointer;
  overflow: hidden;
  background: transparent;
  color: var(--fg-primary);
  transition: width var(--motion-page) var(--ease-std),
    height var(--motion-page) var(--ease-std),
    padding var(--motion-page) var(--ease-std);

  &.is-active {
    background: var(--selected-bg);
    color: var(--fg-title);
  }

  // Collapsed, the tint shrinks to a centered 32×32 square rather than a
  // full-width bar — a 40-wide tinted row around a 16px icon reads as "a
  // block of color", not "an icon is selected".
  &.is-collapsed {
    width: 32px;
    height: 32px;
    justify-content: center;
    gap: 0;
    margin: 0 auto 2px;
    padding: 0;
  }
}

.kp-nav-row__icon {
  color: var(--fg-aux);

  .is-active & {
    color: var(--fg-title);
  }
}

.kp-nav-row__label {
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);

  .is-active & {
    font-weight: var(--w-medium);
  }
}

// The label carries `flex: 1` (see useLabelFade), so the hint is already
// pushed to the right edge. `nowrap` is what keeps it from breaking mid-width
// animation — the same trap as any text inside a transitioning container.
.kp-nav-row__hint {
  padding-left: 8px;
  white-space: nowrap;
  // --fg-aux, not --fg-disabled: the hint is readable secondary content
  // ("expert · skill · connector"), not a disabled control.
  color: var(--fg-aux);
}
</style>
