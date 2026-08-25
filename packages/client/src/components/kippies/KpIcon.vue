<script setup lang="ts">
/**
 * Keep icon font glyph.
 *
 * `name` is the glyph without the `kp_ic_` prefix, e.g. `line_search`.
 * The font carries 494 glyphs; the design system forbids substituting
 * Unicode symbols for them, so everything icon-shaped goes through here.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number
    color?: string
  }>(),
  { size: 18 },
)

const glyphClass = computed(() => `kp-icon-font kp_ic_${props.name}`)
</script>

<template>
  <i
    :class="glyphClass"
    :style="{ fontSize: `${size}px`, color: color || 'inherit' }"
    aria-hidden="true"
  />
</template>

<style scoped lang="scss">
i {
  line-height: 1;
  display: inline-block;
  flex: none;
}
</style>
