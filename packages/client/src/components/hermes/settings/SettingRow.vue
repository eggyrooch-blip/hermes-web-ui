<script setup lang="ts">
defineProps<{
  label: string
  hint?: string
}>()
</script>

<template>
  <div class="setting-row catrow">
    <div class="setting-info">
      <label class="setting-label">{{ label }}</label>
      <p v-if="hint" class="setting-hint">{{ hint }}</p>
    </div>
    <div class="setting-control">
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// Prototype Row/T: no per-row border — rows are delimited by the section's
// own SectionTitle + a hover tint (.catrow), not an underline between rows.
// padding 12/-12 margin lets the row's tint bleed to the section's full
// width while the row's own content stays aligned with the heading above it.
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px; // prototype Row gap
  padding: 12px 12px;
  margin: 0 -12px;
  border-radius: var(--r-ctl);
  transition: background var(--motion-fast) var(--ease-std);
}

.setting-info {
  flex: 1;
  min-width: 0;
}

.setting-label {
  display: block;
  font: var(--w-medium) var(--t-14) / var(--lh-tight) var(--font-cn);
  color: var(--fg-primary);
}

.setting-hint {
  margin: 2px 0 0;
  // Prototype T rows set the description to 1.6 so two-line hints breathe.
  font: var(--w-regular) var(--t-12) / 1.6 var(--font-cn);
  color: var(--fg-aux);
}

.setting-control {
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .setting-control {
    width: 100%;
  }
}
</style>
