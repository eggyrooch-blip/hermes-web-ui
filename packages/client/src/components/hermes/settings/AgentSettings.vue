<script setup lang="ts">
import { NInputNumber, NSelect } from 'naive-ui'
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
  // NSelect 等一次性操作，直接保存，不需要防抖
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, (settingsStore.agent as Record<string, any>)[key]]),
  )
  void autosave({
    apply: () => settingsStore.updateLocal('agent', values),
    revert: () => settingsStore.updateLocal('agent', previous),
    save: () => settingsStore.saveSection('agent', values),
    failMessage: t('settings.saveFailed'),
  })
}

function debouncedSave(key: string, value: any) {
  // Captured BEFORE the optimistic write, and only on the first keystroke of a
  // burst — reading it inside the timer would capture the optimistic value and
  // make the revert a no-op.
  const previous = (settingsStore.agent as Record<string, any>)[key]
  // 先立即更新本地 store（UI 即时响应）
  settingsStore.updateLocal('agent', { [key]: value })
  // 再防抖发 HTTP 保存
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    void autosave({
      revert: () => settingsStore.updateLocal('agent', { [key]: previous }),
      save: () => settingsStore.saveSection('agent', { [key]: value }),
      failMessage: t('settings.saveFailed'),
    })
  }, 300)
}
</script>

<template>
  <section class="settings-section">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <KpSectionTitle>{{ t('settings.agent.sectionRuntime') }}</KpSectionTitle>
    <SettingRow :label="t('settings.agent.maxTurns')" :hint="t('settings.agent.maxTurnsHint')">
      <NInputNumber
        :value="settingsStore.agent.max_turns"
        :min="1" :max="200" :step="5"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('max_turns', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.agent.gatewayTimeout')" :hint="t('settings.agent.gatewayTimeoutHint')">
      <NInputNumber
        :value="settingsStore.agent.gateway_timeout"
        :min="60" :max="7200" :step="60"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('gateway_timeout', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.agent.restartDrainTimeout')" :hint="t('settings.agent.restartDrainTimeoutHint')">
      <NInputNumber
        :value="settingsStore.agent.restart_drain_timeout"
        :min="10" :max="300" :step="10"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('restart_drain_timeout', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.agent.toolEnforcement')" :hint="t('settings.agent.toolEnforcementHint')">
      <NSelect
        :value="settingsStore.agent.tool_use_enforcement || 'auto'"
        :options="[
          { label: t('settings.agent.auto'), value: 'auto' },
          { label: t('settings.agent.always'), value: 'always' },
          { label: t('settings.agent.never'), value: 'never' },
        ]"
        size="small" class="input-sm"
        @update:value="v => save({ tool_use_enforcement: v })"
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
