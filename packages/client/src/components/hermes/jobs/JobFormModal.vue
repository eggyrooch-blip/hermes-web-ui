<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, NInputNumber, useMessage } from 'naive-ui'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'
import {
  buildJobUpdateRequest,
  getJob,
  jobRepeatToEditValue,
  scheduleToEditableInput,
} from '@/api/hermes/jobs'
import type { CreateJobRequest, Job } from '@/api/hermes/jobs'
import { fetchSkills } from '@/api/hermes/skills'
import type { SkillInfo } from '@/api/hermes/skills'
import { fetchExperts } from '@/api/hermes/experts'
import { getActiveProfileName } from '@/api/client'
import { agentDisplayName, groupAgents } from '@/utils/hermes/agent-identity'
import {
  buildScheduleExpression,
  parseScheduleExpression,
  scheduleWeekdayOptions,
  SCHEDULE_HOUR_OPTIONS,
  SCHEDULE_MINUTE_OPTIONS,
  SCHEDULE_MONTH_DAY_OPTIONS,
  type ScheduleFrequency,
} from '@/utils/schedule-frequency'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

const props = defineProps<{
  jobId: string | null
  initialName?: string
  initialPrompt?: string
  initialSkills?: string[]
  sourceSessionId?: string
  expertId?: string
  idempotencyKey?: string
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const jobsStore = useJobsStore()
const settingsStore = useSettingsStore()
const profilesStore = useProfilesStore()
const appStore = useAppStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const skillsLoading = ref(false)
const skillOptions = ref<Array<{ label: string; value: string }>>([])

// Executor (sunke 2026-08-17 final ruling): the executor AGENT is REQUIRED —
// the picker loads the same roster as the Agents hub (My agents + Group
// agents, via groupAgents). The EXPERT is optional and comes from the SELECTED
// agent's own catalog (each agent owns a different expert set) — picked expert
// is injected into that agent's run. Default agent = the caller's own profile.
// Shared-with-me agents stay out: the BFF profile resolver only honors owned.
const ownProfileName = getActiveProfileName() || ''
const executorAgentProfile = ref<string>(ownProfileName)
const executorExpertId = ref<string | null>(null)
const expertsLoading = ref(false)
const expertOptions = ref<Array<{ label: string; value: string }>>([])

const agentOptions = computed(() => {
  const sections = groupAgents(profilesStore.profiles)
  const labels: Record<string, string> = {
    mine: t('jobs.executorGroupMine'),
    group: t('jobs.executorGroupGroups'),
  }
  return sections
    .filter(section => section.key !== 'shared' && section.items.length > 0)
    .map(section => ({
      type: 'group',
      label: labels[section.key],
      key: section.key,
      children: section.items.map(profile => ({
        // Same normalization the Agents-page cards use — group rows must show
        // the group NAME, never the raw ou_/oc_ identifier in displayLabel.
        label: agentDisplayName(profile, t('agentsHub.unnamedGroup')),
        value: profile.name,
      })),
    }))
})

// Guard against out-of-order responses: rapid A→B agent switches must never
// let A's slower expert catalog populate B's picker.
let expertsRequestSeq = 0

async function loadExpertOptions(profile: string) {
  const seq = ++expertsRequestSeq
  executorExpertId.value = null
  expertOptions.value = []
  expertsLoading.value = true
  try {
    // Always request the SELECTED profile explicitly — a no-argument call
    // would silently track the sidebar's active profile if the user switches
    // it while this modal stays open.
    const data = await fetchExperts(profile)
    if (seq !== expertsRequestSeq) return
    expertOptions.value = (data.experts || []).map(expert => ({
      label: expert.name || expert.id,
      value: expert.id,
    }))
  } catch {
    if (seq === expertsRequestSeq) expertOptions.value = []
  } finally {
    if (seq === expertsRequestSeq) expertsLoading.value = false
  }
}

watch(executorAgentProfile, (profile) => {
  void loadExpertOptions(profile)
})

// Per-job model. '' = follow the profile default (no `model` key sent, request
// byte-identical to today). Value is the full "provider/model" spec; the
// runtime self-heals to the profile default if the model is later delisted.
const modelValue = ref<string>('')

// Same resolution the chat model picker uses: the SELECTED executor's own
// catalog, falling back to the aggregate only when that profile has none.
// Reading the aggregate directly would offer a model contributed by a
// different profile, which the run would then fail to resolve.
const modelGroupsForExecutor = computed(() => {
  const entry = appStore.profileModelGroups.find(
    candidate => candidate.profile === executorAgentProfile.value,
  )
  return entry?.groups?.length ? entry.groups : appStore.modelGroups
})

const modelOptions = computed(() => {
  const groups = modelGroupsForExecutor.value
  const options: Array<{ label: string; value: string; disabled?: boolean }> = [
    { label: t('jobs.modelFollowDefault'), value: '' },
  ]
  for (const group of groups) {
    for (const model of group.models) {
      // Catalog ids are sometimes ALREADY provider-qualified (e.g.
      // "custom:litellm-sre/tencent-sonnet-4-6"). Prefixing again would send a
      // doubled spec that resolves to no model at all.
      const spec = model.startsWith(`${group.provider}/`) ? model : `${group.provider}/${model}`
      options.push({
        label: groups.length > 1
          ? `${group.label} · ${appStore.displayModelName(model, group.provider)}`
          : appStore.displayModelName(model, group.provider),
        value: spec,
        // Same disabled metadata the chat picker honours — a scheduled run on a
        // disabled model fails or silently falls back.
        disabled: !!group.model_meta?.[model]?.disabled,
      })
    }
  }
  return options
})

// The chosen model belongs to the executor's catalog: switching executors must
// not keep a selection the new executor cannot run.
watch(executorAgentProfile, () => {
  // Keep the selection only if the NEW executor offers it AND can run it.
  const match = modelOptions.value.find(option => option.value === modelValue.value)
  if (modelValue.value && (!match || match.disabled)) {
    modelValue.value = ''
  }
})

const formData = ref({
  name: props.initialName || '',
  schedule: '',
  prompt: props.initialPrompt || '',
  deliver: props.sourceSessionId ? 'feishu' : 'origin',
  skills: [...(props.initialSkills || [])],
  repeat_times: null as number | null,
})

// Nothing is preselected: a job only ever gets the Cron the operator chose,
// either by picking a frequency or by typing the expression themselves.
const scheduleFrequency = ref<ScheduleFrequency | null>(null)
const scheduleHour = ref(9)
const scheduleMinute = ref(0)
const scheduleWeekday = ref(1)
const scheduleMonthDay = ref(1)

const isEdit = computed(() => !!props.jobId)
const isScheduledExpert = computed(() => !isEdit.value && !!props.sourceSessionId)

const scheduleFrequencyOptions = computed(() => [
  { label: t('jobs.presetEveryMinute'), value: 'every-minute' },
  { label: t('jobs.presetEvery5Min'), value: 'every-5-minutes' },
  { label: t('jobs.presetEvery30Min'), value: 'every-30-minutes' },
  { label: t('jobs.presetEveryHour'), value: 'hourly' },
  { label: t('jobs.frequencyDaily'), value: 'daily' },
  { label: t('jobs.frequencyWeekly'), value: 'weekly' },
  { label: t('jobs.frequencyMonthly'), value: 'monthly' },
  { label: t('jobs.customSchedule'), value: 'custom' },
])
const scheduleWeekdays = computed(() => scheduleWeekdayOptions(locale.value))
const showScheduleTimeFields = computed(() => (
  scheduleFrequency.value === 'daily'
  || scheduleFrequency.value === 'weekly'
  || scheduleFrequency.value === 'monthly'
))

function generatedSchedule(): string {
  if (!scheduleFrequency.value) return ''
  return buildScheduleExpression({
    frequency: scheduleFrequency.value,
    hour: scheduleHour.value,
    minute: scheduleMinute.value,
    weekday: scheduleWeekday.value,
    monthDay: scheduleMonthDay.value,
  })
}

function syncGeneratedSchedule() {
  if (scheduleFrequency.value && scheduleFrequency.value !== 'custom') {
    formData.value.schedule = generatedSchedule()
  }
}

function handleScheduleFrequency(value: ScheduleFrequency | null) {
  const previous = scheduleFrequency.value
  scheduleFrequency.value = value
  if (!value) {
    // Clearing the frequency clears the expression: no silent leftover schedule.
    formData.value.schedule = ''
  } else if (value === 'custom') {
    if (previous !== 'custom') formData.value.schedule = ''
  } else {
    syncGeneratedSchedule()
  }
}

// The Cron field stays visible and authoritative. Typing an expression that a
// picked frequency would not produce switches the form to custom, so the next
// hour/minute change cannot silently overwrite what the operator typed.
function handleScheduleInput(value: string) {
  formData.value.schedule = value
  if (value === generatedSchedule()) return
  scheduleFrequency.value = value.trim() ? 'custom' : null
}

function setScheduleHour(value: number) { scheduleHour.value = value; syncGeneratedSchedule() }
function setScheduleMinute(value: number) { scheduleMinute.value = value; syncGeneratedSchedule() }
function setScheduleWeekday(value: number) { scheduleWeekday.value = value; syncGeneratedSchedule() }
function setScheduleMonthDay(value: number) { scheduleMonthDay.value = value; syncGeneratedSchedule() }

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function isDeliverTargetConfigured(key: string): boolean {
  const config = settingsStore.platforms[key] || {}
  switch (key) {
    case 'telegram':
    case 'discord':
    case 'slack':
      return hasText(config.token)
    case 'whatsapp':
      return config.enabled === true || config.enabled === 'true'
    case 'matrix':
      return hasText(config.token) && hasText(config.extra?.homeserver)
    case 'weixin':
      return hasText(config.token) && hasText(config.extra?.account_id)
    case 'wecom':
      return hasText(config.extra?.bot_id) && hasText(config.extra?.secret)
    case 'feishu':
      return hasText(config.extra?.app_id) && hasText(config.extra?.app_secret)
    case 'dingtalk':
      return (hasText(config.extra?.client_id) && hasText(config.extra?.client_secret))
        || (hasText(config.extra?.app_key) && hasText(config.extra?.client_secret))
    case 'qqbot':
      return hasText(config.extra?.app_id) && hasText(config.extra?.client_secret)
    default:
      return false
  }
}

const targetOptions = computed(() => {
  if (isScheduledExpert.value) return [{ label: 'Feishu', value: 'feishu' }]
  const options: Array<{ label: string; value: string; disabled?: boolean }> = [
    { label: t('jobs.origin'), value: 'origin' },
    { label: t('jobs.local'), value: 'local' },
  ]
  const channels = [
    { key: 'telegram', label: 'Telegram' },
    { key: 'discord', label: 'Discord' },
    { key: 'slack', label: 'Slack' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'matrix', label: 'Matrix' },
    { key: 'weixin', label: 'WeChat' },
    { key: 'wecom', label: 'WeCom' },
    { key: 'feishu', label: 'Feishu' },
    { key: 'dingtalk', label: 'DingTalk' },
    { key: 'qqbot', label: 'QQBot' },
  ]
  for (const ch of channels) {
    options.push({
      label: ch.label,
      value: ch.key,
      disabled: !isDeliverTargetConfigured(ch.key),
    })
  }
  return options
})

const originalJob = ref<Job | null>(null)

function buildSkillOptions(skills: SkillInfo[]): Array<{ label: string; value: string }> {
  const byName = new Map<string, SkillInfo>()
  for (const skill of skills) {
    if (skill.enabled === false) continue
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
    .map(skill => ({ label: skill.name, value: skill.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

async function loadSkillOptions() {
  skillsLoading.value = true
  try {
    const data = await fetchSkills()
    skillOptions.value = buildSkillOptions(data.categories.flatMap(category => category.skills || []))
  } catch {
    skillOptions.value = []
  } finally {
    skillsLoading.value = false
  }
}

onMounted(async () => {
  if (!isScheduledExpert.value && Object.keys(settingsStore.platforms || {}).length === 0) {
    await settingsStore.fetchSettings()
  }
  if (!isEdit.value) {
    if (profilesStore.profiles.length === 0) {
      void profilesStore.fetchProfiles()
    }
    void loadExpertOptions(executorAgentProfile.value)
  }
  if (!isEdit.value && appStore.modelGroups.length === 0) {
    void appStore.loadModels()
  }
  await loadSkillOptions()

  if (props.jobId) {
    try {
      const job = await getJob(props.jobId)
      originalJob.value = job
      const schedule = scheduleToEditableInput(job.schedule, job.schedule_display || '')
      const parsedSchedule = parseScheduleExpression(schedule)
      formData.value = {
        name: job.name,
        schedule,
        prompt: job.prompt,
        deliver: job.deliver || 'origin',
        skills: job.skills || (job.skill ? [job.skill] : []),
        repeat_times: jobRepeatToEditValue(job.repeat),
      }
      scheduleFrequency.value = parsedSchedule.frequency
      scheduleHour.value = parsedSchedule.hour
      scheduleMinute.value = parsedSchedule.minute
      scheduleWeekday.value = parsedSchedule.weekday
      scheduleMonthDay.value = parsedSchedule.monthDay
    } catch (e: any) {
      message.error(t('jobs.loadFailed') + ': ' + e.message)
    }
  }
})

async function handleSave() {
  if (!formData.value.name.trim()) {
    message.warning(t('jobs.nameRequired'))
    return
  }
  if (!formData.value.schedule.trim()) {
    message.warning(t('jobs.scheduleRequired'))
    return
  }

  loading.value = true
  try {
    if (isEdit.value) {
      if (!originalJob.value) {
        message.error(t('jobs.loadFailed'))
        return
      }
      const payload = buildJobUpdateRequest(originalJob.value, formData.value)
      if (Object.keys(payload).length === 0) {
        message.success(t('jobs.jobUpdated'))
        emit('saved')
        return
      }
      await jobsStore.updateJob(props.jobId!, payload)
      message.success(t('jobs.jobUpdated'))
    } else {
      const payload: CreateJobRequest = {
        name: formData.value.name,
        schedule: formData.value.schedule,
        prompt: formData.value.prompt,
        deliver: formData.value.deliver,
        skills: formData.value.skills,
        repeat: formData.value.repeat_times ?? undefined,
        ...(isScheduledExpert.value ? {
          expert_id: props.expertId,
          source_session_id: props.sourceSessionId,
          idempotency_key: props.idempotencyKey,
        } : {}),
      }
      const agentProfile = executorAgentProfile.value
      if (!agentProfile) {
        // The executor agent is REQUIRED — never fall through to an unscoped
        // create when the roster failed to load or the session has no profile.
        message.warning(t('jobs.executorRequired'))
        return
      }
      if (executorExpertId.value) {
        payload.expert_id = executorExpertId.value
      }
      // Per-job model: omitted entirely when following the profile default, so
      // the request stays byte-identical to the pre-feature one.
      if (modelValue.value) payload.model = modelValue.value
      // Compare against the active profile AT SUBMIT TIME: the sidebar may
      // have switched profiles while this modal was open, and the legacy
      // single-argument call inherits whatever is active NOW.
      if (agentProfile !== (getActiveProfileName() || '')) {
        await jobsStore.createJob(payload, { profile: agentProfile })
      } else {
        // Selected executor == active profile: legacy call, byte-identical.
        await jobsStore.createJob(payload)
      }
      message.success(t('jobs.jobCreated'))
    }
    emit('saved')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="isEdit ? t('jobs.editJob') : t('jobs.createJob')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem v-if="!isEdit" :label="t('jobs.executorAgent')" required data-testid="job-executor-agent">
        <NSelect
          v-model:value="executorAgentProfile"
          :options="agentOptions"
        />
      </NFormItem>

      <NFormItem v-if="!isEdit" :label="t('jobs.executorExpert')" data-testid="job-executor-expert">
        <NSelect
          v-model:value="executorExpertId"
          clearable
          :loading="expertsLoading"
          :options="expertOptions"
          :placeholder="t('jobs.executorExpertNone')"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.name')" required>
        <NInput
          v-model:value="formData.name"
          :placeholder="t('jobs.namePlaceholder')"
          maxlength="200"
          show-count
        />
      </NFormItem>

      <NFormItem :label="t('jobs.frequency')" data-testid="job-schedule-frequency" required>
        <NSelect
          :value="scheduleFrequency"
          :options="scheduleFrequencyOptions"
          :placeholder="t('jobs.selectPreset')"
          clearable
          @update:value="handleScheduleFrequency"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'hourly'" :label="t('scheduleBuilder.minute')" data-testid="job-schedule-minute" required>
        <NSelect
          :value="scheduleMinute"
          :options="SCHEDULE_MINUTE_OPTIONS"
          @update:value="setScheduleMinute"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'weekly'" :label="t('scheduleBuilder.weekday')" data-testid="job-schedule-weekday" required>
        <NSelect
          :value="scheduleWeekday"
          :options="scheduleWeekdays"
          @update:value="setScheduleWeekday"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'monthly'" :label="t('scheduleBuilder.monthDay')" data-testid="job-schedule-month-day" required>
        <NSelect
          :value="scheduleMonthDay"
          :options="SCHEDULE_MONTH_DAY_OPTIONS"
          @update:value="setScheduleMonthDay"
        />
      </NFormItem>

      <NFormItem v-if="showScheduleTimeFields" :label="t('scheduleBuilder.time')" required>
        <div class="schedule-time-fields">
          <NSelect
            data-testid="job-schedule-hour"
            :value="scheduleHour"
            :options="SCHEDULE_HOUR_OPTIONS"
            :aria-label="t('scheduleBuilder.hour')"
            @update:value="setScheduleHour"
          />
          <span>:</span>
          <NSelect
            data-testid="job-schedule-time-minute"
            :value="scheduleMinute"
            :options="SCHEDULE_MINUTE_OPTIONS"
            :aria-label="t('scheduleBuilder.minute')"
            @update:value="setScheduleMinute"
          />
        </div>
      </NFormItem>

      <NFormItem :label="t('jobs.schedule')" data-testid="job-schedule" required>
        <NInput
          :value="formData.schedule"
          :placeholder="t('jobs.schedulePlaceholder')"
          @update:value="handleScheduleInput"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.prompt')" required>
        <NInput
          v-model:value="formData.prompt"
          type="textarea"
          :placeholder="t('jobs.promptPlaceholder')"
          :rows="4"
          maxlength="5000"
          show-count
        />
      </NFormItem>

      <NFormItem :label="t('jobs.skills')" data-testid="job-skills">
        <NSelect
          v-model:value="formData.skills"
          multiple
          filterable
          clearable
          :loading="skillsLoading"
          :options="skillOptions"
          :placeholder="t('jobs.skillsPlaceholder')"
        />
      </NFormItem>

      <NFormItem v-if="!isEdit" :label="t('jobs.model')" data-testid="job-model">
        <NSelect
          v-model:value="modelValue"
          filterable
          :options="modelOptions"
          :placeholder="t('jobs.modelFollowDefault')"
        />
      </NFormItem>

      <!-- Read-only in edit: the update API whitelist drops `model`, so offering
           an editable field here would silently discard the change. -->
      <NFormItem v-if="isEdit && originalJob?.model" :label="t('jobs.model')" data-testid="job-model-readonly">
        <span>{{ originalJob.model }}</span>
      </NFormItem>

      <NFormItem :label="t('jobs.deliverTarget')" data-testid="job-deliver">
        <NSelect
          v-model:value="formData.deliver"
          :options="targetOptions"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.repeatCount')">
        <NInputNumber
          v-model:value="formData.repeat_times"
          :min="1"
          :placeholder="t('jobs.repeatPlaceholder')"
          clearable
          style="width: 100%"
        />
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ isEdit ? t('common.update') : t('common.create') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.schedule-time-fields {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  width: 100%;
}
</style>
