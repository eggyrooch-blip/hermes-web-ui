<script setup lang="ts">
/**
 * Light/dark segmented control — the prototype's 外观 switch. Same geometry as
 * the Work/Design mode switch: a --gray-f2 track with 2px padding, the active
 * mode a white card with a hairline. Shared so both sidebars (the chat
 * PageSidebarNav user menu and the management AppSidebar footer) show the exact
 * same control instead of two different theme affordances.
 *
 * Re-picking the active mode is a no-op: we only toggle when the chosen mode
 * differs from the current one.
 */
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'

const { t } = useI18n()
const { isDark, toggleBrightness } = useTheme()

function pick(mode: 'light' | 'dark') {
  const wantDark = mode === 'dark'
  if (wantDark !== isDark.value) toggleBrightness()
}
</script>

<template>
  <span class="kp-theme-seg" role="group" :aria-label="t('sidebar.appearance')">
    <button
      type="button"
      class="kp-theme-seg__btn"
      :class="{ 'is-on': !isDark }"
      @click="pick('light')"
    >{{ t('settings.display.themeLight') }}</button>
    <button
      type="button"
      class="kp-theme-seg__btn"
      :class="{ 'is-on': isDark }"
      @click="pick('dark')"
    >{{ t('settings.display.themeDark') }}</button>
  </span>
</template>

<style scoped lang="scss">
.kp-theme-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-ctl);
  background: var(--surface-3);
}

.kp-theme-seg__btn {
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-card-l);
  background: transparent;
  color: var(--fg-aux);
  cursor: pointer;
  white-space: nowrap;
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  transition: background var(--motion-base) var(--ease-std),
    color var(--motion-base) var(--ease-std);

  // Hairline ring, not a drop shadow — same rule as the mode switch this
  // control borrows its geometry from.
  &.is-on {
    background: var(--bg);
    box-shadow: 0 0 0 0.5px var(--divider);
    color: var(--fg-title);
  }
}
</style>
