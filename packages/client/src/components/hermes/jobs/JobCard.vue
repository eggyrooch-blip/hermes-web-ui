<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Job } from '@/api/hermes/jobs'
import { scheduleToDisplayText } from '@/api/hermes/jobs'
import { fetchExperts } from '@/api/hermes/experts'
import { getActiveProfileName } from '@/api/client'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpIconBtn from '@/components/kippies/KpIconBtn.vue'
import KpActionIcon from '@/components/kippies/KpActionIcon.vue'
import KpToggle from '@/components/kippies/KpToggle.vue'
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
const profilesStore = useProfilesStore()

const jobId = computed(() => props.job.job_id || props.job.id)

const scheduleExpr = computed(() => scheduleToDisplayText(props.job.schedule, props.job.schedule_display || '—'))

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

// The row avatar is the job's EXECUTOR, not the profile you happen to be
// looking at. Before M-0 those were the same thing (jobs were profile-scoped),
// so the avatar read the active profile — since agent_id landed, that would
// paint every row with the same face regardless of who actually runs it.
// Falls back to the active profile for legacy jobs that carry no agent_id.
const ownerName = computed(() => executorProfile.value?.name || profilesStore.activeProfile?.name || profilesStore.activeProfileName || 'default')
const ownerAvatar = computed(() => executorProfile.value?.avatar ?? profilesStore.activeProfile?.avatar ?? null)

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


// The action chain / prompt lives in the row tooltip, not on the row itself.
const rowTitle = computed(() => {
  const parts: string[] = [scheduleExpr.value]
  const prompt = props.job.prompt_preview || props.job.prompt
  if (prompt) parts.push(prompt)
  if (props.job.skills?.length) parts.push(props.job.skills.join(', '))
  return parts.filter(Boolean).join(' — ')
})

const canPause = computed(() => props.job.enabled && props.job.state !== 'paused')

/**
 * The switch answers for itself, so it needs neither a toast nor a state icon:
 * on success the row's own enabled styling changes, and on failure the switch
 * flips back. That revert IS the failure message — a switch that returns to
 * where it was says "this did not take" more directly than a line of text at
 * the bottom of the screen.
 *
 * It needs a local override because the displayed value comes from the store,
 * which only changes once the request lands; without it there is nothing to
 * revert and the switch would simply sit still for the whole round trip.
 */
const pendingEnabled = ref<boolean | null>(null)
const isEnabled = computed(() => pendingEnabled.value ?? props.job.enabled)

async function handleToggle() {
  pendingEnabled.value = !isEnabled.value
  try {
    await jobsStore.updateJob(jobId.value, { enabled: pendingEnabled.value })
  } catch {
    // Nothing to undo by hand: the store was never written, so dropping the
    // override below is itself the revert.
  } finally {
    // `updateJob` writes the store before it resolves, so handing control back
    // shows the new value with no flicker on success — and on failure it shows
    // the untouched old value, which is the switch flipping back.
    pendingEnabled.value = null
  }
}

const pauseJob = () => jobsStore.pauseJob(jobId.value)
const resumeJob = () => jobsStore.resumeJob(jobId.value)
const runJob = () => jobsStore.runJob(jobId.value)
const deleteJob = () => jobsStore.deleteJob(jobId.value)

function handleRowClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.job-row__actions') || target.closest('.kp-toggle')) return
  emit('select', jobId.value)
}
</script>

<template>
  <div
    class="job-row catrow"
    :class="{ 'is-selected': selected, 'is-disabled': !isEnabled }"
    :title="rowTitle"
    @click="handleRowClick"
  >
    <span class="job-row__name">{{ job.name }}</span>

    <span class="job-row__trigger">
      <KpIcon name="line_timer" :size="14" />
      <span class="job-row__sched">{{ scheduleExpr }}</span>
    </span>

    <!-- 执行者 (M-0): WHO runs this job, which since agent_id landed is no
         longer "whatever profile you are looking at". Legacy jobs carry
         neither id and get no chip at all. -->
    <span
      v-if="executorAgentLabel || job.expert_id"
      class="job-row__executor"
      data-testid="job-executor"
    >
      <span v-if="executorAgentLabel" class="job-row__agent">{{ executorAgentLabel }}</span>
      <span v-if="job.expert_id" class="job-row__expert">{{ executorExpertLabel }}</span>
    </span>

    <!-- These row actions are a functional superset: the prototype's rule row
         carries only the switch. They keep their 32px hover-revealed geometry
         and resting `--fg-aux` exactly, and gain the four states, so the answer
         to a press arrives on the control that was pressed. Edit stays a plain
         KpIconBtn — it opens a dialog, which is its own answer. -->
    <div class="job-row__actions">
      <KpActionIcon
        v-if="canPause"
        icon="line_pause_circle"
        :size="16"
        :box="32"
        :ring="false"
        idle-color="var(--fg-aux)"
        :title="t('jobs.action.pauseJob')"
        :run="pauseJob"
      />
      <KpActionIcon
        v-else-if="job.state === 'paused'"
        icon="line_start"
        :size="16"
        :box="32"
        :ring="false"
        idle-color="var(--fg-aux)"
        :title="t('jobs.action.resumeJob')"
        :run="resumeJob"
      />
      <KpActionIcon
        icon="full_playing"
        :size="16"
        :box="32"
        :ring="false"
        idle-color="var(--fg-aux)"
        :title="t('jobs.action.triggerImmediately')"
        :run="runJob"
      />
      <KpIconBtn
        name="line_edit"
        :size="16"
        :title="t('common.edit')"
        @click="emit('edit', jobId)"
      />
      <!-- Success removes this row, so there is no button left to show `ok` on:
           the row vanishing is the answer. Failure still lands here. -->
      <KpActionIcon
        icon="line_delete"
        :size="16"
        :box="32"
        :ring="false"
        idle-color="var(--fg-aux)"
        :title="t('common.delete')"
        :run="deleteJob"
        no-ok
      />
    </div>

    <ProfileAvatar
      class="job-row__avatar"
      :name="ownerName"
      :avatar="ownerAvatar"
      :size="26"
    />

    <KpToggle :on="isEnabled" @update:on="handleToggle" />
  </div>
</template>

<style scoped lang="scss">
.job-row {
  display: flex;
  align-items: center;
  // Row gap 4, column gap 16: when the row wraps on a narrow page the two
  // lines should sit 4 apart, not 16.
  gap: 4px 16px;
  height: 56px;
  padding: 0 12px;
  margin: 0 -12px;
  border-top: 0.5px solid var(--divider);
  cursor: pointer;

  &.is-selected {
    background: var(--gray-fa);
  }
}

.job-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);

  .is-disabled & {
    color: var(--fg-aux);
  }
}

.job-row__trigger {
  flex: 0 1 auto;
  min-width: 0;
  margin-right: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-disabled);
}

.job-row__sched {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  color: var(--fg-aux);
}

.job-row__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-std);

  .job-row:hover &,
  .job-row.is-selected & {
    opacity: 1;
  }
}
.job-row__avatar {
  opacity: 1;

  .is-disabled & {
    opacity: 0.5;
  }
}

/* 执行者 chip. Sits between the schedule and the hover-revealed actions, so it
   must stay one line and yield width rather than push the actions off the row. */
.job-row__executor {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--fg-secondary);
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
}

.job-row__agent,
.job-row__expert {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.job-row__expert {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--fg-primary);
}
</style>
