<script setup lang="ts">
/**
 * 新建自动化 sheet, rebuilt to the prototype's NewAutoDrawer (proto-home.html
 * 23373): 620px Keep sheet — 任务名称 → 触发时间 (间隔触发 / 每天 / 每周 /
 * 每月, with TimePicker / MonthDayPicker / weekday dots) → beam prompt box
 * (slash-attach skills as pills + toolrow) → Divider → 取消 / 创建.
 *
 * The trigger UI maps to the backend's cron `schedule` both ways: create
 * builds a cron string, edit parses the stored cron back into the widgets.
 * A schedule that doesn't fit the four trigger shapes falls back to a raw
 * expression field so nothing becomes uneditable.
 *
 * Deliver target and repeat count have no prototype counterpart (the mock
 * drawer's toolrow holds usage/mode chips instead) — they stay functional
 * here as ghost pills in the same toolrow slot.
 */
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import {
  buildJobUpdateRequest,
  getJob,
  jobRepeatToEditValue,
  scheduleToEditableInput,
} from '@/api/hermes/jobs'
import type { CreateJobRequest, Job } from '@/api/hermes/jobs'
import { fetchSkills } from '@/api/hermes/skills'
import { uploadFiles } from '@/api/hermes/files'
import { useNet } from '@/composables/useNet'
import type { SkillInfo } from '@/api/hermes/skills'
import KpIcon from '@/components/kippies/KpIcon.vue'
import { useAction } from '@/components/kippies/useAction'
import ComposerBox from '@/components/hermes/chat/ComposerBox.vue'
import { fetchExperts } from '@/api/hermes/experts'
import { getActiveProfileName } from '@/api/client'
import { agentDisplayName, groupAgents } from '@/utils/hermes/agent-identity'
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
// Where the job runs. Same single source of truth the composer's scope pill
// reads, so both say "offline" at the same moment.
const { online: netOnline } = useNet()
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
  const specs: string[] = []
  const seen = new Set<string>()
  for (const group of modelGroupsForExecutor.value) {
    for (const model of group.models) {
      // A disabled model would fail (or silently fall back) on a scheduled run,
      // so it is left out rather than offered greyed-out.
      if (group.model_meta?.[model]?.disabled) continue
      // Catalog ids are sometimes ALREADY provider-qualified (e.g.
      // "custom:litellm-sre/tencent-sonnet-4-6"). Prefixing again would send a
      // doubled spec that resolves to no model at all.
      const spec = model.startsWith(`${group.provider}/`) ? model : `${group.provider}/${model}`
      if (!seen.has(spec)) {
        seen.add(spec)
        specs.push(spec)
      }
    }
  }
  return specs
})

// The chosen model belongs to the executor's catalog: switching executors must
// not keep a selection the new executor cannot run.
watch(executorAgentProfile, () => {
  if (jobModel.value && !modelOptions.value.includes(jobModel.value)) jobModel.value = null
})

const [saveState, runSave] = useAction()
/** Pending is the only thing that should block closing or re-pressing. */
const loading = computed(() => saveState.value === 'pending')
/**
 * Loading an existing job's fields failed. This one cannot go on a button —
 * nobody pressed anything, the dialog just opened — and it must not be silent
 * either: the fields would sit empty and saving would look like a wipe. So it
 * is a resident line at the top of the body.
 */
const loadError = ref('')
/**
 * Upload failure. Success needs no message — the workspace paths appear in the
 * prompt field, right where you are looking — but a failure would otherwise be
 * invisible, because the "+" menu it was started from has already closed.
 */
const uploadError = ref('')
const isEdit = computed(() => !!props.jobId)
const isScheduledExpert = computed(() => !isEdit.value && !!props.sourceSessionId)

// ---- form state -----------------------------------------------------------
const name = ref('')
const prompt = ref('')
const attachments = ref<string[]>([])
const deliver = ref('origin')
const repeatTimes = ref<number | null>(null)

type TriggerType = 'interval' | 'daily' | 'weekly' | 'monthly'
const triggerType = ref<TriggerType>('interval')
const every = ref('1')
const unit = ref<'minutes' | 'hours' | 'days'>('hours')
const weekday = ref(0) // Monday-first index 0..6
const monthDay = ref('1')
const time = ref('')
// Non-null = the stored schedule didn't fit the trigger widgets; edit it raw.
const rawSchedule = ref<string | null>(null)

// ---- popup state ----------------------------------------------------------
const timeOpen = ref(false)
const monthOpen = ref(false)
const addOpen = ref(false)
// Level-2 flyout of the ＋ menu, mirroring the composer's AddMenu (hover opens,
// with a 160ms safe delay so crossing the gap does not unmount it).
const addSub = ref<null | 'skill'>(null)
let addSubCloseT: ReturnType<typeof setTimeout> | null = null
const deliverOpen = ref(false)
const agentOpen = ref(false)
const modelOpen = ref(false)
const expertOpen = ref(false)

// ---- per-job model (prototype ModePicker slot) ----------------------------
// null = Auto: the job runs on the profile's default model. A picked model is
// persisted through UpdateJobRequest.model — create does not accept it, so a
// new job gets a follow-up update right after creation.
const jobModel = ref<string | null>(null)

// ---- context bar: 执行 Agent (prototype AgentPill, now bound to the job's
// executor). Picking here does NOT switch the sidebar's profile: the executor
// travels with THIS job's request (X-Hermes-Profile), so a job created for
// another agent must not drag the whole app over to it.
const executorProfileRow = computed(() =>
  profilesStore.profiles.find(p => p.name === executorAgentProfile.value) || null,
)
const executorAgentLabel = computed(() => {
  const row = executorProfileRow.value
  return row
    ? agentDisplayName(row, t('agentsHub.unnamedGroup'))
    : executorAgentProfile.value || t('jobs.pickAgent')
})

const executorExpertLabel = computed(() => {
  const picked = expertOptions.value.find(option => option.value === executorExpertId.value)
  return picked?.label || t('jobs.executorExpert')
})

function pickProfile(name: string) {
  agentOpen.value = false
  if (name === executorAgentProfile.value) return
  executorAgentProfile.value = name
  // Each agent owns a different expert set, so the expert picker has to be
  // refetched — and any previously picked expert dropped.
  void loadExpertOptions(name)
}

const skillsLoading = ref(false)
const skillOptions = ref<Array<{ label: string; value: string }>>([])
const originalJob = ref<Job | null>(null)

// ---- trigger helpers ------------------------------------------------------
const triggerOptions = computed(() => [
  { value: 'interval', label: t('jobs.triggerInterval') },
  { value: 'daily', label: t('jobs.triggerDaily') },
  { value: 'weekly', label: t('jobs.triggerWeekly') },
  { value: 'monthly', label: t('jobs.triggerMonthly') },
])

