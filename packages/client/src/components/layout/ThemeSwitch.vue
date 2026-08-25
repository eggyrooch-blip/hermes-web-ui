<script setup lang="ts">
import { useTheme } from '@/composables/useTheme'
import KpThemeSeg from '@/components/kippies/KpThemeSeg.vue'

const { isComic, toggleStyle } = useTheme()
</script>

<template>
  <div class="theme-switch-container">
    <button class="theme-switch" :title="isComic ? 'Ink style' : 'Comic style'" @click="toggleStyle">
      <!-- Palette icon for comic toggle -->
      <svg v-if="isComic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
      </svg>
      <!-- Sparkle icon for ink mode -->
      <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
      </svg>
    </button>
    <!-- Light/dark uses the shared prototype segmented control, identical to the
         chat sidebar's user menu, so both sidebars show one theme affordance. -->
    <KpThemeSeg />
  </div>
</template>

<style scoped lang="scss">
.theme-switch-container {
  display: flex;
  gap: 6px;
  align-items: center;
}

.theme-switch {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--r-ctl);
  cursor: pointer;
  color: var(--fg-aux);
  transition: color 0.15s ease, background-color 0.15s ease;

  &:hover {
    color: var(--fg-primary);
    background: var(--gray-f2);
  }
}
</style>
