<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NSpin } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import DisplaySettings from "@/components/hermes/settings/DisplaySettings.vue";
import PersonalizeSettings from "@/components/hermes/settings/PersonalizeSettings.vue";
import AgentSettings from "@/components/hermes/settings/AgentSettings.vue";
import GatewayAutoStartSettings from "@/components/hermes/settings/GatewayAutoStartSettings.vue";
import CompressionSettings from "@/components/hermes/settings/CompressionSettings.vue";
import SessionSettings from "@/components/hermes/settings/SessionSettings.vue";
import PrivacySettings from "@/components/hermes/settings/PrivacySettings.vue";
import ModelSettings from "@/components/hermes/settings/ModelSettings.vue";
import AccountSettings from "@/components/hermes/settings/AccountSettings.vue";
import UserManagementSettings from "@/components/hermes/settings/UserManagementSettings.vue";
import VoiceSettings from "@/components/hermes/settings/VoiceSettings.vue";
import SkillListSettings from "@/components/hermes/settings/SkillListSettings.vue";
import MyTasksSettings from "@/components/hermes/settings/MyTasksSettings.vue";
import KpEmptyState from "@/components/kippies/KpEmptyState.vue";
import { isStoredSuperAdmin } from "@/api/client";
import { useProfilesStore } from "@/stores/hermes/profiles";

// Pages that used to be their own sidebar entries and now live as tabs here.
// Async so opening 设置 does not pull 13 full pages into the initial chunk —
// each one loads the first time its tab is picked.
const KanbanView = defineAsyncComponent(() => import("@/views/hermes/KanbanView.vue"));
const MemoryView = defineAsyncComponent(() => import("@/views/hermes/MemoryView.vue"));
const UsageView = defineAsyncComponent(() => import("@/views/hermes/UsageView.vue"));
const SkillsUsageView = defineAsyncComponent(() => import("@/views/hermes/SkillsUsageView.vue"));
const ChannelsView = defineAsyncComponent(() => import("@/views/hermes/ChannelsView.vue"));
const ModelsView = defineAsyncComponent(() => import("@/views/hermes/ModelsView.vue"));
const LogsView = defineAsyncComponent(() => import("@/views/hermes/LogsView.vue"));
const PerformanceView = defineAsyncComponent(() => import("@/views/hermes/PerformanceView.vue"));
const PluginsView = defineAsyncComponent(() => import("@/views/hermes/PluginsView.vue"));
const McpManagerView = defineAsyncComponent(() => import("@/views/hermes/McpManagerView.vue"));
const CodingAgentsView = defineAsyncComponent(() => import("@/views/hermes/CodingAgentsView.vue"));
const VersionPreviewView = defineAsyncComponent(() => import("@/views/hermes/VersionPreviewView.vue"));
const DevicesView = defineAsyncComponent(() => import("@/views/hermes/DevicesView.vue"));

// `embedded` lets Settings render inside the chat sidebar surface (so opening
// it from the user menu keeps the sidebar), filling the host instead of taking
// the full viewport height. Default false preserves the standalone route.
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const settingsStore = useSettingsStore();
const profilesStore = useProfilesStore();
const { t } = useI18n();
const canManageUsers = isStoredSuperAdmin();
const route = useRoute();
const router = useRouter();