const unitOptions = computed(() => [
  { value: 'minutes', label: t('jobs.unitMinutes') },
  { value: 'hours', label: t('jobs.unitHours') },
  { value: 'days', label: t('jobs.unitDays') },
])

// Prototype circles show 一…日; Intl gives the localized narrow names for
// every locale without 7 keys × 10 languages. 2024-01-01 is a Monday.
const weekdayLabels = computed(() => {
  try {
    const fmt = new Intl.DateTimeFormat(locale?.value || 'zh-CN', { weekday: 'narrow' })
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i))))
  } catch {
    return ['一', '二', '三', '四', '五', '六', '日']
  }
})

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
const timeParts = computed(() => (time.value || '00:00').split(':'))

function pickTimePart(part: 'h' | 'm', v: string) {
  const [h, m] = timeParts.value
  time.value = part === 'h' ? `${v}:${m}` : `${h}:${v}`
}

function onEveryInput(e: Event) {
  every.value = (e.target as HTMLInputElement).value.replace(/\D/g, '')
}

// Prototype UsagePill slot: live token estimate of the prompt this
// automation will send on every run (CJK ≈ 1 token/char, latin ≈ 4 chars).
const promptTokens = computed(() => {
  let cjk = 0
  let other = 0
  for (const ch of prompt.value) {
    if (/[㐀-鿿豈-﫿]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
})

function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
}

const valid = computed(() => {
  if (!name.value.trim() || !prompt.value.trim()) return false
  if (rawSchedule.value !== null) return !!rawSchedule.value.trim()
  return triggerType.value === 'interval' || !!time.value
})

function buildSchedule(): string {
  if (rawSchedule.value !== null) return rawSchedule.value.trim()
  const [h, m] = time.value.split(':')
  const H = String(Number(h || 0))
  const M = String(Number(m || 0))
  if (triggerType.value === 'interval') {
    const n = Math.max(1, parseInt(every.value, 10) || 1)
    if (unit.value === 'minutes') return n === 1 ? '* * * * *' : `*/${n} * * * *`
    if (unit.value === 'hours') return n === 1 ? '0 * * * *' : `0 */${n} * * *`
    return n === 1 ? '0 0 * * *' : `0 0 */${n} * *`
  }
  if (triggerType.value === 'daily') return `${M} ${H} * * *`
  if (triggerType.value === 'weekly') return `${M} ${H} * * ${(weekday.value + 1) % 7}`
  return `${M} ${H} ${monthDay.value} * *`
}

// Parse a stored schedule back into the trigger widgets; false = raw mode.
function parseSchedule(input: string): boolean {
  const s = input.trim()
  const pad = (v: string) => String(v).padStart(2, '0')
  let m = s.match(/^every (\d+)(m|h|d)$/i)
  if (m) {
    triggerType.value = 'interval'
    every.value = m[1]
    unit.value = m[2].toLowerCase() === 'm' ? 'minutes' : m[2].toLowerCase() === 'h' ? 'hours' : 'days'
    return true
  }
  if (s === '* * * * *' || (m = s.match(/^\*\/(\d+) \* \* \* \*$/))) {
    triggerType.value = 'interval'
    every.value = m ? m[1] : '1'
    unit.value = 'minutes'
    return true
  }
  if (s === '0 * * * *' || (m = s.match(/^0 \*\/(\d+) \* \* \*$/))) {
    triggerType.value = 'interval'
    every.value = m ? m[1] : '1'
    unit.value = 'hours'
    return true
  }
  if (s === '0 0 * * *' || (m = s.match(/^0 0 \*\/(\d+) \* \*$/))) {
    triggerType.value = 'interval'
    every.value = m ? m[1] : '1'
    unit.value = 'days'
    return true
  }
  if ((m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/))) {
    triggerType.value = 'daily'
    time.value = `${pad(m[2])}:${pad(m[1])}`
    return true
  }
  if ((m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/))) {
    triggerType.value = 'weekly'
    time.value = `${pad(m[2])}:${pad(m[1])}`
    weekday.value = (Number(m[3]) + 6) % 7
    return true
  }
  if ((m = s.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/))) {
    triggerType.value = 'monthly'
    time.value = `${pad(m[2])}:${pad(m[1])}`
    monthDay.value = String(Number(m[3]))
    return true
  }
  return false
}

// Prototype slash tile: a solid hue with the item's first character in white.
// Same name hash the skills wall uses, so one skill keeps one colour wherever
// it shows up.
const SLASH_TILE_HUES = ['var(--hue-purple)', 'var(--hue-blue)', 'var(--hue-cyan)']
function slashTileHue(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return SLASH_TILE_HUES[h % SLASH_TILE_HUES.length]
}
function slashTileMark(name: string): string {
  return (name.trim()[0] || '?').toUpperCase()
}

// ---- prompt box: slash panel + skill pills --------------------------------
const slashOpen = computed(() => prompt.value.startsWith('/'))
const slashQuery = computed(() => prompt.value.slice(1).toLowerCase())
const slashMatches = computed(() =>
  skillOptions.value.filter(s => !slashQuery.value || s.label.toLowerCase().includes(slashQuery.value)),
)
const slashMaxHeight = ref(360)
// The box is a component now, so the element for measuring comes off $el.
const beamRef = ref<InstanceType<typeof ComposerBox> | null>(null)

function onPromptInput(e: Event) {
  prompt.value = (e.target as HTMLTextAreaElement).value
  const beamEl = beamRef.value?.$el as HTMLElement | undefined
  if (prompt.value.startsWith('/') && beamEl) {
    // Prototype SlashPanel clamp: max(160, min(360, top - 24)).
    const rect = beamEl.getBoundingClientRect()
    slashMaxHeight.value = Math.max(160, Math.min(360, rect.top - 24))
  }
}

function onPromptKeydown(e: KeyboardEvent) {
  // Prototype swallows plain Enter (send is hidden in the drawer).
  if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
  if (e.key === 'Escape' && slashOpen.value) {
    e.stopPropagation()
    prompt.value = ''
  }
}

function attachSkill(skill: string) {
  if (!attachments.value.includes(skill)) attachments.value = [...attachments.value, skill]
}

function pickSlash(skill: string) {
  attachSkill(skill)
  prompt.value = ''
}

function removeAttachment(i: number) {
  attachments.value = attachments.value.filter((_, idx) => idx !== i)
}

// ---- ＋ menu (composer AddMenu anatomy) -----------------------------------
function keepAddSub(id: 'skill' | null) {
  if (addSubCloseT) clearTimeout(addSubCloseT)
  if (id) addSub.value = id
}

function laterCloseAddSub() {
  if (addSubCloseT) clearTimeout(addSubCloseT)
  addSubCloseT = setTimeout(() => { addSub.value = null }, 160)
}

