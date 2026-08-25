<script setup lang="ts">
/**
 * Shared empty state for every list in the app.
 *
 * The two sheets are KpPaper at 44x58 — a document that isn't here yet. A pair
 * of blank rounded blocks reads as a loading failure instead.
 */
import KpPaper from './KpPaper.vue'

defineProps<{ title: string; body?: string }>()
</script>

<template>
  <div class="kp-empty">
    <div class="kp-empty__papers">
      <KpPaper :w="44" :h="58" :lines="4" />
      <KpPaper :w="44" :h="58" :lines="4" tone="var(--gray-fa)" />
    </div>
    <div class="t-h5 kp-empty__title">{{ title }}</div>
    <div v-if="body" class="t-sub-multi kp-empty__body">{{ body }}</div>
    <div v-if="$slots.action" class="kp-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.kp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 72px 24px;
  gap: 16px;
  text-align: center;
}

.kp-empty__papers {
  display: flex;
  gap: 8px;
  opacity: 0.5;
  margin-bottom: 8px;
}

.kp-empty__title {
  color: var(--fg-primary);
}

.kp-empty__body {
  max-width: 320px;
}

.kp-empty__action {
  margin-top: 8px;
}
</style>
