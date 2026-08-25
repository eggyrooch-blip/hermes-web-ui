<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { NSpin, NCollapse, NCollapseItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listCronRuns, readCronRun } from '@/api/hermes/cron-history'
import type { RunEntry, RunDetail } from '@/api/hermes/cron-history'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'

const props = defineProps<{
  selectedJobId: string | null
  jobNameMap: Record<string, string>
  profileKey: string
}>()

const { t } = useI18n()
const loading = ref(false)
const runs = ref<RunEntry[]>([])
const expandedContent = ref<Record<string, string>>({})
const loadingContent = ref<Record<string, boolean>>({})

const filteredRuns = computed(() => {
  if (!props.selectedJobId) return runs.value
  return runs.value.filter(r => r.jobId === props.selectedJobId)
})

async function fetchRuns() {
  loading.value = true
  try {
    runs.value = await listCronRuns(props.selectedJobId ?? undefined)
  } catch (err) {
    console.error('Failed to fetch cron runs:', err)
    runs.value = []
  } finally {
    loading.value = false
  }
}

async function handleExpand(key: string | number | Array<string | number>) {
  // accordion mode emits a single value; non-accordion emits an array
  const keys = Array.isArray(key) ? key : key != null ? [key] : []
  for (const raw of keys) {
    const k = String(raw)
    if (expandedContent.value[k] || loadingContent.value[k]) continue

    const run = filteredRuns.value.find(r => `${r.jobId}/${r.fileName}` === k)
    if (!run) continue

    loadingContent.value[k] = true
    try {
      const detail: RunDetail = await readCronRun(run.jobId, run.fileName)
      expandedContent.value[k] = detail.content
    } catch (err) {
      expandedContent.value[k] = `[Error loading content]`
    } finally {
      loadingContent.value[k] = false
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function getJobName(jobId: string): string {
  return props.jobNameMap[jobId] || jobId
}

watch(() => [props.selectedJobId, props.profileKey], () => {
  expandedContent.value = {}
  fetchRuns()
}, { immediate: true })
</script>

<template>
  <div class="run-history">
    <KpSectionTitle :note="t('jobs.runHistory.recentTimes', { count: filteredRuns.length })">
      {{ t('jobs.runHistory.title') }}
    </KpSectionTitle>

    <div class="history-body">
      <NSpin :show="loading">
        <KpEmptyState
          v-if="!loading && filteredRuns.length === 0"
          :title="t('jobs.runHistory.noRuns')"
        />

        <NCollapse
          v-else
          accordion
          @update:expanded-names="handleExpand"
        >
          <NCollapseItem
            v-for="run in filteredRuns"
            :key="`${run.jobId}/${run.fileName}`"
            :name="`${run.jobId}/${run.fileName}`"
          >
            <template #header>
              <span class="run-row">
                <span class="run-row__tile">
                  <KpIcon name="line_check" :size="18" color="var(--action-press)" />
                </span>
                <span class="run-row__text">
                  <span class="run-row__name">{{ getJobName(run.jobId) }}</span>
                  <span class="run-row__desc">{{ run.runTime }}</span>
                </span>
              </span>
            </template>
            <template #header-extra>
              <span class="run-meta t-meta">{{ formatSize(run.size) }}</span>
            </template>

            <NSpin v-if="loadingContent[`${run.jobId}/${run.fileName}`]" size="small" />
            <MarkdownRenderer v-else-if="expandedContent[`${run.jobId}/${run.fileName}`]" :content="expandedContent[`${run.jobId}/${run.fileName}`]" />
          </NCollapseItem>
        </NCollapse>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-history {
  display: flex;
  flex-direction: column;
}

.history-body {
  margin-top: 4px;
}

// Prototype AutoScreen 运行记录 uses CatalogRow anatomy: a 40px rounded tile
// on the left, a two-line text block (name + desc), and right-aligned meta.
.run-row {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.run-row__tile {
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  display: grid;
  place-items: center;
}

.run-row__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.run-row__name {
  font: var(--w-semibold) var(--t-14) / 1.6 var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-row__desc {
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  color: var(--fg-aux);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-meta {
  color: var(--fg-disabled);
  font-family: var(--font-data);
}
</style>