function closeAddMenu() {
  addOpen.value = false
  addSub.value = null
  if (addSubCloseT) clearTimeout(addSubCloseT)
}

const promptFileInputRef = ref<HTMLInputElement | null>(null)
const uploadingFile = ref(false)

function openFilePicker() {
  promptFileInputRef.value?.click()
}

/**
 * A job carries no file field — `prompt` / `skills` / `deliver` is all it has.
 * So an attached file is uploaded to the agent's workspace now and its
 * `/workspace/...` path is written into the prompt, which is the path shape the
 * run broker hands to the tools. Anything else would be a control that looks
 * like it attaches something and does not.
 */
async function onPromptFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  closeAddMenu()
  if (!files.length || uploadingFile.value) return
  uploadingFile.value = true
  try {
    const uploaded = await uploadFiles('', files)
    const refs = uploaded.map(f => `/workspace/${f.path.replace(/^\/+/, '')}`)
    prompt.value = prompt.value ? `${prompt.value.replace(/\s*$/, '')}\n${refs.join('\n')}` : refs.join('\n')
    // No success message: the paths just appeared in the field being edited.
    uploadError.value = ''
  } catch (err: any) {
    uploadError.value = err?.message || t('files.uploadFailed')
  } finally {
    uploadingFile.value = false
  }
}

// ---- deliver targets (functional superset, no prototype counterpart) ------
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

// Scope chip (prototype 云端/本地): deliver 'origin' reads as 云端 (results
// go back to the cloud channel), 'local' as 本地; picked channels show their
// own name. The channel rows live inside the same popover as a superset.
const deliverLabel = computed(() => {
  if (deliver.value === 'origin') return t('jobs.scopeCloud')
  return targetOptions.value.find(o => o.value === deliver.value)?.label || deliver.value
})

const deliverIcon = computed(() => {
  if (deliver.value === 'origin') return 'line_weather_cloudy'
  if (deliver.value === 'local') return 'line_tv'
  return 'full_send'
})

function onRepeatInput(e: Event) {
  const v = (e.target as HTMLInputElement).value.replace(/\D/g, '')
  repeatTimes.value = v ? Math.max(1, parseInt(v, 10)) : null
}

// ---- data loading ---------------------------------------------------------
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

// Skills are per-profile, so the list has to follow the agent pill. Loading
// them once on mount left the previous agent's skills on screen after a
// switch — and the slash panel attaches from this same list.
async function loadSkillOptions() {
  const profile = profilesStore.activeProfileName || undefined
  skillsLoading.value = true
  try {
    const data = await fetchSkills(profile)
    if (profilesStore.activeProfileName !== (profile || '')) return
    skillOptions.value = buildSkillOptions(data.categories.flatMap(category => category.skills || []))
  } catch {
    skillOptions.value = []
  } finally {
    skillsLoading.value = false
  }
}

watch(() => profilesStore.activeProfileName, () => { void loadSkillOptions() })

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  if (Object.keys(settingsStore.platforms || {}).length === 0) {
    await settingsStore.fetchSettings()
  }
  if ((profilesStore.profiles?.length ?? 0) === 0) {
    try { await profilesStore.fetchProfiles() } catch { /* pill falls back to the stored name */ }
  }
  try { await appStore.loadModels?.() } catch { /* model chip just offers Auto */ }
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
      loadError.value = ''
      const job = await getJob(props.jobId)
      originalJob.value = job
      name.value = job.name
      prompt.value = job.prompt
      deliver.value = job.deliver || 'origin'
      attachments.value = job.skills || (job.skill ? [job.skill] : [])
      repeatTimes.value = jobRepeatToEditValue(job.repeat)
      jobModel.value = job.model || null
      const schedule = scheduleToEditableInput(job.schedule, job.schedule_display || '')
      if (!parseSchedule(schedule)) rawSchedule.value = schedule
    } catch (e: any) {
      loadError.value = t('jobs.loadFailed') + ': ' + e.message
    }
  }
})

onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') handleClose()
}

// ---- submit ---------------------------------------------------------------
/**
 * Success closes this dialog, so there is no button left to show `ok` on — the
 * dialog going away is the answer, which is why this runs with `noOk`. Failure
 * stays on the create button, where the press was.
 */
function handleSave() {
  if (!valid.value) return
  runSave({ run: doSave, noOk: true })
}

async function doSave() {
  {
    const form = {
      name: name.value.trim(),
      schedule: buildSchedule(),
      prompt: prompt.value.trim(),
      deliver: deliver.value,
      skills: attachments.value,
      repeat_times: repeatTimes.value,
    }
    if (isEdit.value) {
      // Nothing to update against — throwing puts the button in `fail` rather
      // than silently doing nothing.
      if (!originalJob.value) throw new Error(t('jobs.loadFailed'))
      const payload = buildJobUpdateRequest(originalJob.value, form)
      if ((jobModel.value || null) !== (originalJob.value.model || null)) {
        payload.model = jobModel.value ?? ''
      }
      // Nothing changed: closing is the whole answer, so say nothing.
      if (Object.keys(payload).length === 0) {
        emit('saved')
        return
      }
      await jobsStore.updateJob(props.jobId!, payload)
    } else {
      const payload: CreateJobRequest = {
        name: form.name,
        schedule: form.schedule,
        prompt: form.prompt,
        deliver: form.deliver,
        skills: form.skills,
        repeat: form.repeat_times ?? undefined,
        // 会话内「定时执行」: carry the source session's expert binding and the
        // idempotency key, which is what makes a double press create ONE job.
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
        // Throwing puts the failure on the button that was pressed.
        throw new Error(t('jobs.executorRequired'))
      }
      // An explicitly picked expert wins over a session-bound one.
      if (executorExpertId.value) payload.expert_id = executorExpertId.value
      // Per-job model: omitted entirely when following the profile default, so
      // the request stays byte-identical to the pre-feature one.
      if (jobModel.value) payload.model = jobModel.value
      // Compare against the active profile AT SUBMIT TIME: the sidebar may have
      // switched profiles while this sheet was open, and the single-argument
      // call inherits whatever is active NOW.
      if (agentProfile !== (getActiveProfileName() || '')) {
        await jobsStore.createJob(payload, { profile: agentProfile })
      } else {
        // Selected executor == active profile: legacy call, byte-identical.
        await jobsStore.createJob(payload)
      }
    }
    emit('saved')
  }
}

