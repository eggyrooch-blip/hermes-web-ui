<script setup lang="ts">
/**
 * A titled section of a catalog page: KpSectionTitle over a grid.
 *
 * The heading is KpSectionTitle rather than a local copy. When this component
 * carried its own, it used a 4px underhang plus a 16px content offset, so
 * "title to content" measured 4 on the apps page and 20 on the experts page —
 * one role, two rhythms, because one role had two implementations. The 12 now
 * comes from the shared title, which is why both grid branches start at 0.
 *
 * `grid` gives the card grid (auto-filling columns, 20 both ways); the default
 * is the evenly-split catalog-row layout.
 *
 * Both branches set a row gap. The row branch originally set only a column
 * gap — invisible while its children were rows, since those carry their own
 * vertical padding, but the moment cards went in they stacked flush.
 */
import KpSectionTitle from './KpSectionTitle.vue'

withDefaults(
  defineProps<{
    title?: string
    note?: string
    /** Columns for the row layout. Ignored when `grid` is set. */
    cols?: number
    /** Switch to the auto-filling card grid. */
    grid?: boolean
  }>(),
  { cols: 2 },
)
</script>

<template>
  <div class="kp-catalog-group">
    <KpSectionTitle v-if="title" :note="note">{{ title }}</KpSectionTitle>
    <!-- The class is the hook the mobile query narrows to one column. Column
         count is pure presentation — it does not deserve a resize listener. -->
    <div
      :class="grid ? 'cardgrid' : 'catgrid'"
      :style="grid ? undefined : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// §6.2's 36pt between sections, held in one place so it can be tuned once.
.kp-catalog-group {
  margin-bottom: 36px;
}

.cardgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.catgrid {
  display: grid;
  column-gap: 40px;
  row-gap: 20px;
}

// Below 768 two columns leave under 360 each, at which point a two-line card
// title starts wrapping.
@media (max-width: $breakpoint-mobile) {
  .cardgrid,
  .catgrid {
    grid-template-columns: 1fr !important;
  }
}
</style>
