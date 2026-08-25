<script setup lang="ts">
/**
 * In-page tab row: a hairline rule with the selected label pinned to it.
 *
 * This is the horizontal counterpart to the sidebar's vertical rail — 2 to 5
 * tabs sitting under a page title. On a narrow screen the row scrolls
 * sideways with the scrollbar hidden: an 8px bar inside a 28px strip is very
 * visible, and "there is more to the right" is already said by the half-cut
 * pill at the edge.
 */
withDefaults(
  defineProps<{
    tabs: { key: string; label: string }[]
    active: string
    /** Space below the rule. 24 by default; the market head wants 16. */
    mb?: number
  }>(),
  { mb: 24 },
)

const emit = defineEmits<{ pick: [key: string] }>()
</script>

<template>
  <div class="kp-tabstrip tabstrip" role="tablist" :style="{ marginBottom: `${mb}px` }">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      class="kp-tabstrip__tab"
      :class="{ 'is-on': tab.key === active }"
      :aria-selected="tab.key === active"
      :data-testid="`tabstrip-${tab.key}`"
      @click="emit('pick', tab.key)"
    >
      {{ tab.label }}
      <!-- bottom: -1 puts the 2px underline on top of the 0.5pt rule, so the
           selected tab reads as pinned to the line rather than floating above
           it. -->
      <span v-if="tab.key === active" class="kp-tabstrip__ink" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.kp-tabstrip {
  display: flex;
  align-items: center;
  gap: 28px;
  border-bottom: 0.5px solid var(--divider);
  overflow-x: auto;
  scrollbar-width: none;
}

.kp-tabstrip__tab {
  position: relative;
  padding: 0 2px 12px;
  border: 0;
  background: transparent;
  white-space: nowrap;
  cursor: pointer;
  font: var(--w-regular) var(--t-16) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
  transition: color var(--motion-fast) var(--ease-std);

  &.is-on {
    font-weight: var(--w-semibold);
    color: var(--fg-title);
  }
}

.kp-tabstrip__ink {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--fg-title);
}
</style>