function handleClose() {
  if (loading.value) return
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="af-overlay">
      <div class="af-scrim" @click="handleClose" />
      <div class="af-sheet" role="dialog" aria-modal="true">
        <div class="af-head">
          <div class="t-h3 af-head__title">{{ isEdit ? t('jobs.editJob') : t('jobs.createTitle') }}</div>
          <button type="button" class="af-close" :title="t('common.cancel')" @click="handleClose">
            <KpIcon name="line_close" :size="17" />
          </button>
        </div>

        <div class="af-body">
          <!-- Resident, not a toast: nobody pressed anything here, and leaving
               it unsaid would present empty fields as if they were the job. -->
          <p v-if="loadError" class="af-note af-note--fail" data-testid="af-load-error">
            {{ loadError }}
          </p>
          <!-- 任务名称 -->
          <div>
            <div class="t-sub-medium af-label">{{ t('jobs.taskName') }}</div>
            <input
              class="af-field af-field--full"
              data-testid="af-name"
              :value="name"
              :placeholder="t('jobs.nameInputPlaceholder')"
              maxlength="200"
              @input="name = ($event.target as HTMLInputElement).value"
            />
          </div>

          <!-- 触发时间 -->
          <div>
            <div class="t-sub-medium af-label">{{ t('jobs.triggerTime') }}</div>

            <!-- Stored schedule outside the four trigger shapes: raw cron. -->
            <input
              v-if="rawSchedule !== null"
              class="af-field af-field--full"
              data-testid="af-raw-schedule"
              :value="rawSchedule"
              :placeholder="t('jobs.schedulePlaceholder')"
              @input="rawSchedule = ($event.target as HTMLInputElement).value"
            />

            <template v-else-if="triggerType === 'interval'">
              <div class="af-row">
                <select
                  class="af-field af-select"
                  data-testid="af-trigger-type"
                  :value="triggerType"
                  @change="triggerType = ($event.target as HTMLSelectElement).value as TriggerType"
                >
                  <option v-for="o in triggerOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
                <div class="af-every">
                  <span class="af-every__prefix">{{ t('jobs.every') }}</span>
                  <input
                    class="af-every__input"
                    data-testid="af-every"
                    :value="every"
                    @input="onEveryInput"
                  />
                </div>
                <select
                  class="af-field af-select"
                  data-testid="af-unit"
                  :value="unit"
                  @change="unit = ($event.target as HTMLSelectElement).value as 'minutes' | 'hours' | 'days'"
                >
                  <option v-for="o in unitOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
            </template>

            <template v-else>
              <div class="af-row">
                <select
                  class="af-field af-select"
                  data-testid="af-trigger-type"
                  :value="triggerType"
                  @change="triggerType = ($event.target as HTMLSelectElement).value as TriggerType"
                >
                  <option v-for="o in triggerOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>

                <!-- 每月: day-of-month grid picker -->
                <div v-if="triggerType === 'monthly'" class="af-pick">
                  <div class="af-field af-pick__trigger" data-testid="af-month-day" @click="monthOpen = !monthOpen">
                    <span>{{ t('jobs.monthDayFmt', { day: monthDay }) }}</span>
                    <KpIcon
                      name="line_arrow_right"
                      :size="11"
                      class="af-pick__caret" color="var(--fg-disabled)"
                      :style="{ transform: monthOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }"
                    />
                  </div>
                  <template v-if="monthOpen">
                    <div class="af-backdrop" @click="monthOpen = false" />
                    <div class="af-month-pop">
                      <span
                        v-for="d in MONTH_DAYS"
                        :key="d"
                        class="af-month-day"
                        :class="{ 'is-on': String(d) === String(monthDay) }"
                        @click="monthDay = String(d); monthOpen = false"
                      >{{ d }}</span>
                    </div>
                  </template>
                </div>

                <!-- time picker -->
                <div class="af-pick" :style="{ flex: triggerType === 'monthly' ? 1 : 2 }">
                  <div class="af-field af-pick__trigger" data-testid="af-time" @click="timeOpen = !timeOpen">
                    <span :class="{ 'af-pick__placeholder': !time }">{{ time || t('jobs.pickTime') }}</span>
                    <KpIcon name="line_time" :size="14" class="af-pick__caret" color="var(--fg-disabled)" />
                  </div>
                  <template v-if="timeOpen">
                    <div class="af-backdrop" @click="timeOpen = false" />
                    <div class="af-time-pop">
                      <div class="af-time-col">
                        <div
                          v-for="v in HOURS"
                          :key="v"
                          class="af-time-item"
                          :class="{ 'is-on': v === timeParts[0] }"
                          @click="pickTimePart('h', v)"
                        >{{ v }}</div>
                      </div>
                      <div class="af-time-col af-time-col--divided">
                        <div
                          v-for="v in MINS"
                          :key="v"
                          class="af-time-item"
                          :class="{ 'is-on': v === timeParts[1] }"
                          @click="pickTimePart('m', v)"
                        >{{ v }}</div>
                      </div>
                    </div>
                  </template>
                </div>
              </div>

              <!-- 每周: weekday circles -->
              <div v-if="triggerType === 'weekly'" class="af-weekdays">
                <span
                  v-for="(w, i) in weekdayLabels"
                  :key="i"
                  class="af-weekday"
                  :class="{ 'is-on': weekday === i }"
                  :data-testid="`af-weekday-${i}`"
                  @click="weekday = i"
                >{{ w }}</span>
              </div>
            </template>
          </div>

          <!-- deliver target: a job setting (where the RESULT goes), so it
               belongs with the other fields rather than inside the prompt box.
               It used to sit in the box's scope-chip slot, where it read as
               "where this runs" — which is what the pill down there now says. -->
          <div>
            <div class="t-sub-medium af-label">{{ t('jobs.deliverTarget') }}</div>
            <div class="af-pick">
              <div
                class="af-field af-pick__trigger"
                data-testid="af-deliver"
                @click="deliverOpen = !deliverOpen"
              >
                <span class="af-deliver-value">
                  <KpIcon :name="deliverIcon" :size="14" color="var(--fg-aux)" />
                  {{ deliverLabel }}
                </span>
                <KpIcon
                  name="line_arrow_right"
                  :size="11"
                  class="af-pick__caret" color="var(--fg-disabled)"
                  :style="{ transform: deliverOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }"
                />
              </div>
              <template v-if="deliverOpen">
                <div class="af-backdrop" @click="deliverOpen = false" />
                <div class="af-menu af-menu--deliver">
                  <button
                    type="button"
                    class="af-drop-row"
                    data-testid="af-deliver-origin"
                    @click="deliver = 'origin'; deliverOpen = false"
                  >
                    <KpIcon name="line_weather_cloudy" :size="16" class="af-menu__icon" color="var(--fg-aux)" />
                    <span class="af-drop-row__name">{{ t('jobs.scopeCloud') }}</span>
                    <KpIcon
                      v-if="deliver === 'origin'"
                      name="line_check"
                      :size="14"
                      class="af-drop-row__check" color="var(--keep-green)"
                    />
                  </button>
                  <button
                    type="button"
                    class="af-drop-row"
                    data-testid="af-deliver-local"
                    @click="deliver = 'local'; deliverOpen = false"
                  >
                    <KpIcon name="line_tv" :size="16" class="af-menu__icon" color="var(--fg-aux)" />
                    <span class="af-drop-row__name">{{ t('jobs.local') }}</span>
                    <KpIcon
                      v-if="deliver === 'local'"
                      name="line_check"
                      :size="14"
                      class="af-drop-row__check" color="var(--keep-green)"
                    />
                  </button>
                  <div class="af-menu__rule" />
                  <button
                    v-for="o in targetOptions.filter(x => x.value !== 'origin' && x.value !== 'local')"
                    :key="o.value"
                    type="button"
                    class="af-drop-row"
                    :disabled="o.disabled"
                    :data-testid="`af-deliver-${o.value}`"
                    @click="deliver = o.value; deliverOpen = false"
                  >
                    <KpIcon name="line_comment" :size="16" class="af-menu__icon" color="var(--fg-aux)" />
                    <span class="af-drop-row__name">{{ o.label }}</span>
                    <KpIcon
                      v-if="deliver === o.value"
                      name="line_check"
                      :size="14"
                      class="af-drop-row__check" color="var(--keep-green)"
                    />
                  </button>
                </div>
              </template>
            </div>
          </div>

          <!-- prompt -->
          <div>
            <div class="t-sub-medium af-label">{{ t('jobs.promptQuestion') }}</div>
            <!-- The same ComposerBox the chat composers use: frame, section
                 order and insets all come from there, so this dialog cannot
                 drift away from 新建任务 again. -->
            <ComposerBox ref="beamRef">

              <!-- slash panel -->
              <div v-if="slashOpen" class="af-slash" :style="{ maxHeight: `${slashMaxHeight}px` }">
                <div v-if="slashMatches.length === 0" class="t-sub af-slash__empty">
                  {{ t('chat.slashNoMatch') }}
                </div>
                <template v-else>
                  <div class="t-meta af-slash__group">{{ t('jobs.skills') }}</div>
                  <div
                    v-for="s in slashMatches"
                    :key="s.value"
                    class="af-slash__row"
                    :data-testid="`af-slash-${s.value}`"
                    @click="pickSlash(s.value)"
                  >
                    <span class="af-slash__tile" :style="{ background: slashTileHue(s.label) }">
                      {{ slashTileMark(s.label) }}
                    </span>
                    <div class="af-slash__text">
                      <span class="t-sub-medium">{{ s.label }}</span>
                    </div>
                  </div>
                </template>
              </div>

              <div class="input-wrapper af-beam-field">
                  <span
                    v-for="(a, i) in attachments"
                    :key="a + i"
                    class="af-attach-pill"
                    :data-testid="`af-attach-${a}`"
                  >
                    <span class="af-attach-pill__x" @click="removeAttachment(i)">
                      <KpIcon name="line_close" :size="12" />
                    </span>
                    {{ a }}
                  </span>
                  <textarea
                    class="af-textarea"
                    data-testid="af-prompt"
                    :value="prompt"
                    :placeholder="attachments.length ? t('jobs.promptAttachedPlaceholder') : t('jobs.promptBoxPlaceholder')"
                    :style="{ height: attachments.length ? '28px' : '120px' }"
                    maxlength="5000"
                    @input="onPromptInput"
                    @keydown="onPromptKeydown"
                  />
                </div>

              <div class="input-top-bar">
                  <!-- attach skill (prototype AddMenu slot) -->
                  <div class="af-pop-wrap">
                    <button
                      type="button"
                      class="af-add"
                      :class="{ 'is-open': addOpen }"
                      data-testid="af-add"
                      :title="t('chat.addMenu')"
                      @click="addOpen ? closeAddMenu() : (addOpen = true)"
                    >
                      <KpIcon name="full_add" :size="18" />
                    </button>
                    <input
                      ref="promptFileInputRef"
                      type="file"
                      multiple
                      class="af-file-input"
                      @change="onPromptFilePicked"
                    />
                    <template v-if="addOpen">
                      <div class="af-backdrop" @click="closeAddMenu()" />
                      <!-- Level 1, same rows as the composer's AddMenu: a file,
                           or fan out to the skills this agent has. -->
                      <div
                        class="af-menu af-menu--up-left"
                        @mouseenter="keepAddSub(null)"
                        @mouseleave="laterCloseAddSub"
                      >
                        <div
                          class="af-menu-row"
                          data-testid="af-add-file"
                          @click="openFilePicker()"
                        >
                          <KpIcon name="line_link" :size="16" class="af-menu__icon" color="var(--fg-aux)" />
                          <span class="t-sub af-menu__name">{{ t('chat.attachFiles') }}</span>
                        </div>
                        <div
                          class="af-menu-row"
                          :class="{ 'is-active': addSub === 'skill' }"
                          data-testid="af-add-skills"
                          @mouseenter="keepAddSub('skill')"
                          @click="keepAddSub('skill')"
                        >
                          <KpIcon name="line_menu" :size="16" class="af-menu__icon" color="var(--fg-aux)" />
                          <span class="t-sub af-menu__name">{{ t('sidebar.skills') }}</span>
                          <KpIcon name="line_arrow_right" :size="12" class="af-menu__caret" color="var(--fg-disabled)" />
                        </div>
                      </div>
                      <!-- Level 2 abuts level 1 on the right (the ＋ sits at the
                           row's left edge, so there is no room on the left). -->
                      <div
                        v-if="addSub === 'skill'"
                        class="af-menu af-menu--up-left af-menu--sub"
                        @mouseenter="keepAddSub('skill')"
                        @mouseleave="laterCloseAddSub"
                      >
                        <div v-if="skillOptions.length === 0" class="t-sub af-slash__empty">{{ t('chat.slashNoMatch') }}</div>
                        <div
                          v-for="s in skillOptions"
                          :key="s.value"
                          class="af-menu-row"
                          :data-testid="`af-skill-${s.value}`"
                          @click="attachSkill(s.value); closeAddMenu()"
                        >
                          <KpIcon name="line_menu" :size="16" class="af-menu__icon" color="var(--fg-aux)" />
                          <span class="t-sub af-menu__name">{{ s.label }}</span>
                        </div>
                      </div>
                    </template>
                  </div>

                <div class="tool-row-spacer" />

                  <!-- prompt token estimate (prototype UsagePill slot) -->
                  <span class="af-usage" :title="t('jobs.promptTokens')">
                    <KpIcon name="line_chart" :size="14" color="var(--fg-aux)" />
                    <span class="af-usage__num">{{ fmtTok(promptTokens) }}</span>
                  </span>

                  <div class="af-pop-wrap">
                    <!-- Reads exactly like the composer's model pill: Keep
                         spark glyph (never a Unicode character — the handoff forbids
                         substituting characters for icons), the model name, and
                         the same caret. No 推理强度 suffix: the strength follows
                         the model's own config and is not a user choice. -->
                    <button type="button" class="af-chip" data-testid="af-model" @click="modelOpen = !modelOpen">
                      <KpIcon name="full_star_ai" :size="14" class="af-chip__spark" color="var(--hue-blue)" />
                      <span class="af-chip__label">{{ jobModel || t('jobs.modelFollowDefault') }}</span>
                      <KpIcon name="line_down" :size="10" class="af-chip__caret" color="var(--fg-disabled)" />
                    </button>
                    <template v-if="modelOpen">
                      <div class="af-backdrop" @click="modelOpen = false" />
                      <div class="af-menu af-menu--up-right af-menu--model">
                        <button
                          type="button"
                          class="af-drop-row"
                          data-testid="af-model-auto"
                          @click="jobModel = null; modelOpen = false"
                        >
                          <span class="af-drop-row__name">{{ t('jobs.modelFollowDefault') }}</span>
                          <KpIcon v-if="!jobModel" name="line_check" :size="14" class="af-drop-row__check" color="var(--keep-green)" />
                        </button>
                        <button
                          v-for="m in modelOptions"
                          :key="m"
                          type="button"
                          class="af-drop-row"
                          :data-testid="`af-model-${m}`"
                          @click="jobModel = m; modelOpen = false"
                        >
                          <span class="af-drop-row__name">{{ m }}</span>
                          <KpIcon v-if="jobModel === m" name="line_check" :size="14" class="af-drop-row__check" color="var(--keep-green)" />
                        </button>
                        <!-- repeat count rides along in the config popover -->
                        <div class="af-menu__rule" />
                        <div class="af-menu__label t-meta">{{ t('jobs.repeatCount') }}</div>
                        <input
                          class="af-field af-field--full af-field--s"
                          data-testid="af-repeat-input"
                          :value="repeatTimes ?? ''"
                          :placeholder="t('jobs.repeatPlaceholder')"
                          @input="onRepeatInput"
                        />
                      </div>
                    </template>
                  </div>
                </div>

              <!-- Scope row (prototype ContextBar): agent pill + deliver chip. -->
              <div class="input-pillbar af-ctxbar">
                  <div class="af-pop-wrap">
                    <button
                      type="button"
                      class="af-agent"
                      :class="{ 'is-open': agentOpen }"
                      data-testid="af-agent"
                      @click="agentOpen = !agentOpen"
                    >
                      <ProfileAvatar :name="executorProfileRow?.name || executorAgentProfile" :avatar="executorProfileRow?.avatar" :size="20" />
                      <span class="af-agent__name">{{ executorAgentLabel }}</span>
                      <KpIcon
                        name="line_arrow_right"
                        :size="12"
                        class="af-chip__caret" color="var(--fg-disabled)"
                        :style="{ transform: agentOpen ? 'rotate(90deg)' : 'rotate(-90deg)' }"
                      />
                    </button>
                    <template v-if="agentOpen">
                      <div class="af-backdrop" @click="agentOpen = false" />
                      <div class="af-menu af-menu--agent" data-testid="af-agent-menu">
                        <template v-for="section in agentOptions" :key="section.key">
                          <div class="af-menu__group">{{ section.label }}</div>
                          <div
                            v-for="row in section.children"
                            :key="row.value"
                            class="af-agent-row"
                            :data-testid="`af-agent-${row.value}`"
                            @click="pickProfile(row.value)"
                          >
                            <ProfileAvatar :name="row.value" :avatar="profilesStore.profiles.find(p => p.name === row.value)?.avatar" :size="24" />
                            <span class="af-agent-row__name">{{ row.label }}</span>
                            <KpIcon
                              v-if="row.value === executorAgentProfile"
                              name="line_check"
                              :size="14"
                              class="af-agent-row__check" color="var(--fg-title)"
                            />
                          </div>
                        </template>
                      </div>
                    </template>
                  </div>

                  <!-- 专家(可选). The executor agent runs the job either way;
                       an expert only narrows HOW. The catalog belongs to the
                       SELECTED agent above, so it reloads with every pick and
                       the pill disappears when that agent has no experts. Edit
                       hides it: the update API whitelist drops expert_id, so an
                       editable control here would silently discard the change. -->
                  <div v-if="!isEdit && expertOptions.length > 0" class="af-pop-wrap">
                    <button
                      type="button"
                      class="af-chip"
                      :class="{ 'is-open': expertOpen }"
                      data-testid="af-expert"
                      @click="expertOpen = !expertOpen"
                    >
                      <span class="af-chip__label">{{ executorExpertLabel }}</span>
                      <KpIcon name="line_down" :size="10" class="af-chip__caret" color="var(--fg-disabled)" />
                    </button>
                    <template v-if="expertOpen">
                      <div class="af-backdrop" @click="expertOpen = false" />
                      <div class="af-menu" data-testid="af-expert-menu">
                        <div
                          class="af-drop-row"
                          data-testid="af-expert-none"
                          @click="executorExpertId = null; expertOpen = false"
                        >
                          <span>{{ t('jobs.executorExpertNone') }}</span>
                          <KpIcon v-if="!executorExpertId" name="line_check" :size="14" class="af-drop-row__check" color="var(--keep-green)" />
                        </div>
                        <div
                          v-for="e in expertOptions"
                          :key="e.value"
                          class="af-drop-row"
                          :data-testid="`af-expert-${e.value}`"
                          @click="executorExpertId = e.value; expertOpen = false"
                        >
                          <span>{{ e.label }}</span>
                          <KpIcon v-if="executorExpertId === e.value" name="line_check" :size="14" class="af-drop-row__check" color="var(--keep-green)" />
                        </div>
                      </div>
                    </template>
                  </div>

                  <!-- Where it runs. Not a picker: the composer's pill is a
                       status statement (云端 / 离线) and this one says the same
                       thing with the same words. The deliver TARGET is a job
                       setting, so it sits with the other form fields above. -->
                  <span class="af-scope" :class="{ 'is-offline': !netOnline }" data-testid="af-scope">
                    <KpIcon :name="netOnline ? 'line_weather_cloudy' : 'line_wifi_level1'" :size="14" />
                    <span>{{ netOnline ? t('chat.cloudScope') : t('net.offline') }}</span>
                  </span>
              </div>
            </ComposerBox>
            <!-- The "+" menu this was started from has already closed, so the
                 failure has nowhere else to live. Success says nothing: the
                 paths appear in the field above. -->
            <p v-if="uploadError" class="af-note af-note--fail" data-testid="af-upload-error">
              {{ uploadError }}
            </p>
          </div>
        </div>

        <div class="af-divider" />
        <div class="af-foot">
          <button type="button" class="af-btn af-btn--line" data-testid="af-cancel" @click="handleClose">
            {{ t('common.cancel') }}
          </button>
          <!-- Four states on the button that was pressed, instead of a toast.
               Success closes the sheet, so there is no `ok` state to show; a
               failure stays here and pressing again is the retry. -->
          <button
            type="button"
            class="af-btn af-btn--primary"
            :class="{ 'is-pending': saveState === 'pending', 'is-fail': saveState === 'fail' }"
            data-testid="af-create"
            :disabled="!valid || loading"
            @click="handleSave"
          >
            <KpIcon
              v-if="saveState === 'pending'"
              name="full_loading_circle"
              :size="16"
              class="spin"
            />
            <KpIcon v-else-if="saveState === 'fail'" name="full_warning" :size="16" />
            {{ isEdit ? t('common.update') : t('common.create') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
// Prototype NewAutoDrawer: absolute-inset overlay, centered 620px sheet.
.af-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
}

.af-scrim {
  position: absolute;
  inset: 0;
  background: var(--mask-40);
}

.af-sheet {
  position: relative;
  width: min(620px, calc(100vw - 32px));
  max-height: 88vh;
  overflow: auto;
  background: var(--bg);
  border-radius: var(--r-sheet);
  box-shadow: var(--shadow-notification);
  animation: kp-pop var(--motion-base) var(--ease-out);
}

.af-head {
  display: flex;
  align-items: center;
  padding: 24px 28px 0;
}

.af-head__title {
  flex: 1;
}

.af-close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    color: var(--fg-secondary);
    background: var(--gray-fa);
  }
}

.af-body {
  padding: 24px 28px 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.af-label {
  margin-bottom: 10px;
}

// Prototype fieldStyle: h44 / r8 / surface-2 / 0 12px / regular 14.
.af-field {
  height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-2);
  font: var(--w-regular) 14px / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  box-sizing: border-box;
  appearance: none;
  outline: none;

  &::placeholder {
    color: var(--fg-disabled);
  }

  &--full {
    width: 100%;
  }

  &--s {
    height: 36px;
  }
}

.af-select {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.af-row {
  display: flex;
  gap: 10px;
}

// 每 N —— compound field: surface-3 prefix + transparent input.
.af-every {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  background: var(--surface-2);
  border-radius: 8px;
  overflow: hidden;
}

.af-every__prefix {
  padding: 0 12px;
  height: 44px;
  display: flex;
  align-items: center;
  background: var(--surface-3);
  font: var(--w-medium) 14px / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
}

.af-every__input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  padding: 0 12px;
  font: var(--w-regular) 14px / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
}

// Shared popup anchor for the time / month-day pickers.
.af-pick {
  position: relative;
  flex: 1;
  min-width: 0;
}

.af-pick__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}

