<script setup lang="ts">
/**
 * Tail row of a truncated list: three overlapped tiles and a "see also" line.
 *
 * The tiles overlap by 8 and each carries a 2px ring in the page ground, which
 * is what separates them where they stack — a plain overlap reads as one
 * smeared shape.
 *
 * The label is passed in rather than assembled here: the prototype hardcodes
 * its Chinese sentence, and an atom that builds copy cannot be localised. The
 * caller formats it from its own i18n keys.
 */
import KpAppIcon from './KpAppIcon.vue'
import type { IconWallItem } from './KpIconWall.vue'

defineProps<{ items: IconWallItem[]; label: string; clickable?: boolean }>()
defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <div
    class="kp-more-line"
    :class="{ 'is-clickable': clickable }"
    @click="clickable && $emit('click', $event)"
  >
    <div class="kp-more-line__stack">
      <span
        v-for="(item, i) in items.slice(0, 3)"
        :key="item.id"
        class="kp-more-line__tile"
        :style="{ marginLeft: i ? '-8px' : '0' }"
      >
        <KpAppIcon
          :icon="item.icon"
          :mark="(item.name || '').slice(0, 1)"
          :color="item.color"
          :size="26"
          :radius="8"
        />
      </span>
    </div>
    <span class="kp-more-line__label">{{ label }}</span>
  </div>
</template>

<style scoped lang="scss">
.kp-more-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0 4px;

  &.is-clickable {
    cursor: pointer;
  }
}

.kp-more-line__stack {
  display: flex;
  flex: 0 0 auto;
}

.kp-more-line__tile {
  border-radius: var(--r-card-s);
  box-shadow: 0 0 0 2px var(--bg);
}

.kp-more-line__label {
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
}
</style>
