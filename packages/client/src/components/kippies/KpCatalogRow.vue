<script setup lang="ts">
/**
 * Catalog list row: tile, then a name/meta line over a description, then an
 * optional action pinned right.
 *
 * The row carries no frame at rest — `.catrow` surfaces a ground only on
 * hover. The negative horizontal margin lets that ground bleed past the
 * content column so the hover reads as a full-width row rather than a floating
 * box inside it.
 */
import KpAppIcon from './KpAppIcon.vue'

withDefaults(
  defineProps<{
    name: string
    icon?: string
    mark?: string
    color?: string
    meta?: string
    desc?: string
    /** Vertical alignment of the three columns. `center` unless the body is tall. */
    align?: 'center' | 'flex-start'
    clickable?: boolean
  }>(),
  { align: 'center' },
)

defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <div
    class="catrow kp-catalog-row"
    :class="{ 'is-clickable': clickable }"
    :style="{ alignItems: align }"
    @click="clickable && $emit('click', $event)"
  >
    <slot name="avatar">
      <KpAppIcon :icon="icon" :mark="mark || name.slice(0, 1)" :color="color" :size="40" />
    </slot>

    <div class="kp-catalog-row__main">
      <div class="kp-catalog-row__head">
        <span class="kp-catalog-row__name">{{ name }}</span>
        <span v-if="meta" class="t-meta kp-catalog-row__meta">{{ meta }}</span>
      </div>
      <!-- `body` replaces the description outright rather than sitting under
           it: a row shows one supporting line, whichever form it takes. -->
      <div v-if="$slots.body" class="kp-catalog-row__body"><slot name="body" /></div>
      <div v-else class="kp-catalog-row__desc">{{ desc }}</div>
    </div>

    <div v-if="$slots.action" class="kp-catalog-row__action"><slot name="action" /></div>
  </div>
</template>

<style scoped lang="scss">
.kp-catalog-row {
  display: flex;
  gap: 12px;
  padding: 12px;
  margin: 0 -12px;
  border-radius: var(--r-ctl);

  &.is-clickable {
    cursor: pointer;
  }
}

.kp-catalog-row__main {
  flex: 1;
  min-width: 0;
}

.kp-catalog-row__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.kp-catalog-row__name {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kp-catalog-row__meta {
  color: var(--fg-disabled);
  white-space: nowrap;
  flex: 0 0 auto;
}

.kp-catalog-row__body {
  margin-top: 4px;
}

.kp-catalog-row__desc {
  margin-top: 2px;
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  color: var(--fg-aux);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kp-catalog-row__action {
  flex: 0 0 auto;
}
</style>
