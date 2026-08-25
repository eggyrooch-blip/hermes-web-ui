<script setup lang="ts">
import { computed } from 'vue'
import JobCard from './JobCard.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import KpListSkeleton from '@/components/kippies/KpListSkeleton.vue'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  selectedJobId: string | null
  sortBy: 'time' | 'name'
  sortAsc: boolean
  filter?: 'all' | 'enabled'
}>(), {
  filter: 'all',
})

const emit = defineEmits<{
  edit: [jobId: string]
  select: [jobId: string | null]
}>()

const { t } = useI18n()

const jobsStore = useJobsStore()

const sortedJobs = computed(() => {
  const jobs = [...jobsStore.jobs]
  const field = props.sortBy
  const asc = props.sortAsc

  if (field === 'name') {
    jobs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') * (asc ? 1 : -1))
  } else {
    // time: array index = creation order (index 0 = oldest)
    // asc: oldest first (original order), desc: newest first (reversed)
    if (!asc) jobs.reverse()
  }

  return jobs
})

const visibleJobs = computed(() => {
  if (props.filter === 'enabled') return sortedJobs.value.filter(job => job.enabled)
  return sortedJobs.value
})

function handleSelect(jobId: string) {
  emit('select', props.selectedJobId === jobId ? null : jobId)
}

function handleDeselect() {
  if (props.selectedJobId) {
    emit('select', null)
  }
}
</script>

<template>
  <!--
    The skeleton has to come BEFORE the empty state. With only the empty branch,
    the first paint of a cold load says "you have no automations" and then swaps
    to a list — a claim that turns out to be false. `table` is the right variant:
    a rule is a fixed-height 56px single-line row, not a card.
  -->
  <KpListSkeleton
    v-if="jobsStore.loading && jobsStore.jobs.length === 0"
    variant="table"
    :rows="4"
  />
  <KpEmptyState
    v-else-if="jobsStore.jobs.length === 0"
    :title="t('jobs.emptyTitle')"
    :body="t('jobs.noJobs')"
  />
  <div v-else class="rules">
    <JobCard
      v-for="job in visibleJobs"
      :key="job.id"
      :job="job"
      :selected="selectedJobId === (job.job_id || job.id)"
      @edit="emit('edit', job.id)"
      @select="handleSelect"
    />
  </div>
  <!-- Click outside cards to deselect -->
  <div
    v-if="selectedJobId"
    class="deselect-overlay"
    @click="handleDeselect"
  />
</template>

<style scoped lang="scss">
.rules {
  display: flex;
  flex-direction: column;
}

.deselect-overlay {
  display: none;
}
</style>
