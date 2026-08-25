<script setup lang="ts">
/**
 * Keep AppIcon — the catalog/app/file icon tile used across the prototype's
 * marketplace and library surfaces.
 *
 * The design language is a WHITE tile (surface --bg) with a hairline inset ring
 * carrying a COLORED glyph (or a text mark). This is the opposite of a
 * solid-hue chip: the colour lives in the glyph, not the background.
 *
 * The ring is the only decoration — there is no drop shadow. §7.1 keeps these
 * surfaces flat, and the handoff forbids writing new shadow values outright
 * (only the two DS-sanctioned ones may be referenced, by token).
 *
 * Radius defaults to 6, the §8.1 large-card step: the tile is a container
 * (§7.3 Contained 2), and 11 is not a step on the ladder. Contexts that need
 * a different tile pass one explicitly — the icon wall uses 13 at size 48,
 * the more-line 8 at 26, the library table 8 at 30 — matching the prototype's
 * own call sites. Catalog rows and item cards pass none and take the 6.
 */
import { computed } from 'vue'
import KpIcon from './KpIcon.vue'

const props = withDefaults(
  defineProps<{
    /** Keep icon-font glyph name (without the `kp_ic_` prefix). */
    icon?: string
    /** Text mark shown when no `icon` is given (e.g. a leading initial). */
    mark?: string
    /** Glyph/mark colour. Defaults to --fg-primary. */
    color?: string
    size?: number
    radius?: number
  }>(),
  { size: 40, radius: 6 },
)

const glyphSize = computed(() => Math.round(props.size * 0.46))
const markSize = computed(() => Math.round(props.size * 0.36))
</script>

<template>
  <span
    class="kp-app-icon"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      flex: `0 0 ${size}px`,
      borderRadius: `${radius}px`,
      color: color || 'var(--fg-primary)',
    }"
  >
    <KpIcon v-if="icon" :name="icon" :size="glyphSize" />
    <span v-else class="kp-app-icon__mark" :style="{ fontSize: `${markSize}px` }">{{ mark }}</span>
  </span>
</template>

<style scoped lang="scss">
.kp-app-icon {
  display: grid;
  place-items: center;
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
}

.kp-app-icon__mark {
  font-weight: var(--w-semibold);
  line-height: var(--lh-1);
  font-family: var(--font-cn);
}
</style>
