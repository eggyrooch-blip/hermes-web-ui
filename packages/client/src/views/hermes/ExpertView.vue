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

    <section class="expert-panel" role="tabpanel">
      <SkillsView v-if="activeTab === 'skills'" />
      <CredentialsView v-else />
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

.expert-tabs-bar {
  flex: 0 0 auto;
  min-height: 44px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  align-items: center;
  border-bottom: 1px solid $border-color;
  background: $bg-primary;
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
:deep(.credentials-view) {
  height: 100%;
  min-height: 0;
}

@media (min-width: 768px) {
  .expert-tabs-bar {
    width: fit-content;
    min-width: 240px;
    margin: 6px 0 0 24px;
    border: 1px solid $border-color;
    border-radius: $radius-sm;
  }
}
</style>
