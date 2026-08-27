<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import type { Job } from '@/api/hermes/jobs'
import { scheduleToDisplayText } from '@/api/hermes/jobs'
import { fetchExperts } from '@/api/hermes/experts'
import { getActiveProfileName } from '@/api/client'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

// One expert catalog fetch per profile shared by every card on the page.
const expertNamesByProfile = new Map<string, Promise<Map<string, string>>>()

function expertNamesFor(profile: string): Promise<Map<string, string>> {
  // Always keyed by a REAL profile name — a shared key across profile
  // switches would let profile A's catalog label profile B's cards.
  let cached = expertNamesByProfile.get(profile)
  if (!cached) {
    cached = fetchExperts(profile).then(
      data => new Map((data.experts || []).map(expert => [expert.id, expert.name || expert.id])),
    )
    cached.catch(() => expertNamesByProfile.delete(profile))
    expertNamesByProfile.set(profile, cached)
  }
  return cached
}

const props = defineProps<{
  job: Job
  selected?: boolean
}>()

const emit = defineEmits<{
  edit: [jobId: string]
  select: [jobId: string]
}>()

const { t } = useI18n()
const jobsStore = useJobsStore()
const message = useMessage()

const jobId = computed(() => props.job.job_id || props.job.id)

const statusLabel = computed(() => {
  if (props.job.state === 'running') return t('jobs.status.running')
  if (props.job.state === 'paused') return t('jobs.status.paused')
  if (!props.job.enabled) return t('jobs.status.disabled')
  return t('jobs.status.scheduled')
})

const statusType = computed(() => {
  if (props.job.state === 'running') return 'info' as const
  if (props.job.state === 'paused') return 'warning' as const
  if (!props.job.enabled) return 'error' as const
  return 'success' as const
})

const scheduleExpr = computed(() => scheduleToDisplayText(props.job.schedule, props.job.schedule_display || '—'))

const profilesStore = useProfilesStore()

// Executor identity (M-0): show which digital employee (+ expert) runs this
// job. agent_id maps back to a routing-row id carried on the profile list.
const executorProfile = computed(() => {
  const agentId = props.job.agent_id
  if (!agentId) return null
  return profilesStore.profiles.find(p => p.agentId === agentId) ?? null
})

const executorAgentLabel = computed(() => {
  if (!props.job.agent_id) return ''
  const profile = executorProfile.value
  return profile?.displayLabel || profile?.alias || profile?.name || props.job.agent_id
})

// Expert badge shows the human-readable expert NAME, resolved from the agent
// profile's expert catalog; the raw id is only the fallback.
const executorExpertLabel = ref(props.job.expert_id || '')
onMounted(async () => {
  const expertId = props.job.expert_id
  if (!expertId) return
  // Agent task → that agent's catalog; expert-only task → the ACTIVE profile's
  // (by explicit name, so the cache can never serve another profile's names).
  const profileName = executorProfile.value?.name ?? getActiveProfileName()
  if (!profileName) return
  try {
    const names = await expertNamesFor(profileName)
    executorExpertLabel.value = names.get(expertId) || expertId
  } catch {
    // keep the id fallback
  }
})

const formatTime = (t?: string | null) => {
  if (!t) return '—'
  return new Date(t).toLocaleString()
}

async function handlePause() {
  try {
    await jobsStore.pauseJob(jobId.value)
    message.success(t('jobs.jobPaused'))
  } catch (e: any) {
    message.error(e.message)
  }
}

async function handleResume() {
  try {
    await jobsStore.resumeJob(jobId.value)
    message.success(t('jobs.jobResumed'))
  } catch (e: any) {
    message.error(e.message)
  }
}

async function handleRun() {
  try {
    await jobsStore.runJob(jobId.value)
    message.info(t('jobs.jobTriggered'))
  } catch (e: any) {
    message.error(e.message)
  }
}

async function handleDelete() {
  try {
    await jobsStore.deleteJob(jobId.value)
    message.success(t('jobs.jobDeleted'))
  } catch (e: any) {
    message.error(e.message)
  }
}

function handleCardClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.card-actions')) return
  emit('select', jobId.value)
}
</script>

<template>
  <div class="job-card" :class="{ selected }" @click="handleCardClick">
    <div class="card-header">
      <h3 class="job-name">{{ job.name }}</h3>
      <span class="status-badge" :class="statusType">{{ statusLabel }}</span>
    </div>

    <div class="card-body">
      <div v-if="executorAgentLabel || job.expert_id" class="info-row" data-testid="job-executor">
        <span class="info-label">{{ t('jobs.info.executor') }}</span>
        <span class="info-value">
          <template v-if="executorAgentLabel">🤖 {{ executorAgentLabel }}</template>
          <span v-if="job.expert_id" class="executor-expert">{{ executorExpertLabel }}</span>
        </span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.schedule') }}</span>
        <code class="info-value mono">{{ scheduleExpr }}</code>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.model') }}</span>
        <span class="info-value mono">{{ job.model || '—' }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.lastRun') }}</span>
        <span class="info-value">
          {{ formatTime(job.last_run_at) }}
          <span v-if="job.last_status" class="run-status" :class="{ ok: job.last_status === 'ok', err: job.last_status !== 'ok' }">
            {{ job.last_status === 'ok' ? t('common.ok') : job.last_status }}
          </span>
        </span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.nextRun') }}</span>
        <span class="info-value">{{ formatTime(job.next_run_at) }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.deliver') }}</span>
        <span class="info-value">{{ job.deliver }}<template v-if="job.origin"> ({{ job.origin.platform }})</template></span>
      </div>
      <div v-if="job.repeat" class="info-row">
        <span class="info-label">{{ t('jobs.info.repeat') }}</span>
        <span class="info-value">
          <template v-if="typeof job.repeat === 'string'">{{ job.repeat }}</template>
          <template v-else>{{ job.repeat.completed }} / {{ job.repeat.times ?? '∞' }}</template>
        </span>
      </div>
    </div>

    <div class="card-actions">
      <NTooltip v-if="job.state !== 'paused' && job.enabled">
        <template #trigger>
          <NButton size="tiny" quaternary @click.stop="handlePause">{{ t('jobs.action.pause') }}</NButton>
        </template>
        {{ t('jobs.action.pauseJob') }}
      </NTooltip>
      <NTooltip v-else-if="job.state === 'paused'">
        <template #trigger>
          <NButton size="tiny" quaternary @click.stop="handleResume">{{ t('jobs.action.resume') }}</NButton>
        </template>
        {{ t('jobs.action.resumeJob') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton size="tiny" quaternary @click.stop="handleRun">{{ t('jobs.action.runNow') }}</NButton>
        </template>
        {{ t('jobs.action.triggerImmediately') }}
      </NTooltip>
      <NButton size="tiny" quaternary @click.stop="emit('edit', jobId)">{{ t('common.edit') }}</NButton>
      <NButton size="tiny" quaternary type="error" @click.stop="handleDelete">{{ t('common.delete') }}</NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.job-card {
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  transition: border-color $transition-fast;
  cursor: pointer;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }

  &.selected {
    border-color: rgba(var(--accent-primary-rgb), 0.6);
    background-color: rgba(var(--accent-primary-rgb), 0.04);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.job-name {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;

  &.success {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.info {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.warning {
    background: rgba(var(--warning-rgb), 0.12);
    color: $warning;
  }

  &.error {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.info-label {
  font-size: 12px;
  color: $text-muted;
}

.info-value {
  font-size: 12px;
  color: $text-secondary;
}

.run-status {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 500;

  &.ok { color: $success; }
  &.err { color: $error; }
}

.executor-expert {
  margin-left: 6px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: $accent-primary;
}

.mono {
  font-family: $font-code;
  font-size: 12px;
}

.card-actions {
  display: flex;
  gap: 4px;
  border-top: 1px solid $border-light;
  padding-top: 10px;
}
</style>
