<script setup lang="ts">
import { computed, onMounted } from "vue";
import {
  NTabs,
  NTabPane,
  NSpin,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { isUserMode } from "@/api/client";
import { useSettingsStore } from "@/stores/hermes/settings";
import DisplaySettings from "@/components/hermes/settings/DisplaySettings.vue";
import AgentSettings from "@/components/hermes/settings/AgentSettings.vue";
import MemorySettings from "@/components/hermes/settings/MemorySettings.vue";
import SessionSettings from "@/components/hermes/settings/SessionSettings.vue";
import PrivacySettings from "@/components/hermes/settings/PrivacySettings.vue";
import ModelSettings from "@/components/hermes/settings/ModelSettings.vue";
import AccountSettings from "@/components/hermes/settings/AccountSettings.vue";

const settingsStore = useSettingsStore();
const { t } = useI18n();
const showAdminSettings = computed(() => !isUserMode());

onMounted(() => {
  settingsStore.fetchSettings();
});
</script>

<template>
  <div class="settings-view">
    <header class="page-header">
      <h2 class="header-title">{{ t("settings.title") }}</h2>
    </header>

    <div class="settings-content">
      <section v-if="!showAdminSettings" class="user-mode-note">
        <div class="note-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div>
          <h3>{{ t("settings.userMode.title") }}</h3>
          <p>{{ t("settings.userMode.description") }}</p>
        </div>
      </section>

      <NSpin
        :show="settingsStore.loading || settingsStore.saving"
        size="large"
        :description="t('common.loading')"
      >
        <NTabs type="line" animated :default-value="showAdminSettings ? 'account' : 'display'">
          <NTabPane v-if="showAdminSettings" name="account" :tab="t('settings.tabs.account')">
            <AccountSettings />
          </NTabPane>
          <NTabPane name="display" :tab="t('settings.tabs.display')">
            <DisplaySettings />
          </NTabPane>
          <NTabPane name="agent" :tab="t('settings.tabs.agent')">
            <AgentSettings />
          </NTabPane>
          <NTabPane name="memory" :tab="t('settings.tabs.memory')">
            <MemorySettings />
          </NTabPane>
          <NTabPane name="session" :tab="t('settings.tabs.session')">
            <SessionSettings />
          </NTabPane>
          <NTabPane name="privacy" :tab="t('settings.tabs.privacy')">
            <PrivacySettings />
          </NTabPane>
          <NTabPane v-if="showAdminSettings" name="models" :tab="t('settings.tabs.models')">
            <ModelSettings />
          </NTabPane>
        </NTabs>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.settings-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.user-mode-note {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: rgba(var(--accent-primary-rgb), 0.05);
  color: $text-secondary;

  .note-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: $radius-sm;
    color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.1);
    flex-shrink: 0;
  }

  h3 {
    margin: 0 0 4px;
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
  }

  p {
    margin: 0;
    max-width: 720px;
    font-size: 13px;
    line-height: 1.6;
  }
}
</style>
