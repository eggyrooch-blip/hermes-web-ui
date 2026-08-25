<script setup lang="ts">
import { NSwitch, NInputNumber } from 'naive-ui'
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

// 防抖保存：每个字段独立定时器，300ms 内只发最后一次 HTTP 请求
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}

function save(values: Record<string, any>) {
  // Switch 等一次性操作，直接保存，不需要防抖
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, (settingsStore.memory as Record<string, any>)[key]]),
  )
  void autosave({
    apply: () => settingsStore.updateLocal('memory', values),
    revert: () => settingsStore.updateLocal('memory', previous),
    save: () => settingsStore.saveSection('memory', values),
    failMessage: t('settings.saveFailed'),
  })
}

function debouncedSave(key: string, value: any) {
  // Captured BEFORE the optimistic write, and only on the first keystroke of a
  // burst — reading it inside the timer would capture the optimistic value and
  // make the revert a no-op.
  const previous = (settingsStore.memory as Record<string, any>)[key]
  // 先立即更新本地 store（UI 即时响应）
  settingsStore.updateLocal('memory', { [key]: value })
  // 再防抖发 HTTP 保存
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    void autosave({
      revert: () => settingsStore.updateLocal('memory', { [key]: previous }),
      save: () => settingsStore.saveSection('memory', { [key]: value }),
      failMessage: t('settings.saveFailed'),
    })
  }, 300)
}
</script>

<template>
  <section class="settings-section">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <KpSectionTitle>{{ t('settings.tabs.memory') }}</KpSectionTitle>
    <SettingRow :label="t('settings.memory.enabled')" :hint="t('settings.memory.enabledHint')">
      <NSwitch :value="settingsStore.memory.memory_enabled" @update:value="v => save({ memory_enabled: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.memory.userProfile')" :hint="t('settings.memory.userProfileHint')">
      <NSwitch :value="settingsStore.memory.user_profile_enabled" @update:value="v => save({ user_profile_enabled: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.memory.charLimit')" :hint="t('settings.memory.charLimitHint')">
      <NInputNumber
        :value="settingsStore.memory.memory_char_limit"
        :min="100" :max="10000" :step="100"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('memory_char_limit', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.memory.userCharLimit')" :hint="t('settings.memory.userCharLimitHint')">
      <NInputNumber
        :value="settingsStore.memory.user_char_limit"
        :min="100" :max="10000" :step="100"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('user_char_limit', v)"
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
