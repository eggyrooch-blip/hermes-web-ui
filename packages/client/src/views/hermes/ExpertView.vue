<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SkillsView from '@/views/hermes/SkillsView.vue'
import CredentialsView from '@/views/hermes/CredentialsView.vue'
import ExpertCatalogView from '@/views/hermes/ExpertCatalogView.vue'

type ExpertTab = 'experts' | 'skills' | 'connectors'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
})
const activeTab = ref<ExpertTab>('experts')

const tabs = computed<Array<{ key: ExpertTab; label: string }>>(() => [
  { key: 'experts', label: t('expert.tabs.experts') },
  { key: 'skills', label: t('expert.tabs.skills') },
  { key: 'connectors', label: t('expert.tabs.connectors') },
])

function normalizeTab(value: unknown): ExpertTab {
  if (value === 'skills') return 'skills'
  if (value === 'connectors') return 'connectors'
  return 'experts'
}

function isValidTab(value: unknown): value is ExpertTab {
  return value === 'experts' || value === 'skills' || value === 'connectors'
}

function tabQuery(tab: ExpertTab) {
  // `experts` is the default tab — keep the URL clean (no query param).
  return tab === 'experts' ? undefined : tab
}

// Keep AI Hub entry. Lives in the shared expert header (top-right), visible on
// all three tabs. Replaces the old config-driven AiHub share button; hardcoded
// ark URL matches the standalone /hermes/skills toolbar link.
const KEEP_AIHUB_URL = 'https://ark.gotokeep.com/aidock-cms/admin/skills'

function selectTab(tab: ExpertTab) {
  activeTab.value = tab
  void router.replace({
    query: {
      ...route.query,
      tab: tabQuery(tab),
    },
  })
}

watch(() => route.query.tab, (tab) => {
  const normalized = normalizeTab(tab)
  activeTab.value = normalized
  if (tab !== undefined && !isValidTab(tab)) {
    void router.replace({
      query: {
        ...route.query,
        tab: undefined,
      },
    })
  }
}, { immediate: true })
</script>

<template>
  <div class="expert-view" :class="{ 'is-embedded': props.embedded }">
    <div class="expert-header">
      <nav class="expert-tabs-bar" role="tablist" :aria-label="t('sidebar.expert')">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="expert-tab"
          :class="{ active: activeTab === tab.key }"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          @click="selectTab(tab.key)"
        >
          {{ tab.label }}
        </button>
      </nav>

      <a
        class="keephub-link"
        :href="KEEP_AIHUB_URL"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t('skills.keepHubLink') }}
      </a>
    </div>

    <section class="expert-panel" role="tabpanel">
      <ExpertCatalogView v-if="activeTab === 'experts'" />
      <SkillsView v-else-if="activeTab === 'skills'" embedded />
      <CredentialsView v-else embedded prefer-active-profile />
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.expert-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.expert-view.is-embedded {
  height: 100%;
}

.expert-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-right: 16px;
  border-bottom: 1px solid $border-color;
  background: $bg-primary;
}

.expert-tabs-bar {
  flex: 0 0 auto;
  min-height: 44px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  align-items: center;
  background: $bg-primary;
}

// Ported verbatim from SkillsView's .keephub-link so the entry keeps the exact
// same font/look after moving into the shared header. flex:0 0 auto keeps it
// tight at the right edge of the space-between header.
.keephub-link {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent-primary);
  text-decoration: none;
  white-space: nowrap;
  transition: color $transition-fast;

  &:hover {
    color: var(--accent-hover);
  }
}

.expert-tab {
  height: 32px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}

.expert-panel {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

:deep(.skills-view),
:deep(.credentials-view),
:deep(.expert-catalog-view) {
  min-height: 0;
}

@media (min-width: 768px) {
  .expert-tabs-bar {
    width: fit-content;
    min-width: 320px;
    margin: 6px 0 0 24px;
    border: 1px solid $border-color;
    border-radius: $radius-sm;
  }
}
</style>
