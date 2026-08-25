<script setup lang="ts">
import { NInputNumber, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import { useAutosave } from '@/composables/useAutosave'

const settingsStore = useSettingsStore()
const { t } = useI18n()
// Autosave: the control's new position is the success report, and a refused
// save puts it back rather than leaving the pane disagreeing with the server.
const { error: saveError, run: autosave } = useAutosave()

const defaults = {
  enabled: true,
  threshold: 0.5,
  target_ratio: 0.2,
  protect_last_n: 20,
  protect_first_n: 3,
}

const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}

function save(values: Record<string, any>) {
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, (settingsStore.compression as Record<string, any>)[key]]),
  )
  void autosave({
    apply: () => settingsStore.updateLocal('compression', values),
    revert: () => settingsStore.updateLocal('compression', previous),
    save: () => settingsStore.saveSection('compression', values),
    failMessage: t('settings.saveFailed'),
  })
}

function debouncedSave(key: string, value: any) {
  // Captured BEFORE the optimistic write, and only on the first keystroke of
  // a burst — reading it inside the timer would capture the optimistic value
  // and make the revert a no-op.
  const previous = (settingsStore.compression as Record<string, any>)[key]
  settingsStore.updateLocal('compression', { [key]: value })
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    void autosave({
      revert: () => settingsStore.updateLocal('compression', { [key]: previous }),
      save: () => settingsStore.saveSection('compression', { [key]: value }),
      failMessage: t('settings.saveFailed'),
    })
  }, 300)
}
</script>

<template>
  <section class="settings-section">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <KpSectionTitle>{{ t('settings.tabs.compression') }}</KpSectionTitle>
    <SettingRow :label="t('settings.compression.enabled')" :hint="t('settings.compression.enabledHint')">
      <NSwitch
        :value="settingsStore.compression.enabled ?? defaults.enabled"
        size="small"
        @update:value="v => save({ enabled: v })"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.threshold')" :hint="t('settings.compression.thresholdHint')">
      <NInputNumber
        :value="settingsStore.compression.threshold ?? defaults.threshold"
        :min="0.1"
        :max="0.95"
        :step="0.05"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('threshold', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.targetRatio')" :hint="t('settings.compression.targetRatioHint')">
      <NInputNumber
        :value="settingsStore.compression.target_ratio ?? defaults.target_ratio"
        :min="0.05"
        :max="0.8"
        :step="0.05"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('target_ratio', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.protectLastN')" :hint="t('settings.compression.protectLastNHint')">
      <NInputNumber
        :value="settingsStore.compression.protect_last_n ?? defaults.protect_last_n"
        :min="0"
        :max="200"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('protect_last_n', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.protectFirstN')" :hint="t('settings.compression.protectFirstNHint')">
      <NInputNumber
        :value="settingsStore.compression.protect_first_n ?? defaults.protect_first_n"
        :min="0"
        :max="50"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('protect_first_n', v)"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.settings-save-error {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}


.settings-section {
  margin-top: 0;
}
</style>