// Prototype rail order first (账号信息/用量/通用/我的创建/我的安装/我的下载/
// 我的任务), operational tabs appended after — user decision 2026-08-17.
//
// 2026-08-18: the second sidebar is gone, so everything that used to be one of
// its entries is a tab here. At 26 rows the rail needs the group headings to
// stay scannable. Labels for the moved pages reuse their existing `sidebar.*`
// keys — same strings, already translated in all 10 locales.
type TabGroup = "personal" | "workspace" | "system";
const TABS: Array<{ key: string; label: string; group: TabGroup; adminOnly?: boolean }> = [
  { key: "account", label: "settings.tabs.account", group: "personal", adminOnly: true },
  { key: "usage", label: "settings.tabs.usage", group: "personal" },
  { key: "general", label: "settings.tabs.general", group: "personal" },
  { key: "personalize", label: "settings.tabs.personalize", group: "personal" },
  { key: "created", label: "settings.tabs.created", group: "personal" },
  { key: "installed", label: "settings.tabs.installed", group: "personal" },
  { key: "downloads", label: "settings.tabs.downloads", group: "personal" },
  { key: "tasks", label: "settings.tabs.tasks", group: "personal" },

  { key: "kanban", label: "sidebar.kanban", group: "workspace" },
  { key: "memory", label: "sidebar.memory", group: "workspace" },
  { key: "skillsUsage", label: "sidebar.skillsUsage", group: "workspace" },

  { key: "users", label: "settings.tabs.users", group: "system", adminOnly: true },
  { key: "agent", label: "settings.tabs.agent", group: "system", adminOnly: true },
  { key: "compression", label: "settings.tabs.compression", group: "system", adminOnly: true },
  { key: "session", label: "settings.tabs.session", group: "system" },
  { key: "privacy", label: "settings.tabs.privacy", group: "system" },
  { key: "models", label: "settings.tabs.models", group: "system", adminOnly: true },
  { key: "voice", label: "settings.tabs.voice", group: "system", adminOnly: true },
  // `providers`, not `models`: the 模型 sidebar entry was ModelsView (provider
  // accounts), which is a different page from the existing ModelSettings tab.
  { key: "providers", label: "sidebar.models", group: "system", adminOnly: true },
  { key: "channels", label: "sidebar.channels", group: "system", adminOnly: true },
  { key: "logs", label: "sidebar.logs", group: "system", adminOnly: true },
  { key: "performance", label: "sidebar.performance", group: "system", adminOnly: true },
  { key: "plugins", label: "sidebar.plugins", group: "system", adminOnly: true },
  { key: "mcp", label: "sidebar.mcp", group: "system", adminOnly: true },
  { key: "codingAgents", label: "sidebar.codingAgents", group: "system", adminOnly: true },
  { key: "versionPreview", label: "sidebar.versionPreview", group: "system", adminOnly: true },
  { key: "devices", label: "sidebar.devices", group: "system", adminOnly: true },
];

const GROUP_LABEL: Record<TabGroup, string> = {
  personal: "settings.groups.personal",
  workspace: "settings.groups.workspace",
  system: "settings.groups.system",
};

// A preview build must not offer 版本预览 — you are already in it. This used to
// gate the sidebar row; it gates the tab now.
const isVersionPreview = import.meta.env.VITE_HERMES_PREVIEW === "1";

const visibleTabs = computed(() =>
  TABS.filter(tab => (!tab.adminOnly || canManageUsers) && !(tab.key === "versionPreview" && isVersionPreview)),
);

// Rail rows in order, with a heading injected wherever the group changes.
const railGroups = computed(() => {
  const groups: Array<{ group: TabGroup; label: string; tabs: typeof TABS }> = [];
  for (const tab of visibleTabs.value) {
    let last = groups[groups.length - 1];
    if (!last || last.group !== tab.group) {
      last = { group: tab.group, label: GROUP_LABEL[tab.group], tabs: [] };
      groups.push(last);
    }
    last.tabs.push(tab);
  }
  return groups;
});
const defaultTab = canManageUsers ? "account" : "usage";
const activeTab = ref(defaultTab);

const validTabs = computed(() => new Set(visibleTabs.value.map(tab => tab.key)));

// The old display tab folded into 通用 — keep its deep link alive. `memory` is
// NOT mapped here any more: it used to fall through to 个性化, but the 记忆 page
// itself is now a tab under that exact key.
const LEGACY_TABS: Record<string, string> = { display: "general" };

function normalizeTab(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const tab = LEGACY_TABS[raw] ?? raw;
  return validTabs.value.has(tab) ? tab : defaultTab;
}

function handleTabUpdate(tab: string) {
  activeTab.value = normalizeTab(tab);
  router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === defaultTab ? undefined : activeTab.value,
    },
  });
}

watch(() => route.query.tab, (tab) => {
  activeTab.value = normalizeTab(tab);
}, { immediate: true });

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles();
  }
  await settingsStore.fetchSettings();
}

onMounted(() => {
  void loadSettingsForProfile();
});
</script>

