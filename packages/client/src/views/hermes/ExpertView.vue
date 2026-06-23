<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SkillsView from '@/views/hermes/SkillsView.vue'
import CredentialsView from '@/views/hermes/CredentialsView.vue'

type ExpertTab = 'skills' | 'connectors'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const activeTab = ref<ExpertTab>('skills')

const tabs = computed<Array<{ key: ExpertTab; label: string }>>(() => [
  { key: 'skills', label: t('expert.tabs.skills') },
  { key: 'connectors', label: t('expert.tabs.connectors') },
])

function normalizeTab(value: unknown): ExpertTab {
  return value === 'connectors' ? 'connectors' : 'skills'
}

function isValidTab(value: unknown): value is ExpertTab {
  return value === 'skills' || value === 'connectors'
}

function tabQuery(tab: ExpertTab) {
  return tab === 'skills' ? undefined : tab
}

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
  <div class="expert-view">
    <header class="page-header expert-header">
      <h2 class="header-title">{{ t('sidebar.expert') }}</h2>
      <div class="expert-tabs" role="tablist" :aria-label="t('sidebar.expert')">
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
      </div>
    </header>

    <SkillsView v-if="activeTab === 'skills'" />
    <CredentialsView v-else />
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

.expert-header {
  gap: 16px;
}

.expert-tabs {
  display: inline-grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.expert-tab {
  min-width: 88px;
  height: 28px;
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
</style>
