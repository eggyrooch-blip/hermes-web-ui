<script setup lang="ts">
/** One collapsible block of the run panel: title, count, optional action. */
import { ref } from 'vue'
import KpIcon from '@/components/kippies/KpIcon.vue'

const props = withDefaults(
  defineProps<{
    title: string
    /** Shown next to the title — a number, "3/6", "已中断", "2 项在用". */
    count?: string | null
    /** No rule above the first block; the panel's own edge does that job. */
    first?: boolean
    defaultOpen?: boolean
  }>(),
  { defaultOpen: true },
)

const open = ref(props.defaultOpen)
</script>

<template>
  <div class="run-section" :class="{ 'is-first': first }">
    <div class="run-section__head" :class="{ 'is-open': open }">
      <button type="button" class="run-section__toggle" @click="open = !open">
        <span class="t-sub-medium run-section__title">{{ title }}</span>
        <span v-if="count != null" class="t-meta run-section__count">{{ count }}</span>
        <KpIcon
          name="line_arrow_right"
          :size="12"
          class="run-section__caret"
          :class="{ 'is-open': open }"
        />
      </button>
      <div class="run-section__spacer" />
      <slot v-if="open" name="action" />
    </div>
    <div v-if="open" class="fadein">
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
.run-section {
  padding: 16px 0;
  border-top: 0.5px solid var(--divider);

  &.is-first {
    border-top: 0;
  }
}

.run-section__head {
  display: flex;
  align-items: center;
  gap: 4px;

  &.is-open {
    margin-bottom: 12px;
  }
}

.run-section__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  user-select: none;
}

.run-section__title {
  color: var(--fg-title);
}

.run-section__count {
  color: var(--fg-disabled);
}

.run-section__caret {
  color: var(--fg-disabled);
  transition: transform var(--motion-fast) var(--ease-std);

  &.is-open {
    transform: rotate(90deg);
  }
}

.run-section__spacer {
  flex: 1;
}
</style>