<template>
  <div class="settings-view" :class="{ 'is-embedded': embedded }">
    <div class="settings-content">
      <div class="settings-inner">
        <header class="page-header">
          <!-- No `.header-title`: that global class is the 16px compact-bar
               title and, being defined later, wins over .t-h1's 28px. -->
          <h1 class="t-h1 settings-title">{{ t("settings.title") }}</h1>
        </header>

        <NSpin
          :show="settingsStore.loading || settingsStore.saving"
          size="large"
          :description="t('common.loading')"
        >
          <!-- Prototype settings layout: hand-rolled 168px NavRow rail +
               36px gap; content swaps instantly, no tab animation. -->
          <div class="settings-layout">
            <nav class="settings-rail">
              <template v-for="group in railGroups" :key="group.group">
                <div class="t-meta settings-rail-group">{{ t(group.label) }}</div>
                <button
                  v-for="tab in group.tabs"
                  :key="tab.key"
                  type="button"
                  class="settings-rail-row"
                  :class="{ 'is-active': activeTab === tab.key }"
                  @click="handleTabUpdate(tab.key)"
                >{{ t(tab.label) }}</button>
              </template>
            </nav>

            <div class="settings-pane">
              <AccountSettings v-if="activeTab === 'account'" />
              <!-- The full 用量统计 page (range picker, model breakdown, daily
                   table) rather than the summary-only UsageSettings pane. -->
              <div v-else-if="activeTab === 'usage'" class="settings-pane__page"><UsageView /></div>
              <div v-else-if="activeTab === 'general'" class="pane-stack">
                <!-- 记忆 moved to 个性化, which is what it is about: the whole
                     page is "how it understands you", and splitting memory off
                     into 通用 read as two unrelated things. -->
                <DisplaySettings />
              </div>
              <PersonalizeSettings
                v-else-if="activeTab === 'personalize'"
                :can-edit="canManageUsers"
              />
              <SkillListSettings v-else-if="activeTab === 'created'" kind="created" />
              <SkillListSettings v-else-if="activeTab === 'installed'" kind="installed" />
              <KpEmptyState
                v-else-if="activeTab === 'downloads'"
                :title="t('settings.library.downloadsEmpty')"
              />
              <MyTasksSettings v-else-if="activeTab === 'tasks'" />
              <UserManagementSettings v-else-if="activeTab === 'users'" />
              <div v-else-if="activeTab === 'agent'" class="pane-stack">
                <AgentSettings />
                <GatewayAutoStartSettings />
              </div>
              <CompressionSettings v-else-if="activeTab === 'compression'" />
              <SessionSettings v-else-if="activeTab === 'session'" />
              <PrivacySettings v-else-if="activeTab === 'privacy'" />
              <ModelSettings v-else-if="activeTab === 'models'" />
              <VoiceSettings v-else-if="activeTab === 'voice'" />

              <!-- Pages moved in from the old second sidebar. Each brings its
                   own KpPage frame, so the wrapper strips the outer padding and
                   max-width — otherwise it is a page frame inside a page frame. -->
              <div v-else-if="activeTab === 'kanban'" class="settings-pane__page"><KanbanView /></div>
              <div v-else-if="activeTab === 'memory'" class="settings-pane__page"><MemoryView /></div>
              <div v-else-if="activeTab === 'skillsUsage'" class="settings-pane__page"><SkillsUsageView /></div>
              <div v-else-if="activeTab === 'providers'" class="settings-pane__page"><ModelsView /></div>
              <div v-else-if="activeTab === 'channels'" class="settings-pane__page"><ChannelsView /></div>
              <div v-else-if="activeTab === 'logs'" class="settings-pane__page"><LogsView /></div>
              <div v-else-if="activeTab === 'performance'" class="settings-pane__page"><PerformanceView /></div>
              <div v-else-if="activeTab === 'plugins'" class="settings-pane__page"><PluginsView /></div>
              <div v-else-if="activeTab === 'mcp'" class="settings-pane__page"><McpManagerView embedded /></div>
              <div v-else-if="activeTab === 'codingAgents'" class="settings-pane__page"><CodingAgentsView /></div>
              <div v-else-if="activeTab === 'versionPreview'" class="settings-pane__page"><VersionPreviewView /></div>
              <div v-else-if="activeTab === 'devices'" class="settings-pane__page"><DevicesView /></div>
            </div>
          </div>
        </NSpin>
      </div>
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