.af-pick__placeholder {
  color: var(--fg-disabled);
}

.af-pick__caret {
  color: var(--fg-disabled);
}

.af-backdrop {
  position: fixed;
  inset: 0;
  z-index: 92;
}

// TimePicker: 220px, two 200px scroll columns.
.af-time-pop {
  position: absolute;
  left: 0;
  top: 48px;
  width: 220px;
  background: var(--bg);
  border-radius: 12px;
  box-shadow: var(--shadow-notification);
  z-index: 93;
  display: flex;
}

.af-time-col {
  flex: 1;
  height: 200px;
  overflow: auto;
  padding: 4px 0;

  &--divided {
    border-left: 0.5px solid var(--divider);
  }
}

.af-time-item {
  text-align: center;
  padding: 8px 0;
  cursor: pointer;
  font: var(--w-regular) 14px / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);

  &.is-on {
    font-weight: var(--w-semibold);
    color: var(--fg-title);
    background: var(--gray-f7);
  }
}

// MonthDayPicker: 280px, 7-col grid of 32px circles.
.af-month-pop {
  position: absolute;
  left: 0;
  top: 48px;
  width: 280px;
  background: var(--bg);
  border-radius: 12px;
  box-shadow: var(--shadow-notification);
  z-index: 93;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
}

