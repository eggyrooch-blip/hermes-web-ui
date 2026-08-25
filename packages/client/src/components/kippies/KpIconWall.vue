<script setup lang="ts">
/**
 * The row of tiles at the top of a catalog page — white plates with a hairline
 * ring, wrapping across as many lines as they need.
 *
 * 48 at radius 13 rather than the tile default of 6: this is the page's opening
 * image, not an item inside a row, so it gets its own step.
 */
import KpAppIcon from './KpAppIcon.vue'

export interface IconWallItem {
  id: string
  name: string
  icon?: string
  color?: string
}

defineProps<{ items: IconWallItem[] }>()
</script>

<template>
  <div class="kp-icon-wall">
    <span v-for="item in items" :key="item.id" :title="item.name">
      <KpAppIcon
        :icon="item.icon"
        :mark="(item.name || '').slice(0, 1)"
        :color="item.color"
        :size="48"
        :radius="13"
      />
    </span>
  </div>
</template>

<style scoped lang="scss">
.kp-icon-wall {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 24px;
}
</style>