// Hosted inside the chat sidebar surface, which owns the viewport height.
.settings-view.is-embedded {
  height: 100%;
  min-height: 0;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

// 780 (the prototype's non-wide Page column) was right when this page was only
// rows of settings. It now hosts whole pages — usage tables, logs, provider
// lists — and 780 left the pane just 496px once the 40px padding, the 168px
// rail and the 36px gap were taken out, which wrapped the usage table headers
// into vertical stacks. So the column follows the viewport instead, capped only
// so it stops growing on very wide monitors.
.settings-inner {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  padding: 48px 40px 64px;
}

// The global `.page-header` is the compact bar (padding + a bottom rule); this
// is a page title block, and the prototype puts no rule under it.
.page-header {
  margin-bottom: 36px;
  padding: 0;
  border-bottom: 0;
}

.settings-title {
  margin: 0;
}

/* ---- Prototype rail: 168px column, 36px gap to content ---- */
.settings-layout {
  display: flex;
  gap: 36px;
  align-items: flex-start;
}

.settings-rail {
  flex: 0 0 168px;
  display: flex;
  flex-direction: column;
}

// Group heading. 12px above the first row of its group, none before the very
// first heading — the rail already starts at the pane's top edge.
.settings-rail-group {
  padding: 0 12px;
  margin: 20px 0 6px;
  color: var(--fg-disabled);

  &:first-child {
    margin-top: 0;
  }
}

// Hosted full pages bring their own KpPage scroller and 48/40/64 frame. Inside
// the settings pane that frame is already provided, so strip it rather than
// nest one inside the other.
.settings-pane__page {
  :deep(.kp-page),
  :deep(.pagescroll) {
    overflow: visible;
  }

  :deep(.kp-page__inner) {
    max-width: none;
    padding: 0;
  }
}

// Geometry copied from the sidebar NavRow: 36 high, 12 side padding, r-ctl,
// 2px row rhythm — same "one column of selectable rows" everywhere.
.settings-rail-row {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  margin-bottom: 2px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  cursor: pointer;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
  text-align: left;
  white-space: nowrap;
}

// Prototype `.row:hover` — the heavier f2 step, same as the selected state.
.settings-rail-row:hover {
  background: var(--gray-f2);
}

.settings-rail-row.is-active {
  background: var(--gray-f2);
  color: var(--fg-title);
  font-weight: var(--w-medium);
}

.settings-pane {
  flex: 1;
  min-width: 0;
}

// Two different content shapes share this pane. Ordinary setting panes are
// label/control rows — stretched to 1200px the label and its switch end up at
// opposite ends of the screen — so they keep a readable measure. The hosted
// full pages are the opposite: wide tables and card grids, and they are the
// reason the column grew, so they take everything available.
.settings-pane > :not(.settings-pane__page) {
  max-width: 760px;
}

// Stacked components inside one tab keep the prototype's 36px block gap.
.pane-stack > * + * {
  margin-top: 36px;
}

/* ---- Prototype button vocabulary for pane content ----
   GhostBtn: 30px / 0 12px / r-ctl / white + inset 1px gray-e0 ring / 13px medium.
   Danger (warning/error types): danger-bg tint + danger fg, no ring.
   Primary keeps the dark fill from the theme; only geometry is normalized.
   Modals teleport to body, so their buttons are untouched. */
.settings-pane :deep(.n-button) {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-ctl);
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);
  transition: opacity var(--motion-base) var(--ease-std);
}

/* Prototype `button.ab:active` press feedback. */
.settings-pane :deep(.n-button:active) {
  opacity: 0.6;
}

.settings-pane :deep(.n-button .n-button__border),
.settings-pane :deep(.n-button .n-button__state-border) {
  display: none;
}

.settings-pane :deep(.n-button--default-type),
.settings-pane :deep(.n-button--secondary),
.settings-pane :deep(.n-button--tertiary) {
  background: var(--bg);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 1px var(--gray-e0);
}

.settings-pane :deep(.n-button--warning-type),
.settings-pane :deep(.n-button--error-type) {
  background: var(--danger-bg);
  color: var(--danger);
  box-shadow: none;
}

/* ---- Horizontal pill strip (narrow) ---- */
@media (max-width: $breakpoint-mobile) {
  .settings-inner {
    padding: 24px 16px 48px;
  }

  .settings-layout {
    flex-direction: column;
    gap: 20px;
  }

  .settings-rail {
    flex: none;
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    gap: 6px;
    padding-bottom: 4px;
  }

  .settings-rail-row {
    height: 32px;
    padding: 0 13px;
    margin-bottom: 0;
    border-radius: var(--r-pill);
    flex: 0 0 auto;
  }
}
</style>