.af-month-day {
  width: 32px;
  height: 32px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  cursor: pointer;
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);

  &.is-on {
    background: var(--gray-33);
    color: #fff;
  }
}

// 每周 weekday dots: 34px circles, selected = ink.
.af-weekdays {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.af-weekday {
  width: 34px;
  height: 34px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: var(--gray-f7);
  color: var(--fg-secondary);
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);

  &.is-on {
    background: var(--gray-33);
    color: #fff;
  }
}

// Box, section order and insets come from ComposerBox (shared with both chat
// composers). What is left here is this dialog's own field behaviour: a taller
// floor than a chat field, and pills that wrap with the caret.
.af-beam-field {
  display: flex;
  min-height: 160px;
  flex-wrap: wrap;
  align-items: center;
  // Keep the pill/textarea line at the top of the 160px area — the default
  // align-content: stretch would center it vertically when a pill shrinks
  // the textarea to 28px.
  align-content: flex-start;
  gap: 8px;
}

.af-attach-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 9999px;
  background: var(--hue-purple-bg);
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);
  color: var(--hue-purple);
  flex: 0 0 auto;
}

.af-attach-pill__x {
  display: inline-flex;
  cursor: pointer;
}

.af-textarea {
  flex: 1 1 60px;
  min-width: 60px;
  border: 0;
  outline: none;
  resize: none;
  padding: 0;
  margin: 0;
  font: var(--w-regular) 16px / 1.6 var(--font-cn);
  color: var(--fg-primary);
  background: transparent;
  box-sizing: border-box;

  &::placeholder {
    color: var(--fg-disabled);
  }
}

