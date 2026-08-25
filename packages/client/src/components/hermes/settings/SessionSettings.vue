<script setup lang="ts">
import { NInputNumber, NSelect, NSwitch } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import SettingRow from "./SettingRow.vue";
import KpSectionTitle from "@/components/kippies/KpSectionTitle.vue";
import { useAutosave } from "@/composables/useAutosave";

const settingsStore = useSettingsStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const { t } = useI18n();
// Autosaving controls: the control's new position is the success report, and a
// refused save puts it back — which also stops the pane quietly disagreeing
// with what is actually stored.
const { error: saveError, run: autosave } = useAutosave();

// 防抖保存：每个字段独立定时器，300ms 内只发最后一次 HTTP 请求
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function save(values: Record<string, any>) {
  // NSelect/NSwitch 等一次性操作，直接保存，不需要防抖
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, (settingsStore.sessionReset as Record<string, any>)[key]]),
  );
  void autosave({
    apply: () => settingsStore.updateLocal('session_reset', values),
    revert: () => settingsStore.updateLocal('session_reset', previous),
    save: () => settingsStore.saveSection('session_reset', values),
    failMessage: t("settings.saveFailed"),
  });
}

function debouncedSave(key: string, value: any) {
  // The value to go back to is captured BEFORE the optimistic write, and only on
  // the first keystroke of a burst — re-reading it inside the timer would
  // capture the optimistic value itself and make the revert a no-op.
  const previous = (settingsStore.sessionReset as Record<string, any>)[key];
  // 先立即更新本地 store（UI 即时响应）
  settingsStore.updateLocal('session_reset', { [key]: value });
  // 再防抖发 HTTP 保存
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    void autosave({
      revert: () => settingsStore.updateLocal('session_reset', { [key]: previous }),
      save: () => settingsStore.saveSection('session_reset', { [key]: value }),
      failMessage: t("settings.saveFailed"),
    });
  }, 300);
}

function toggleRequireAuth(value: boolean) {
  // Bound straight to the store, so a refused save leaves the switch where it
  // was without needing an explicit revert.
  void autosave({
    save: () => settingsStore.saveSection("approvals", { mode: value ? "manual" : "off" }),
    failMessage: t("settings.saveFailed"),
  });
}

function toggleWriteApproval(section: "memory" | "skills", value: boolean) {
  void autosave({
    apply: () => settingsStore.updateLocal(section, { write_approval: value }),
    revert: () => settingsStore.updateLocal(section, { write_approval: !value }),
    save: () => settingsStore.saveSection(section, { write_approval: value }),
    failMessage: t("settings.saveFailed"),
  });
}

</script>

<template>
  <section class="settings-section">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <KpSectionTitle>{{ t('settings.session.sectionApprovals') }}</KpSectionTitle>
    <SettingRow
      :label="t('settings.session.requireAuth')"
      :hint="t('settings.session.requireAuthHint')"
    >
      <NSwitch :value="settingsStore.approvals.mode === 'manual'" @update:value="toggleRequireAuth" />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.memoryWriteApproval')"
      :hint="t('settings.session.memoryWriteApprovalHint')"
    >
      <NSwitch
        :value="settingsStore.memory.write_approval === true"
        @update:value="(value) => toggleWriteApproval('memory', value)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.skillsWriteApproval')"
      :hint="t('settings.session.skillsWriteApprovalHint')"
    >
      <NSwitch
        :value="settingsStore.skills.write_approval === true"
        @update:value="(value) => toggleWriteApproval('skills', value)"
      />
    </SettingRow>
    <KpSectionTitle class="settings-section__title">{{ t('settings.session.sectionReset') }}</KpSectionTitle>
    <SettingRow
      :label="t('settings.session.mode')"
      :hint="t('settings.session.modeHint')"
    >
      <NSelect
        :value="settingsStore.sessionReset.mode || 'both'"
        :options="[
          { label: t('settings.session.modeBoth'), value: 'both' },
          { label: t('settings.session.modeIdle'), value: 'idle' },
          { label: t('settings.session.modeDaily'), value: 'daily' },
          { label: t('settings.session.modeNone'), value: 'none' },
        ]"
        size="small"
        class="input-md"
        @update:value="(v) => save({ mode: v })"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.idleMinutes')"
      :hint="t('settings.session.idleMinutesHint')"
    >
      <NInputNumber
        :value="settingsStore.sessionReset.idle_minutes"
        :min="10"
        :max="10080"
        :step="30"
        size="small"
        class="input-sm"
        @update:value="(v) => v != null && debouncedSave('idle_minutes', v)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.atHour')"
      :hint="t('settings.session.atHourHint')"
    >
      <NInputNumber
        :value="settingsStore.sessionReset.at_hour"
        :min="0"
        :max="23"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="(v) => v != null && debouncedSave('at_hour', v)"
      />
    </SettingRow>
    <SettingRow
      :label="t('settings.session.liveMonitorHumanOnly')"
      :hint="t('settings.session.liveMonitorHumanOnlyHint')"
    >
      <NSwitch
        :value="sessionBrowserPrefsStore.humanOnly"
        @update:value="(value) => sessionBrowserPrefsStore.setHumanOnly(value)"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;
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

.settings-section__title {
  margin-top: 36px;
}
</style>
