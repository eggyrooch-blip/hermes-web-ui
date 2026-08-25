<script setup lang="ts">
/**
 * The grouped agent-card sections (mine / group / shared). Extracted from
 * AgentsView so the standalone page (KpPage frame) and the embedded chat
 * sidebar surface can share one card list without duplicating the markup.
 */
import { computed, ref } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentCard from '@/components/hermes/agents/AgentCard.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import KpListSkeleton from '@/components/kippies/KpListSkeleton.vue'
import type { HermesProfile } from '@/api/hermes/profiles'
import type { AgentGroupKey } from '@/utils/hermes/agent-identity'

const props = defineProps<{
  sections: { key: AgentGroupKey; items: HermesProfile[] }[]
  loading: boolean
  totalCount: number
}>()
const emit = defineEmits<{ open: [name: string]; 'new-task': [name: string] }>()

const { t } = useI18n()

// Prototype default: land on 我的智能体.
const activeKey = ref<AgentGroupKey>('mine')
const activeSection = computed(
  () => props.sections.find(section => section.key === activeKey.value) ?? props.sections[0],
)

const SECTION_HINTS: Record<AgentGroupKey, string> = {
  mine: 'agentsHub.sections.mineHint',
  group: 'agentsHub.sections.groupHint',
  shared: 'agentsHub.sections.sharedHint',
}
</script>

<template>
  <!--
    Cold load draws the card skeleton rather than spinning a NSpin over an empty
    box: the grid's shape is known before the data is, and `card` + `grid` is the
    shape this page actually uses. NSpin stays for a *warm* refresh — cards are
    already on screen there, and replacing them with a skeleton would throw away
    content that is still valid.
  -->
  <NSpin :show="loading && totalCount > 0">
    <KpListSkeleton
      v-if="loading && totalCount === 0"
      variant="card"
      grid
      :rows="6"
    />
    <KpEmptyState
      v-else-if="totalCount === 0"
      :title="t('agentsHub.empty.all')"
    />

    <template v-else>
      <!-- Prototype: the groups are segmented pill tabs (我的智能体 2 |
           智能体小队 1), one group on screen at a time — not three stacked
           sections. Counts stay visible on every tab so the hidden groups
           still announce themselves. -->
      <div class="agent-tabs" role="tablist">
        <button
          v-for="section in sections"
          :key="section.key"
          type="button"
          role="tab"
          class="agent-tab"
          :class="{ 'is-on': activeKey === section.key }"
          :aria-selected="activeKey === section.key"
          :data-testid="`agents-tab-${section.key}`"
          @click="activeKey = section.key"
        >
          {{ t(`agentsHub.sections.${section.key}`) }}
          <span class="agent-tab__count" :data-testid="`agents-section-count-${section.key}`">
            {{ section.items.length }}
          </span>
        </button>
      </div>

      <!-- Keyed on the tab so switching replays the global .tabfade rise-in
           (keep-motion.scss) instead of swapping content in place. -->
      <section v-if="activeSection" :key="activeSection.key" class="agent-section tabfade">
        <KpSectionTitle :note="t(SECTION_HINTS[activeSection.key])">
          {{ t(`agentsHub.sections.${activeSection.key}`) }}
        </KpSectionTitle>

        <div v-if="activeSection.items.length > 0" class="agent-grid">
          <AgentCard
            v-for="profile in activeSection.items"
            :key="profile.name"
            :profile="profile"
            @open="emit('open', $event)"
            @new-task="emit('new-task', $event)"
          />
        </div>
        <!-- An empty group is the normal state (shared especially: the broker
             call behind it degrades to [] on failure) — say so, never error. -->
        <p v-else class="t-sub agent-section__empty">
          {{ t(activeSection.key === 'shared' ? 'agentsHub.empty.shared' : 'agentsHub.empty.section') }}
        </p>
      </section>
    </template>
  </NSpin>
</template>

<style scoped lang="scss">
// SegChip tab row (prototype): 28px pills, 12/500, gap 6; the selected one
// carries the only tint; counts are quiet tabular numerals.
.agent-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 24px;
}

.agent-tab {
  height: 28px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  font: var(--w-medium) var(--t-12) / 1.35 var(--font-cn);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);

  &:hover {
    color: var(--fg-primary);
  }

  &.is-on {
    background: var(--gray-f2);
    color: var(--fg-title);
  }
}

.agent-tab__count {
  margin-left: 8px;
  color: var(--fg-disabled);
  font-variant-numeric: tabular-nums;

  .agent-tab.is-on & {
    color: var(--fg-aux);
  }
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  column-gap: 20px;
  row-gap: 20px;
  margin-top: 16px;
}

.agent-section__empty {
  margin-top: 16px;
  color: var(--fg-aux);
}
</style>