// Pushes the right group (usage / model) to the right edge, leaving the "+"
// alone on the left — same slot names as the chat composers' tool rows.
.tool-row-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.af-pop-wrap {
  position: relative;
}

// Prototype AddMenu trigger: 32px circle, full_add 18, fg-aux; open state
// gets the selected-bg wash.
.af-add {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    background: var(--gray-f7);
  }

  &.is-open {
    background: var(--selected-bg);
    color: var(--fg-primary);
  }
}

// Model chip — the composer's `.composer-model-button` values, so the two
// surfaces show one pill: 28 tall, 13 side padding, 12px Medium, hover/open on
// --surface-2. (An earlier pass used the prototype ModePicker's 32; the
// instruction here is to match 新建任务, and that pill is 28.)
.af-chip {
  height: 28px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--motion-fast) var(--ease-std);

  &:hover,
  &.is-open {
    background: var(--surface-2);
  }
}

.af-chip__caret,
.af-chip__spark {
  flex: none;
}

// Prototype UsagePill: 32px ghost pill, chart icon + tabular number.
.af-usage {
  height: 32px;
  padding: 0 10px;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
}

// Same as the composer's .context-info__count — the data face, not the CN one.
.af-usage__num {
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-data);
  font-variant-numeric: tabular-nums;
}

