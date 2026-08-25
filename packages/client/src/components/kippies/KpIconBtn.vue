<script setup lang="ts">
/** 32px round icon button — the rail's collapse toggle, row affordances. */
import KpIcon from './KpIcon.vue'

withDefaults(
  defineProps<{
    name?: string
    size?: number
    title?: string
    active?: boolean
  }>(),
  { size: 18 },
)

defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button
    class="ab kp-icon-btn"
    :class="{ 'is-active': active }"
    :title="title"
    :aria-label="title"
    @click="$emit('click', $event)"
  >
    <slot>
      <KpIcon v-if="name" :name="name" :size="size" />
    </slot>
  </button>
</template>

<style scoped lang="scss">
.kp-icon-btn {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  cursor: pointer;

  &.is-active {
    background: var(--selected-bg);
    color: var(--fg-primary);
  }
}
</style>
