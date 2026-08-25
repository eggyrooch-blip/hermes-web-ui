<script setup lang="ts">
import { NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import { useAutosave } from '@/composables/useAutosave'

const settingsStore = useSettingsStore()
const { t } = useI18n()
// Autosave: the control already shows the new value on success, and a refused
// save puts it back rather than leaving the pane disagreeing with the server.
const { error: saveError, run: autosave } = useAutosave()

function save(values: Record<string, any>) {
  // The switches are bound straight to the store, so a refused save leaves them
  // where they were — no explicit revert needed.
  void autosave({
    save: () => settingsStore.saveSection('privacy', values),
    failMessage: t('settings.saveFailed'),
  })
}
</script>

<template>
  <section class="settings-section">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <KpSectionTitle>{{ t('settings.tabs.privacy') }}</KpSectionTitle>
    <SettingRow :label="t('settings.privacy.redactPii')" :hint="t('settings.privacy.redactPiiHint')">
      <NSwitch :value="settingsStore.privacy.redact_pii" @update:value="v => save({ redact_pii: v })" />
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