.af-chip__label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-menu {
  position: absolute;
  z-index: 93;
  width: 208px;
  max-height: 320px;
  overflow: auto;
  padding: 8px;
  background: var(--bg);
  border-radius: var(--r-card);
  // Same chrome as the new-task composer's popovers: hairline in and out, no
  // drop shadow. The prototype's popovers (AgentPill, ModePicker, the ContextBar
  // scope drop this menu is) all carry exactly this double 0.5px ring — it uses
  // no drop shadow anywhere — and §7.1 keeps these surfaces flat.
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);

  &--up-left {
    left: 0;
    bottom: 40px;
  }

  &--up-right {
    right: 0;
    bottom: 36px;
  }

  &--repeat {
    width: 200px;
    padding: 10px;
  }

  // Prototype AgentPill popover is wider (300) to fit avatars + names.
  &--agent {
    left: 0;
    bottom: 36px;
    width: 300px;
  }

  // Deliver target lives in the form now, so its popover drops DOWN from the
  // field instead of rising out of the composer box.
  &--deliver {
    left: 0;
    top: 40px;
    width: 220px;
  }

  // Level-2 flyout of the ＋ menu: abuts level 1 on the right, same width, no
  // gap to cross (the 160ms safe delay covers the pointer, the abutment keeps
  // the distance at zero).
  &--sub {
    left: 208px;
    width: 220px;
  }

  &--model {
    width: 260px;
    bottom: 40px;
  }
}

.af-menu__rule {
  height: 1px;
  background: var(--divider);
  margin: 4px 4px;
}

.af-menu__label {
  padding: 4px 12px 6px;
  color: var(--fg-aux);
}

// Prototype AddMenu rows: 8/12 padding, icon 16 fg-aux, t-sub label.
.af-menu-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--r-ctl);
  cursor: pointer;

  // One hover ground for every menu row in this dialog and in the composer:
  // the prototype's `.row` is --surface-3.
  &:hover,
  &.is-active {
    background: var(--surface-3);
  }
}

.af-menu__caret {
  flex: none;
  margin-left: auto;
}

.af-menu__icon {
  color: var(--fg-aux);
}

.af-menu__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// The hairline over this row and its 8px inset come from ComposerBox; the pills
// sit 4px apart, same as the chat composer's pillbar.
.af-ctxbar {
  display: flex;
  align-items: center;
  gap: 4px;
}

// Prototype AgentPill: 28px, avatar tucked into 4px left padding.
.af-agent {
  height: 28px;
  padding: 0 12px 0 4px;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--fg-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);
  cursor: pointer;
  max-width: 240px;

  &:hover {
    background: var(--gray-f7);
  }

  &.is-open {
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--divider);
  }
}

.af-agent__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Section heading inside the agent menu (我的 / 群组) — a label, not a row:
   it must never look pressable. */
.af-menu__group {
  padding: 6px 12px 2px;
  color: var(--fg-aux);
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
}

.af-agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--r-ctl);
  cursor: pointer;

  &:hover {
    background: var(--surface-3);
  }
}

.af-agent-row__name {
  flex: 1;
  min-width: 0;
  font: var(--w-regular) 14px / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-agent-row__check {
  color: var(--fg-title);
}

// Scope pill — the composer's `.composer-scope-pill` geometry, but a <span>:
// there is nothing to pick here, so it carries no pointer and no caret. Offline
// turns the text and glyph danger-red; the ground stays put (a red ground would
// read as a warning block).
.af-scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  background: var(--gray-f7);
  color: var(--fg-secondary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  white-space: nowrap;
  flex: none;

  &.is-offline {
    color: var(--danger);
  }
}

// Deliver target trigger, inside the form's field shell.
.af-deliver-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-file-input {
  display: none;
}

.af-drop-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--surface-3);
  }

  // §9.1 disabled: the whole row dims, the same treatment the composer's model
  // menu gives an unavailable option. Greying only the label left the icon at
  // full strength, so the row read as enabled.
  &:disabled {
    cursor: default;
    opacity: 0.4;
  }
}

.af-drop-row__name {
  flex: 1;
  min-width: 0;
  text-align: left;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
}

.af-drop-row__check {
  color: var(--keep-green);
}

// Slash panel above the beam box (prototype SlashPanel anatomy).
.af-slash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: 8px;
  overflow: auto;
  background: var(--bg);
  border-radius: var(--r-sheet);
  padding: 8px;
  // Hairline in and out, no drop shadow — same panel chrome as the chat
  // composer's slash list (§7.1).
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);
  z-index: 50;
}

.af-slash__empty {
  padding: 20px 8px;
  text-align: center;
  color: var(--fg-disabled);
}

.af-slash__group {
  padding: 8px 8px 4px;
  margin-bottom: 4px;
  color: var(--fg-disabled);
}

.af-slash__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: var(--r-ctl);
  cursor: pointer;

  &:hover {
    background: var(--surface-3);
  }
}

// Prototype slash tile: solid hue ground, white first character.
.af-slash__tile {
  width: 30px;
  height: 30px;
  border-radius: var(--r-ctl);
  color: var(--white);
  display: grid;
  place-items: center;
  flex: 0 0 30px;
  font: var(--w-semibold) var(--t-13) / var(--lh-1) var(--font-cn);
}

.af-slash__text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Sits flush against the beam box — the prototype's Divider has no margin.
.af-divider {
  height: 1px;
  background: var(--divider);
}

.af-foot {
  display: flex;
  gap: 8px;
  padding: 20px;
  justify-content: flex-end;
}

// Prototype Btn size m: h36, pad 16, medium 14. 取消 = line (radius 8 per the
// drawer's explicit override), 创建 = primary (Keep green pill).
.af-btn {
  height: 36px;
  padding: 0 16px;
  border: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font: var(--w-medium) 14px / var(--lh-1) var(--font-cn);
  cursor: pointer;
  white-space: nowrap;

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }

  &--line {
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg-primary);
    box-shadow: inset 0 0 0 1px var(--divider);
  }

  &--primary {
    border-radius: 9999px;
    background: var(--action);
    color: var(--action-fg);
  }

  // `pending` is NOT dimmed — dimmed reads as broken, and it is working. It is
  // disabled, so the `:disabled` rule above would grey it out; undo that.
  &.is-pending:disabled {
    opacity: 1;
  }

  // Failure flips the whole button, because it has to be findable on a full
  // screen. It stays flipped: the next press is the retry.
  &.is-fail {
    background: var(--danger-bg);
    color: var(--danger);
  }
}

// Resident failure lines — for the two failures that have no button to sit on
// (opening the sheet, and an upload started from a menu that has since closed).
.af-note {
  margin: 0 0 16px;
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.af-note--fail {
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
}
</style>
