<script setup lang="ts">
import JobCard from './JobCard.vue'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'

const props = defineProps<{
  selectedJobId: string | null
}>()

const emit = defineEmits<{
  edit: [jobId: string]
  select: [jobId: string | null]
}>()

const { t } = useI18n()

const jobsStore = useJobsStore()

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
  <div v-if="jobsStore.gatewayUnavailable" class="empty-state gateway-state">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="empty-icon">
      <path d="M12 2v4"/>
      <path d="M12 18v4"/>
      <path d="m4.93 4.93 2.83 2.83"/>
      <path d="m16.24 16.24 2.83 2.83"/>
      <path d="M2 12h4"/>
      <path d="M18 12h4"/>
      <path d="m4.93 19.07 2.83-2.83"/>
      <path d="m16.24 7.76 2.83-2.83"/>
    </svg>
    <div>
      <p class="empty-title">{{ t('jobs.gatewayUnavailable') }}</p>
      <p class="empty-hint">{{ t('jobs.gatewayUnavailableHint') }}</p>
    </div>
    <div class="gateway-actions">
      <NButton size="small" :loading="jobsStore.loading" @click="jobsStore.fetchJobs">
        {{ t('common.retry') }}
      </NButton>
    </div>
  </div>
  <div v-else-if="jobsStore.jobs.length === 0" class="empty-state">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="empty-icon">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
    <p>{{ t('jobs.noJobs') }}</p>
  </div>
  <div v-else class="jobs-grid">
    <JobCard
      v-for="job in jobsStore.jobs"
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
@use '@/styles/variables' as *;

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: $text-muted;
  gap: 12px;

  .empty-icon {
    opacity: 0.3;
  }

  p {
    font-size: 14px;
  }

  .empty-title {
    margin: 0 0 4px;
    color: $text-secondary;
    font-weight: 600;
  }

  .empty-hint {
    margin: 0;
    max-width: 420px;
    color: $text-muted;
    line-height: 1.5;
  }
}

.gateway-state {
  min-height: 220px;
  padding: 28px;
  border: 1px dashed $border-color;
  border-radius: $radius-md;
  background: rgba(var(--accent-primary-rgb), 0.04);
  text-align: center;
}

.gateway-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.jobs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
  gap: 14px;
}

.deselect-overlay {
  display: none;
}
</style>
