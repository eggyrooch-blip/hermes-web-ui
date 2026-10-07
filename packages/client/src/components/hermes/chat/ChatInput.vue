<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { consumeSessionExpertSaveError, fetchContextLength } from '@/api/hermes/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { fetchSkills, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'
import { fetchExperts, type ExpertInfo } from '@/api/hermes/experts'
import { fetchSlashCommands, type SlashCommand } from '@/api/hermes/slash'
import {
  cardifyFeishuUrls,
  extractFeishuUrls,
  fetchLinkPreviews,
  restoreFeishuUrlSlots,
  revealCardifiedUrl,
  type FeishuLinkPreview,
} from '@/api/hermes/link-previews'
import { isStoredSuperAdmin } from '@/api/client'
import { NButton, NTooltip, NSwitch, NModal, NInputNumber, NPopover, NPopselect, NSlider, useMessage } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch, getCurrentInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import AgentPicker from '@/components/hermes/agents/AgentPicker.vue'
import CoworkProjectPicker from './CoworkProjectPicker.vue'
import { getCoworkProject, type CoworkProject } from '@/api/hermes/cowork'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import ChatScheduledEntry from './ChatScheduledEntry.vue'
import FeishuLinkPreviewCard from './FeishuLinkPreviewCard.vue'
import VoiceDialogueControls from './VoiceDialogueControls.vue'
import { useMicRecorder } from '@/composables/useMicRecorder'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceDialogue } from '@/composables/useVoiceDialogue'
import { transcribeSpeech } from '@/api/hermes/stt'
import type { StoredSttProvider } from '@/api/hermes/stt-settings'
import { useSttSettings } from '@/composables/useSttSettings'
import { useBrowserSpeechRecognition } from '@/composables/useBrowserSpeechRecognition'
import { CHAT_INPUT_HEIGHT_MOBILE_QUERY, chatInputHeightStyle, clampChatInputHeight } from '@/utils/chat-input-height'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const component = getCurrentInstance()
const currentRoute = computed(() => component?.appContext.config.globalProperties.$route as RouteLocationNormalizedLoaded | undefined)
const { t } = useI18n()
const message = useMessage()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()
const isSuperAdmin = computed(() => isStoredSuperAdmin())

function selectProject(project: CoworkProject | null) {
  const current = chatStore.activeSession
  const sessionId = current?.source === 'coding_agent' || current?.source === 'global_agent'
    ? chatStore.newChat({ source: 'cli', agent: 'hermes' }).id
    : chatStore.activeSessionId || (project ? chatStore.newChat({ source: 'cli', agent: 'hermes' }).id : null)
  if (!sessionId) return
  const targetSessionId = chatStore.setSessionProject(sessionId, project)
  const target = chatStore.sessions.find(session => session.id === targetSessionId)
  const router = component?.appContext.config.globalProperties.$router
  if (targetSessionId && router) {
    void router.push({
      name: 'hermes.session',
      params: { sessionId: targetSessionId },
      query: target?.profile ? { profile: target.profile } : undefined,
    })
  }
}

const activeProject = computed<CoworkProject | null>({
  get: () => {
    const session = chatStore.activeSession
    if (!session?.projectId) return null
    return {
      id: session.projectId,
      name: session.projectName || session.projectId,
      description: '',
      instructions: '',
      icon: '',
      color: '',
      primary_folder: session.workspace || null,
      status: 'active',
      created_at: 0,
      updated_at: 0,
    } satisfies CoworkProject
  },
  set: selectProject,
})
const projectSelectionLocked = computed(() => Boolean(chatStore.activeSession?.projectBound))
const canPickProject = computed(() => (
  chatStore.runtimeMode !== 'global_agent'
  && chatStore.activeSession?.source !== 'coding_agent'
  && chatStore.activeSession?.source !== 'global_agent'
))
let appliedQuerySelection = ''

watch(
  () => ({
    projectId: typeof currentRoute.value?.query.project === 'string' ? currentRoute.value.query.project : '',
    sessionId: chatStore.activeSessionId,
  }),
  async ({ projectId, sessionId }) => {
    if (!projectId || projectId === appliedQuerySelection) return
    try {
      const project = await getCoworkProject(projectId)
      const currentProjectId = typeof currentRoute.value?.query.project === 'string'
        ? currentRoute.value.query.project
        : ''
      if (chatStore.activeSessionId !== sessionId || currentProjectId !== projectId) return
      selectProject(project)
      appliedQuerySelection = projectId
    } catch {
      message.error(t('cowork.loadFailed'))
    }
  },
  { immediate: true },
)

const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.default'), value: '' },
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])
const currentReasoningEffort = computed<string>(() =>
  chatStore.activeSession?.reasoningEffort || ''
)
// The slider's position is the option INDEX, so the stop order in
// reasoningEffortOptions is the scale. An unknown stored value falls back to
// stop 0 (the config default) rather than leaving the handle unplaced.
const reasoningEffortSliderValue = computed(() => {
  const index = reasoningEffortOptions.value.findIndex(option => option.value === currentReasoningEffort.value)
  return index >= 0 ? index : 0
})
// One accent per stop, cool to hot, applied to both the button and the popover
// heading so the chosen depth is readable without opening the popover.
const reasoningEffortAccentColors = [
  '#94a3b8',
  '#2ac8e9',
  '#2bd9b4',
  '#4ed786',
  '#b9d93a',
  '#f9c33c',
  '#f77734',
  '#ef4444',
] as const
const reasoningEffortAccentStyle = computed(() => ({
  '--reasoning-effort-accent-color': reasoningEffortAccentColors[reasoningEffortSliderValue.value]
    || reasoningEffortAccentColors[0],
}))
const reasoningEffortLabel = computed<string>(() => {
  const v = currentReasoningEffort.value
  if (!v) return t('chat.reasoningEffort.defaultLabel')
  const opt = reasoningEffortOptions.value.find(o => o.value === v)
  return opt?.label || v
})
function onReasoningEffortChange(value: string | null | undefined) {
  const sid = chatStore.activeSessionId
  if (!sid) return
  void chatStore.setSessionReasoningEffort(sid, value || '')
}
function reasoningEffortSliderLabel(value: number) {
  return reasoningEffortOptions.value[Math.round(value)]?.label || reasoningEffortLabel.value
}
function onReasoningEffortSliderChange(value: number | [number, number]) {
  const numericValue = Array.isArray(value) ? value[0] : value
  const option = reasoningEffortOptions.value[Math.round(numericValue)]
  if (option) onReasoningEffortChange(option.value)
}

// --- Expert slot (专家广场) -------------------------------------------------
// Selecting an expert here stamps the active non-coding session; future runs
// carry the session's persisted expert metadata.
const experts = ref<ExpertInfo[]>([])
const activeExpertId = computed<string | null>(() => chatStore.activeExpertId)
const activeExpert = computed<ExpertInfo | null>(
  () => experts.value.find(e => e.id === activeExpertId.value) ?? null,
)
const activeExpertAvatarBroken = ref(false)
const activeExpertLabel = computed<string>(() => {
  const e = activeExpert.value
  if (e) return e.title || e.name
  // Fall back to the raw id when the catalog hasn't loaded the active expert
  // (e.g. selected on another surface). Empty = no expert.
  return activeExpertId.value || ''
})
const activeExpertAvatar = computed<string>(() => {
  if (activeExpertAvatarBroken.value) return ''
  return activeExpert.value?.avatar || ''
})
const activeExpertInitial = computed<string>(() => {
  const src = (activeExpert.value?.name || activeExpert.value?.title || activeExpertId.value || '?').trim()
  return src ? Array.from(src)[0] : '?'
})
const expertOptions = computed(() => [
  { label: t('chat.expertSlot.none'), value: '' },
  ...experts.value.map(e => ({ label: e.title || e.name, value: e.id })),
])
// The server fixes a session's expert the moment it has messages: changing it
// afterwards is a 409 from persistSessionExpert, whether or not an expert is
// bound yet. Mirror that rule here so the slot never offers a pick that is
// guaranteed to fail. BOTH counts, same reasoning as canPickAgent below: a
// hydrated session keeps messageCount at 0 until the server round-trips, so the
// local array is what catches the message the user just sent.
const sessionHasMessages = computed(() => Boolean(
  chatStore.activeSession && (chatStore.activeSession.messageCount || chatStore.activeSession.messages?.length),
))
const expertSelectionLocked = computed(() => sessionHasMessages.value)
// Locked with no expert bound is the case users hit blind: say why instead of
// showing an empty "No expert" tooltip on a dead control.
const expertSlotHint = computed<string>(() => (
  expertSelectionLocked.value && !activeExpertId.value
    ? t('chat.expertSlot.lockedByMessages')
    : `${t('chat.expertSlot.tooltip')}: ${activeExpertLabel.value || t('chat.expertSlot.none')}`
))
const scheduledExpert = computed(() => {
  const session = chatStore.activeSession
  if (!session?.id || !session.expertId || session.source === 'coding_agent' || session.source === 'global_agent') return null
  return activeExpert.value?.id === session.expertId ? activeExpert.value : null
})
async function onExpertChange(value: string | null | undefined) {
  if (expertSelectionLocked.value) return
  // Pin the session this save belongs to: the user can switch sessions while
  // the request is in flight, so `activeSession` afterwards is not necessarily
  // the one the server answered about.
  const sessionId = chatStore.activeSession?.id
  const expert = experts.value.find(e => e.id === value)
  const saved = await chatStore.selectActiveExpert(value || null, expert ? {
    avatar: expert.avatar || '',
    label: expert.title || expert.name || expert.id,
  } : undefined)
  if (!saved) {
    // Keep re-syncing the list, but never let it decide the copy: it returns
    // early while streaming or loading and only logs on error, so post-refresh
    // state says nothing about why this save failed. A failed refresh must not
    // swallow the toast either.
    try {
      await chatStore.refreshSessionListOnly()
    } catch {
      // The list stays stale; the user still gets the reason below.
    }
    // The reason comes from the 409 of this very request, keyed to its session.
    const failure = sessionId ? consumeSessionExpertSaveError(sessionId) : null
    message.error(failure?.status === 409
      ? t('chat.expertSlot.lockedByMessages')
      : t('common.saveFailed'))
  }
}
async function loadExpertsForSlot() {
  try {
    const data = await fetchExperts(profilesStore.activeProfileName || undefined)
    experts.value = data.experts
  } catch {
    experts.value = []
  }
}
const DRAFT_STORAGE_KEY = 'hermes_chat_input_drafts_v1'
type DraftMap = Record<string, string>
const inputText = ref('')
const inputWrapperRef = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const commandDropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const previewAttachment = ref<Attachment | null>(null)
const linkPreviews = ref<FeishuLinkPreview[]>([])
const linkPreviewSlots = ref<string[]>([])
let linkPreviewRequest = 0
let linkPreviewTimer: ReturnType<typeof setTimeout> | undefined
let linkPreviewKey = ''
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const speech = useGlobalSpeech()
const micRecorder = useMicRecorder({
  messages: {
    unsupported: t('chat.voiceInput.microphoneUnsupported'),
    recordingFailed: t('chat.voiceInput.microphoneRecordingFailed'),
  },
})
const sttSettings = useSttSettings()
const browserRecognition = useBrowserSpeechRecognition({
  messages: {
    unsupported: t('chat.voiceInput.browserSpeechUnsupported'),
    failed: t('chat.voiceInput.browserSpeechFailed'),
    failedWithReason: (reason) => t('chat.voiceInput.browserSpeechFailedWithReason', { error: reason }),
  },
})
const activeVoiceCaptureMode = ref<'browser' | 'backend' | null>(null)

type SlashCommandOption = {
  name: string
  args: string
  description: string
  insertText?: string
  key: string
  opensSkillPicker?: boolean
}

function normalizeVoiceTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function backendTranscribeOptions(): {
  provider: StoredSttProvider
  language?: string
  prompt?: string
} {
  if (sttSettings.provider.value === 'custom') {
    return {
      provider: 'custom',
      language: sttSettings.customLanguage.value.trim() || undefined,
      prompt: sttSettings.customPrompt.value.trim() || undefined,
    }
  }

  return {
    provider: 'openai',
    language: sttSettings.openaiLanguage.value.trim() || undefined,
    prompt: sttSettings.openaiPrompt.value.trim() || undefined,
  }
}

function browserCaptureLanguage() {
  return sttSettings.openaiLanguage.value.trim() || sttSettings.customLanguage.value.trim() || ''
}

function insertVoiceTranscriptIntoInput(text: string) {
  const normalizedTranscript = normalizeVoiceTranscript(text)
  if (!normalizedTranscript) return

  const el = textareaRef.value
  const currentValue = inputText.value
  const selectionStart = el?.selectionStart ?? currentValue.length
  const selectionEnd = el?.selectionEnd ?? selectionStart
  const before = currentValue.slice(0, selectionStart)
  const after = currentValue.slice(selectionEnd)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const nextValue = `${before}${prefix}${normalizedTranscript}${suffix}${after}`
  const nextCursorPosition = before.length + prefix.length + normalizedTranscript.length

  inputText.value = nextValue
  slashActive.value = false

  nextTick(() => {
    const textarea = textareaRef.value
    if (!textarea) return

    textarea.focus()
    textarea.setSelectionRange(nextCursorPosition, nextCursorPosition)

    if (textareaHeight.value === null && isMobileInput.value) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`
    }
  })
}

const voiceDialogue = useVoiceDialogue({
  transcribe: async (audio) => {
    const { provider, language, prompt } = backendTranscribeOptions()
    return transcribeSpeech({ audio, provider, language, prompt })
  },
  sendMessage: async (text) => {
    insertVoiceTranscriptIntoInput(text)
  },
  stopOutputAudio: () => speech.stop(true),
})
const voiceDialogueTranscript = computed(() => {
  if (activeVoiceCaptureMode.value !== 'browser' || voiceDialogue.status.value !== 'capturing') {
    return voiceDialogue.transcript.value
  }

  return normalizeVoiceTranscript([
    browserRecognition.transcript.value,
    browserRecognition.partialTranscript.value,
  ].filter(Boolean).join(' '))
})
const shouldShowBrowserRecognitionError = computed(() =>
  sttSettings.provider.value === 'browser' || activeVoiceCaptureMode.value === 'browser',
)
const voiceDialogueError = computed(() =>
  voiceDialogue.error.value?.message
  ?? (shouldShowBrowserRecognitionError.value ? browserRecognition.error.value?.message : null)
  ?? micRecorder.state.value.error?.message
  ?? null,
)

const bridgeCommands = computed<SlashCommandOption[]>(() => {
  const commands: SlashCommandOption[] = [
    { key: 'command:usage', name: 'usage', args: '', description: t('chat.slashCommands.usage') },
    { key: 'command:status', name: 'status', args: '', description: t('chat.slashCommands.status') },
    { key: 'command:abort', name: 'abort', args: '', description: t('chat.slashCommands.abort') },
    { key: 'command:queue', name: 'queue', args: t('chat.slashCommandArgs.message'), description: t('chat.slashCommands.queue') },
    { key: 'command:skill', name: 'skill', args: '', description: t('skills.title'), opensSkillPicker: true },
    { key: 'command:plan', name: 'plan', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.plan') },
    { key: 'command:goal', name: 'goal', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.goal') },
    { key: 'command:goal-status', name: 'goal', args: 'status', insertText: 'goal status', description: t('chat.slashCommands.goalStatus') },
    { key: 'command:goal-pause', name: 'goal', args: 'pause', insertText: 'goal pause', description: t('chat.slashCommands.goalPause') },
    { key: 'command:goal-resume', name: 'goal', args: 'resume', insertText: 'goal resume', description: t('chat.slashCommands.goalResume') },
    { key: 'command:goal-done', name: 'goal', args: 'done', insertText: 'goal done', description: t('chat.slashCommands.goalDone') },
    { key: 'command:goal-clear', name: 'goal', args: 'clear', insertText: 'goal clear', description: t('chat.slashCommands.goalClear') },
    { key: 'command:subgoal', name: 'subgoal', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.subgoal') },
    { key: 'command:clear', name: 'clear', args: '', description: t('chat.slashCommands.clear') },
    { key: 'command:clear-history', name: 'clear', args: '--history', insertText: 'clear --history', description: t('chat.slashCommands.clearHistory') },
    { key: 'command:title', name: 'title', args: t('chat.slashCommandArgs.title'), description: t('chat.slashCommands.title') },
    { key: 'command:compress', name: 'compress', args: '', description: t('chat.slashCommands.compress') },
    { key: 'command:steer', name: 'steer', args: t('chat.slashCommandArgs.text'), description: t('chat.slashCommands.steer') },
    { key: 'command:destroy', name: 'destroy', args: '', description: t('chat.slashCommands.destroy') },
  ]
  if (isSuperAdmin.value) {
    commands.push({ key: 'command:reload-mcp', name: 'reload-mcp', args: '', description: t('chat.slashCommands.reloadMcp') })
  }
  return commands
})

const slashActive = ref(false)
const slashQuery = ref('')
const slashActiveIndex = ref(0)
const skillCategories = ref<SkillCategory[]>([])
const showSkillPicker = ref(false)
const skillSearch = ref('')
const skillPickerLoading = ref(false)
let skillsLoadedKey = ''
let skillsLoadRequest: Promise<void> | null = null
const isBridgeSession = computed(() => chatStore.activeSession?.source === 'cli')

// The session-level agent selector is offered only before the first message:
// switching agents mid-conversation would hand a running thread to a different
// profile. Once anything has been said, "new task" is the way to switch.
const canPickAgent = computed(() => {
  const session = chatStore.activeSession
  if (!session) return true
  if (chatStore.isStreaming) return false
  // BOTH counts must be zero: a hydrated session keeps messageCount at 0 until
  // the server round-trips, so the local array is what catches the message the
  // user just sent. Either one alone leaves a window where switching agents
  // would hand a live conversation to another profile.
  const serverCount = session.messageCount ?? 0
  const localCount = session.messages?.length ?? 0
  return serverCount === 0 && localCount === 0
})

// Per-profile skill/slash commands from the backend (restored after the upstream
// rebaseline dropped this). Powers the `/` picker for ALL sessions, and surfaces
// each skill's self-declared short commands (e.g. /strategy). Fail-soft: errors
// degrade to the built-in commands, never block the input box.
const skillSlashCommands = ref<SlashCommandOption[]>([])
let slashCommandsLoadedFor = ''
let slashCommandsRequest: Promise<void> | null = null
let slashCommandsRequestKey = ''
let slashDismissed = false
function currentSlashProfile() {
  return chatStore.activeSession?.profile || profilesStore.activeProfileName || ''
}
async function loadSlashCommands() {
  const key = currentSlashProfile()
  if (slashCommandsLoadedFor === key) return
  // an in-flight request for the SAME profile can be shared; one for a different
  // profile must not satisfy this load (multi-tenant: never serve another profile's list).
  if (slashCommandsRequest && slashCommandsRequestKey === key) return slashCommandsRequest
  slashCommandsRequestKey = key
  slashCommandsRequest = (async () => {
    try {
      const res = await fetchSlashCommands(key || undefined)
      if (currentSlashProfile() !== key) return
      const builtinNames = new Set(bridgeCommands.value.map(c => c.name))
      skillSlashCommands.value = (res.commands || [])
        // the server already prepends LOCAL_COMMANDS (e.g. /clear); the client owns the
        // built-ins, so drop server-side locals + anything that collides with a built-in.
        .filter((c: SlashCommand) => c.source !== 'local' && !builtinNames.has(c.name))
        .map((c: SlashCommand) => ({
          key: `slash:${c.slash}`,
          name: c.name,
          args: '',
          description: c.description || c.title || c.name,
          insertText: c.name,
        }))
      slashCommandsLoadedFor = key
    } catch {
      if (currentSlashProfile() !== key) return
      skillSlashCommands.value = []
      slashCommandsLoadedFor = key
    } finally {
      slashCommandsRequest = null
    }
  })()
  return slashCommandsRequest
}
const skillPickerItems = computed(() => {
  const byName = new Map<string, SkillInfo>()
  for (const category of skillCategories.value) {
    for (const skill of category.skills || []) {
      if (skill.enabled === false) continue
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].map(skill => {
    const commandName = skillCommandName(skill.name)
    return {
      key: `skill:${commandName}`,
      name: skill.name,
      commandName,
      description: skill.description || skill.name,
    }
  })
})
const filteredBridgeCommands = computed(() => {
  const query = slashQuery.value.toLowerCase()
  const all = [...bridgeCommands.value, ...skillSlashCommands.value]
  return all.filter(command =>
    command.name.includes(query)
    || command.insertText?.includes(query)
    || command.description.toLowerCase().includes(query),
  )
})
const filteredSkillPickerItems = computed(() => {
  const query = skillSearch.value.trim().toLowerCase()
  if (!query) return skillPickerItems.value
  return skillPickerItems.value.filter(skill =>
    skill.name.toLowerCase().includes(query)
    || skill.commandName.includes(query)
    || skill.description.toLowerCase().includes(query),
  )
})

function skillCommandName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function currentSkillsKey() {
  return chatStore.activeSession?.profile || profilesStore.activeProfileName || 'default'
}

async function loadSkills() {
  if (!isBridgeSession.value) return
  const key = currentSkillsKey()
  if (skillsLoadedKey === key || skillsLoadRequest) return skillsLoadRequest
  skillsLoadRequest = (async () => {
    try {
      const data = await fetchSkills(key)
      if (currentSkillsKey() !== key) return
      skillCategories.value = data.categories || []
      skillsLoadedKey = key
    } catch {
      if (currentSkillsKey() !== key) return
      skillCategories.value = []
      skillsLoadedKey = key
    } finally {
      skillsLoadRequest = null
    }
  })()
  return skillsLoadRequest
}

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null) // null = auto
const isMobileInput = ref(false)
let mobileInputQuery: MediaQueryList | null = null

const inputWrapperStyle = computed(() =>
  chatInputHeightStyle(settingsStore.display.chat_input_height, textareaHeight.value, isMobileInput.value),
)
const inputTextareaStyle = computed(() => (isMobileInput.value ? {} : { height: '100%' }))

function syncMobileInputState() {
  if (typeof window === 'undefined') return
  const nextIsMobile = mobileInputQuery?.matches ?? window.innerWidth <= 768
  isMobileInput.value = nextIsMobile
  if (nextIsMobile) textareaHeight.value = null
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  if (isMobileInput.value) return
  const el = textareaRef.value
  if (!el) return
  // 如果当前是 auto，用实际 clientHeight 作为起始值
  const startHeight = inputWrapperRef.value?.clientHeight || el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    // 往上拖 (deltaY < 0) → 高度增加
    const newHeight = startHeight - deltaY
    textareaHeight.value = clampChatInputHeight(newHeight)
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// 自动播放语音开关
const autoPlaySpeech = ref(false)

function readDraftMap(): DraftMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getActiveDraftSessionId() {
  return chatStore.activeSessionId || chatStore.activeSession?.id || ''
}

function loadDraftForActiveSession() {
  const sessionId = getActiveDraftSessionId()
  inputText.value = sessionId ? readDraftMap()[sessionId] || '' : ''
}

/**
 * Take the one-shot draft the expert catalog staged (「试试这样问我」) and put it
 * in the box for the session we just landed on. Runs AFTER the normal draft
 * load, because the session-switch watcher would otherwise overwrite it with
 * the fresh session's empty draft. The store hands it over only when this is
 * the session it was addressed to, so landing anywhere else leaves it alone
 * instead of overwriting that session's draft. Returns whether anything was
 * consumed.
 */
function applyStagedComposerDraft(): boolean {
  const staged = chatStore.consumeStagedComposerDraft(getActiveDraftSessionId())
  if (!staged) return false
  inputText.value = staged
  saveDraftForActiveSession(staged)
  queueLinkPreviews(staged)
  return true
}

function saveDraftForActiveSession(value: string) {
  saveDraftForSession(getActiveDraftSessionId(), value)
}

function saveDraftForSession(sessionId: string, value: string) {
  if (!sessionId) return
  const drafts = readDraftMap()
  if (value) {
    drafts[sessionId] = value
  } else {
    delete drafts[sessionId]
  }
  if (Object.keys(drafts).length > 0) {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
  } else {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  }
}

// 从 localStorage 读取设置
onMounted(() => {
  loadDraftForActiveSession()
  // Routing straight into a brand-new expert session can mount ChatInput after
  // the session id was already set, so the watcher below never fires — consume
  // here too.
  applyStagedComposerDraft()
  mobileInputQuery = window.matchMedia?.(CHAT_INPUT_HEIGHT_MOBILE_QUERY) ?? null
  syncMobileInputState()
  mobileInputQuery?.addEventListener?.('change', syncMobileInputState)
  const saved = localStorage.getItem('autoPlaySpeech')
  if (saved !== null) {
    autoPlaySpeech.value = saved === 'true'
    // 同步到 chat store
    chatStore.setAutoPlaySpeech(autoPlaySpeech.value)
  }
  void loadExpertsForSlot()
})

onUnmounted(() => {
  mobileInputQuery?.removeEventListener?.('change', syncMobileInputState)
  mobileInputQuery = null
  if (linkPreviewTimer) clearTimeout(linkPreviewTimer)
})

// 监听变化并保存
watch(autoPlaySpeech, (value) => {
  localStorage.setItem('autoPlaySpeech', String(value))
  // 通知 chat store
  chatStore.setAutoPlaySpeech(value)
})

watch(inputText, (value) => {
  saveDraftForActiveSession(composedMessageText())
  queueLinkPreviews(value)
})

watch(() => settingsStore.display.chat_input_height, () => {
  textareaHeight.value = null
})

watch(() => chatStore.activeSession?.id, (_newId, oldId) => {
  // Agent swap: the picker replaces the session id underneath us. Anything the
  // user already typed belongs to the task they are composing, not to the old
  // session, so carry it over instead of loading the new session's empty draft.
  const carried = chatStore.agentSwitching ? composedMessageText() : ''
  linkPreviewRequest++
  linkPreviewKey = ''
  linkPreviews.value = []
  linkPreviewSlots.value = []
  if (carried.trim()) {
    if (oldId) saveDraftForSession(oldId, '')
    inputText.value = carried
    saveDraftForActiveSession(carried)
    return
  }
  loadDraftForActiveSession()
  applyStagedComposerDraft()
})

watch(
  () => [chatStore.activeSession?.profile, profilesStore.activeProfileName],
  () => {
    const draft = composedMessageText()
    linkPreviewRequest++
    linkPreviewKey = ''
    linkPreviews.value = []
    linkPreviewSlots.value = []
    inputText.value = draft
    queueLinkPreviews(draft)
    skillsLoadedKey = ''
    skillCategories.value = []
    // drop the previous profile's slash commands so the picker never shows another
    // profile's list; they reload on the next `/` for the now-current profile.
    skillSlashCommands.value = []
    slashCommandsLoadedFor = ''
  },
)

// Reload the composer expert catalog whenever the active profile changes.
// The stale-selection clear is handled CENTRALLY in the chat store (it watches
// activeProfileName and resets activeExpertId regardless of what is mounted), so
// we only refresh this component's slot list here. Mirrors
// ExpertCatalogView.vue's `watch(activeProfileName, loadExperts)`.
watch(
  () => profilesStore.activeProfileName,
  () => {
    void loadExpertsForSlot()
  },
)
watch(
  [activeExpertId, () => activeExpert.value?.avatar],
  () => {
    activeExpertAvatarBroken.value = false
    if (!activeExpertId.value) {
      chatStore.setActiveExpertDisplay(null)
      return
    }
    if (activeExpert.value) {
      chatStore.setActiveExpertDisplay({
        avatar: activeExpert.value.avatar || '',
        label: activeExpert.value.title || activeExpert.value.name || activeExpert.value.id,
      })
    }
  },
)

// `agentSwitching` participates: between switchProfile() and the new session
// being bound, a send would go out on the old session under the new profile.
const canSend = computed(() => !chatStore.agentSwitching && (inputText.value.trim() || linkPreviews.value.length > 0 || attachments.value.length > 0))

function scrollCommandIntoView() {
  nextTick(() => {
    if (!commandDropdownRef.value) return
    const active = commandDropdownRef.value.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

function updateSlashState() {
  const el = textareaRef.value
  if (!el) return
  const cursorPos = el.selectionStart
  const beforeCursor = inputText.value.slice(0, cursorPos)
  if (!beforeCursor.startsWith('/') || beforeCursor.includes(' ') || beforeCursor.includes('\n')) {
    slashActive.value = false
    return
  }
  slashDismissed = false  // genuine typing clears any prior Escape dismissal
  // lazy-load the profile's skill/slash commands on first `/` (fail-soft); the menu
  // is available to ALL sessions, not only CLI/bridge sessions.
  void loadSlashCommands().then(() => reevaluateSlashAfterLoad(beforeCursor))
  slashQuery.value = beforeCursor.slice(1)
  slashActiveIndex.value = 0
  slashActive.value = filteredBridgeCommands.value.length > 0
}

// After the async command fetch resolves, reopen the dropdown if the user typed a
// prefix that matches ONLY backend commands (no built-in) — without it, /strategy would
// close the menu before its command loaded. Respects Escape and input changes.
function reevaluateSlashAfterLoad(capturedBefore: string) {
  if (slashDismissed || slashActive.value) return
  const el = textareaRef.value
  if (!el) return
  const beforeCursor = inputText.value.slice(0, el.selectionStart)
  if (beforeCursor !== capturedBefore) return  // user moved on
  if (!beforeCursor.startsWith('/') || beforeCursor.includes(' ')) return
  slashQuery.value = beforeCursor.slice(1)
  slashActiveIndex.value = 0
  slashActive.value = filteredBridgeCommands.value.length > 0
}

function selectBridgeCommand(command: SlashCommandOption) {
  if (command.opensSkillPicker) {
    slashActive.value = false
    void openSkillPicker()
    return
  }
  inputText.value = `/${command.insertText || command.name} `
  slashActive.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

async function openSkillPicker() {
  if (!isBridgeSession.value) return
  slashActive.value = false
  skillSearch.value = ''
  showSkillPicker.value = true
  skillPickerLoading.value = true
  try {
    await loadSkills()
  } finally {
    skillPickerLoading.value = false
  }
}

function selectSkill(skill: { commandName: string }) {
  inputText.value = `/skill ${skill.commandName} `
  showSkillPicker.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

// --- Context info ---

const contextLength = ref(256000)
const FALLBACK_CONTEXT = 256000
let contextLengthLoadedKey = ''
let contextLengthRequestKey = ''
let contextLengthRequest: Promise<void> | null = null

// Context length editing
const showContextEditModal = ref(false)
const editingContextLimit = ref(256000)
const isSavingContextLimit = ref(false)
const isCodingAgentSession = computed(() => chatStore.activeSession?.source === 'coding_agent')

async function handleEditContextLimit() {
  if (isCodingAgentSession.value) return
  editingContextLimit.value = contextLength.value
  showContextEditModal.value = true
}

async function saveContextLimit() {
  if (!editingContextLimit.value || editingContextLimit.value <= 0) {
    message.error(t('chat.contextEditInvalid'))
    return
  }

  isSavingContextLimit.value = true
  try {
    const provider = chatStore.activeSession?.provider || appStore.selectedProvider || ''
    const model = chatStore.activeSession?.model || appStore.selectedModel || ''

    if (!provider || !model) {
      message.error(t('chat.contextEditFailed'))
      return
    }

    await setModelContext(provider, model, editingContextLimit.value)
    contextLength.value = editingContextLimit.value
    contextLengthLoadedKey = currentContextLengthKey()
    showContextEditModal.value = false
    message.success(t('chat.contextEditSuccess'))
  } catch (err: any) {
    message.error(`${t('chat.contextEditFailed')}: ${err.message || ''}`)
  } finally {
    isSavingContextLimit.value = false
  }
}

function currentContextLengthParams() {
  const activeSession = chatStore.activeSession
  return {
    profile: activeSession?.profile || profilesStore.activeProfileName || undefined,
    provider: activeSession?.provider || undefined,
    model: activeSession?.model || undefined,
  }
}

function currentContextLengthKey() {
  const params = currentContextLengthParams()
  return `${params.profile || ''}|${params.provider || ''}|${params.model || ''}`
}

async function loadContextLength() {
  if (isCodingAgentSession.value) return
  const key = currentContextLengthKey()
  if (key === contextLengthLoadedKey) return
  if (key === contextLengthRequestKey && contextLengthRequest) return contextLengthRequest

  contextLengthRequestKey = key
  contextLengthRequest = (async () => {
    const params = currentContextLengthParams()
    try {
      const value = await fetchContextLength(params.profile, params.provider, params.model)
      if (currentContextLengthKey() !== key) return
      contextLength.value = value
      contextLengthLoadedKey = key
    } catch {
      if (currentContextLengthKey() !== key) return
      contextLength.value = FALLBACK_CONTEXT
      contextLengthLoadedKey = key
    } finally {
      if (contextLengthRequestKey === key) {
        contextLengthRequest = null
        contextLengthRequestKey = ''
      }
    }
  })()
  return contextLengthRequest
}

onMounted(loadContextLength)
watch(
  () => [
    profilesStore.activeProfileName,
    appStore.selectedProvider,
    appStore.selectedModel,
    chatStore.activeSession?.id,
    chatStore.activeSession?.profile,
    chatStore.activeSession?.provider,
    chatStore.activeSession?.model,
    chatStore.activeSession?.source,
  ],
  loadContextLength,
  { flush: 'post' },
)

const totalTokens = computed(() => {
  if (isCodingAgentSession.value) return 0
  const context = chatStore.activeSession?.contextTokens
  if (typeof context === 'number' && Number.isFinite(context) && context > 0) return context
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  return input + output
})
const showContextUsage = computed(() => totalTokens.value > 0)

const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))

const usagePercent = computed(() =>
  Math.min((totalTokens.value / contextLength.value) * 100, 100),
)

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// --- File attachment helpers ---

function addFile(file: File) {
  if (attachments.value.find(a => a.name === file.name)) return
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const url = URL.createObjectURL(file)
  attachments.value.push({
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    url,
    file,
  })
}

function handleAttachClick() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  for (const file of input.files) addFile(file)
  input.value = ''
}

// --- Paste image / Feishu link ---

function pastedFeishuUrls(text: string): string[] {
  return extractFeishuUrls(text)
}

async function loadLinkPreviews(urls: string[]) {
  const requestId = ++linkPreviewRequest
  try {
    const profile = chatStore.activeSession?.profile || profilesStore.activeProfileName || undefined
    const result = await fetchLinkPreviews(urls, profile)
    if (requestId === linkPreviewRequest) applyLinkPreviews(result.previews, urls)
  } catch {
    if (requestId === linkPreviewRequest) {
      applyLinkPreviews(urls.map(url => ({
        kind: 'feishu', title: '', type_label: '飞书链接', url, status: 'generic',
      })), urls)
    }
  }
}

function composedMessageText() {
  return restoreFeishuUrlSlots(inputText.value, linkPreviewSlots.value).trim()
}

function applyLinkPreviews(previews: FeishuLinkPreview[], urls: string[]) {
  const merged = new Map(linkPreviews.value.map(preview => [preview.url, preview]))
  previews.forEach(preview => merged.set(preview.url, preview))
  linkPreviews.value = [...merged.values()]
  const cardified = cardifyFeishuUrls(inputText.value, urls, linkPreviewSlots.value)
  inputText.value = cardified.text
  linkPreviewSlots.value = cardified.slots
  linkPreviewKey = ''
  saveDraftForActiveSession(composedMessageText())
}

function removeLinkPreview(url: string) {
  const revealed = revealCardifiedUrl(inputText.value, linkPreviewSlots.value, url)
  inputText.value = revealed.text
  linkPreviewSlots.value = revealed.slots
  linkPreviews.value = linkPreviews.value.filter(preview => preview.url !== url)
  saveDraftForActiveSession(composedMessageText())
}

function queueLinkPreviews(value: string) {
  const urls = pastedFeishuUrls(value)
  const key = urls.join('\n')
  if (key === linkPreviewKey) return
  linkPreviewKey = key
  if (linkPreviewTimer) clearTimeout(linkPreviewTimer)
  if (!urls.length) {
    if (!linkPreviews.value.length) linkPreviewRequest++
    return
  }
  linkPreviewTimer = setTimeout(() => {
    linkPreviewTimer = undefined
    void loadLinkPreviews(urls)
  }, 250)
}

function handlePaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imageItems = items.filter(i => i.type.startsWith('image/'))
  if (!imageItems.length) return
  e.preventDefault()
  for (const item of imageItems) {
    const blob = item.getAsFile()
    if (!blob) continue
    const ext = item.type.split('/')[1] || 'png'
    const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type })
    addFile(file)
  }
}

// --- Drag and drop ---

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.types.includes('Files')) {
    dragCounter.value++
    isDragging.value = true
  }
}

function handleDragLeave() {
  dragCounter.value--
  if (dragCounter.value <= 0) {
    dragCounter.value = 0
    isDragging.value = false
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  dragCounter.value = 0
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  for (const file of files) addFile(file)
  textareaRef.value?.focus()
}

// --- Send ---

function handleSend() {
  // Enter bypasses the disabled send button, so the swap guard is re-checked here.
  if (chatStore.agentSwitching) return
  const text = composedMessageText()
  if (!text && attachments.value.length === 0) return
  if (isBridgeSession.value && text === '/skill' && attachments.value.length === 0) {
    void openSkillPicker()
    return
  }

  chatStore.sendMessage(text, attachments.value.length > 0 ? attachments.value : undefined)
  inputText.value = ''
  linkPreviews.value = []
  linkPreviewSlots.value = []
  saveDraftForActiveSession('')
  previewAttachment.value = null
  attachments.value = []
  slashActive.value = false

  if (textareaRef.value && isMobileInput.value) {
    textareaRef.value.style.height = 'auto'
  }
}

async function startVoiceCapture() {
  browserRecognition.clearError()
  const { captureId } = await voiceDialogue.beginCapture()
  const useBrowserProvider = sttSettings.provider.value === 'browser'

  activeVoiceCaptureMode.value = useBrowserProvider ? 'browser' : 'backend'

  try {
    if (useBrowserProvider) {
      await browserRecognition.start({ language: browserCaptureLanguage() })
      return
    }

    await micRecorder.start()
  } catch {
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
  }
}

async function stopVoiceCapture() {
  const captureId = voiceDialogue.activeCaptureId.value
  if (!captureId) return

  if (activeVoiceCaptureMode.value === 'browser') {
    let transcript = ''

    try {
      transcript = await browserRecognition.stop()
    } catch {
      activeVoiceCaptureMode.value = null
      voiceDialogue.cancelCapture(captureId)
      return
    }

    activeVoiceCaptureMode.value = null

    try {
      await voiceDialogue.commitTranscript(captureId, transcript)
    } catch {
      // Voice dialogue state already tracks send errors.
    }
    return
  }

  if (micRecorder.state.value.status === 'requesting') {
    micRecorder.cancel()
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
    return
  }

  let audio: Blob

  try {
    audio = await micRecorder.stop()
  } catch {
    activeVoiceCaptureMode.value = null
    voiceDialogue.cancelCapture(captureId)
    return
  }

  activeVoiceCaptureMode.value = null

  if (audio.size <= 0) {
    voiceDialogue.cancelCapture(captureId)
    return
  }

  try {
    await voiceDialogue.transcribeAndSend(captureId, audio)
  } catch {
    // Voice dialogue state already tracks transcription/send errors.
  }
}

function cancelVoiceCapture() {
  if (activeVoiceCaptureMode.value === 'browser') {
    browserRecognition.cancel()
  } else {
    micRecorder.cancel()
  }

  activeVoiceCaptureMode.value = null
  voiceDialogue.cancelCapture()
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  requestAnimationFrame(() => {
    isComposing.value = false
    updateSlashState()
  })
}

function isImeEnter(e: KeyboardEvent): boolean {
  return isComposing.value || e.isComposing || e.keyCode === 229
}

function handleKeydown(e: KeyboardEvent) {
  if (slashActive.value && filteredBridgeCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value + 1) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value - 1 + filteredBridgeCommands.value.length) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectBridgeCommand(filteredBridgeCommands.value[slashActiveIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashActive.value = false
      slashDismissed = true  // don't let the async command load reopen it
      return
    }
  }

  if (e.key !== 'Enter' || e.shiftKey) return
  if (isImeEnter(e)) return

  e.preventDefault()
  handleSend()
}

function handleInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  if (!isComposing.value) updateSlashState()
  // 用户手动拖拽自定义高度时，不覆盖
  if (textareaHeight.value !== null || !isMobileInput.value) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

function handleCommandHover(index: number) {
  slashActiveIndex.value = index
}

function onDocumentMousedown(e: MouseEvent) {
  if (!slashActive.value) return
  const target = e.target as HTMLElement
  if (!target.closest('.slash-command-dropdown') && !target.closest('.input-wrapper')) {
    slashActive.value = false
  }
}

function focusComposer() {
  if (isMobileInput.value) return
  void nextTick(() => textareaRef.value?.focus())
}

defineExpose({ focusComposer })

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
})

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx !== -1) {
    if (previewAttachment.value?.id === id) previewAttachment.value = null
    URL.revokeObjectURL(attachments.value[idx].url)
    attachments.value.splice(idx, 1)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isImage(type: string): boolean {
  return type.startsWith('image/')
}

function openAttachmentPreview(attachment: Attachment) {
  if (!isImage(attachment.type)) return
  previewAttachment.value = attachment
}
</script>

<template>
  <div class="chat-input-area">
    <!-- Top bar: attach + auto play speech + context info -->
    <div class="input-top-bar">
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton :aria-label="t('chat.attachFiles')" quaternary size="tiny" @click="handleAttachClick" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </template>
          </NButton>
        </template>
        {{ t('chat.attachFiles') }}
      </NTooltip>

      <NPopover
        v-if="!isCodingAgentSession"
        trigger="click"
        placement="top-start"
      >
        <template #trigger>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton
                quaternary
                size="tiny"
                circle
                class="reasoning-effort-button"
                :class="{ active: !!currentReasoningEffort }"
                :style="reasoningEffortAccentStyle"
                :aria-label="`${t('chat.reasoningEffort.tooltip')}: ${reasoningEffortLabel}`"
              >
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.reasoningEffort.tooltip') }}: {{ reasoningEffortLabel }}
          </NTooltip>
        </template>

        <div class="reasoning-effort-slider-popover" :style="reasoningEffortAccentStyle">
          <div class="reasoning-effort-slider-heading">
            <span>{{ t('chat.reasoningEffort.tooltip') }}</span>
            <strong>{{ reasoningEffortLabel }}</strong>
          </div>
          <NSlider
            class="reasoning-effort-slider"
            :class="{ 'reasoning-effort-slider--max': currentReasoningEffort === 'max' }"
            :value="reasoningEffortSliderValue"
            :min="0"
            :max="reasoningEffortOptions.length - 1"
            :step="1"
            :format-tooltip="reasoningEffortSliderLabel"
            @update:value="onReasoningEffortSliderChange"
          />
          <div class="reasoning-effort-slider-range" aria-hidden="true">
            <span>{{ reasoningEffortOptions[0].label }}</span>
            <span>{{ reasoningEffortOptions[reasoningEffortOptions.length - 1].label }}</span>
          </div>
          <div class="reasoning-effort-slider-hint">
            {{ t('chat.reasoningEffort.dragHint', { count: reasoningEffortOptions.length }) }}
          </div>
        </div>
      </NPopover>

      <NPopselect
        v-if="experts.length > 0"
        :value="activeExpertId || ''"
        :options="expertOptions"
        :disabled="expertSelectionLocked"
        trigger="click"
        @update:value="onExpertChange"
      >
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              quaternary
              size="tiny"
              class="expert-slot-button"
              :class="{ active: !!activeExpertId }"
              :disabled="expertSelectionLocked"
              :aria-label="expertSlotHint"
            >
              <template #icon>
                <span v-if="activeExpertId && activeExpertAvatar" class="expert-slot-avatar">
                  <img :src="activeExpertAvatar" :alt="activeExpertLabel" @error="activeExpertAvatarBroken = true" />
                </span>
                <span v-else-if="activeExpertId" class="expert-slot-avatar fallback">{{ activeExpertInitial }}</span>
                <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M19 8v6M22 11h-6"/>
                </svg>
              </template>
              <span v-if="activeExpertId" class="expert-slot-label">{{ activeExpertLabel }}</span>
            </NButton>
          </template>
          {{ expertSlotHint }}
        </NTooltip>
      </NPopselect>

      <ChatScheduledEntry
        v-if="scheduledExpert"
        :session-id="chatStore.activeSession!.id"
        :expert-id="scheduledExpert.id"
        :expert-label="scheduledExpert.title || scheduledExpert.name"
        :initial-name="chatStore.activeSession!.title"
        :initial-prompt="inputText"
        :initial-skills="scheduledExpert.skills || []"
      />

      <div class="auto-play-speech-switch">
        <NTooltip trigger="hover">
          <template #trigger>
            <div class="switch-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
          </template>
          {{ t('chat.autoPlaySpeech') }}
        </NTooltip>
        <NSwitch
          size="small"
          v-model:value="autoPlaySpeech"
          :round="false"
        />
      </div>

      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            quaternary
            size="tiny"
            class="tool-trace-toggle"
            :class="{ active: toolTraceVisible }"
            :aria-label="toolTraceVisible ? t('chat.hideToolCalls') : t('chat.showToolCalls')"
            @click="toggleToolTraceVisible"
          >
            <svg class="tool-trace-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a4.5 4.5 0 0 0-5.8 5.8L3.5 17.5a2.1 2.1 0 0 0 3 3l5.4-5.4a4.5 4.5 0 0 0 5.8-5.8l-3 3-3-3 3-3z"/>
            </svg>
          </NButton>
        </template>
        {{ toolTraceVisible ? t('chat.hideToolCalls') : t('chat.showToolCalls') }}
      </NTooltip>

      <span v-if="showContextUsage" class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
        {{ formatTokens(totalTokens) }} /
        <NTooltip trigger="hover">
          <template #trigger>
            <span class="context-limit-editable" @click="handleEditContextLimit">
              {{ formatTokens(contextLength) }}
            </span>
          </template>
          <span>{{ t('chat.contextClickToEdit') }}</span>
        </NTooltip>
        · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
      </span>
      <div v-if="showContextUsage" class="context-bar">
        <div
          class="context-bar-fill"
          :class="{
            'context-bar-warn': usagePercent > 60 && usagePercent <= 80,
            'context-bar-danger': usagePercent > 80,
          }"
          :style="{ width: `${usagePercent}%` }"
        />
      </div>
    </div>

    <!-- Attachment previews -->
    <div v-if="attachments.length > 0" class="attachment-previews">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="attachment-preview"
        :class="{ image: isImage(att.type) }"
      >
        <template v-if="isImage(att.type)">
          <button
            type="button"
            class="attachment-thumb-button"
            :aria-label="att.name"
            @click="openAttachmentPreview(att)"
          >
            <img :src="att.url" :alt="att.name" class="attachment-thumb" />
          </button>
        </template>
        <template v-else>
          <div class="attachment-file">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ att.name }}</span>
            <span class="file-size">{{ formatSize(att.size) }}</span>
          </div>
        </template>
        <button class="attachment-remove" @click="removeAttachment(att.id)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <ImagePreviewOverlay
      v-if="previewAttachment"
      :src="previewAttachment.url"
      :alt="previewAttachment.name"
      @close="previewAttachment = null"
    />

    <div
      ref="inputWrapperRef"
      class="input-wrapper"
      :class="{ 'drag-over': isDragging }"
      :style="inputWrapperStyle"
      @dragover="handleDragOver"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileChange"
      />
      <div class="resize-handle" @mousedown="startResize"></div>
      <div v-if="linkPreviews.length" class="feishu-link-previews">
        <div v-for="preview in linkPreviews" :key="preview.url" class="input-feishu-link-preview">
          <FeishuLinkPreviewCard class="feishu-link-preview" :preview="preview" compact />
          <button type="button" class="input-feishu-link-preview__remove" aria-label="移除链接" @click="removeLinkPreview(preview.url)">×</button>
        </div>
      </div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        :style="inputTextareaStyle"
        :placeholder="t('chat.inputPlaceholder')"
        rows="1"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @input="handleInput"
        @paste="handlePaste"
      ></textarea>
      <Transition name="dropdown-fade">
        <div
          v-if="slashActive && filteredBridgeCommands.length > 0"
          ref="commandDropdownRef"
          class="slash-command-dropdown"
        >
          <div
            v-for="(command, i) in filteredBridgeCommands"
            :key="command.key"
            class="slash-command-item"
            :class="{ active: i === slashActiveIndex }"
            @mousedown.prevent="selectBridgeCommand(command)"
            @mouseenter="handleCommandHover(i)"
          >
            <span class="slash-command-name">/{{ command.name }}</span>
            <span v-if="command.args" class="slash-command-args">{{ command.args }}</span>
            <span class="slash-command-desc">{{ command.description }}</span>
          </div>
        </div>
      </Transition>
      <div class="input-actions">
        <CoworkProjectPicker
          v-if="canPickProject"
          v-model="activeProject"
          :frozen="projectSelectionLocked"
        />
        <AgentPicker v-if="canPickAgent" class="agent-picker-slot" />
        <VoiceDialogueControls
          :status="voiceDialogue.status.value"
          :transcript="voiceDialogueTranscript"
          :error="voiceDialogueError"
          :events="voiceDialogue.events.value"
          :on-start="startVoiceCapture"
          :on-stop="stopVoiceCapture"
          :on-cancel="cancelVoiceCapture"
        />
        <NButton
          v-if="chatStore.isStreaming"
          size="small"
          type="error"
          :disabled="chatStore.isAborting"
          @click="chatStore.stopStreaming()"
        >
          {{ t('chat.stop') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!canSend"
          @click="handleSend"
        >
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </template>
          {{ t('chat.send') }}
        </NButton>
      </div>
    </div>

    <NModal
      v-model:show="showSkillPicker"
      :title="t('skills.title')"
      :mask-closable="true"
      preset="card"
      style="width: min(620px, calc(100vw - 32px))"
    >
      <div v-if="showSkillPicker" class="skill-picker-modal">
        <input
          v-model="skillSearch"
          class="skill-picker-search"
          :placeholder="t('skills.searchPlaceholder')"
          type="search"
        />
        <div class="skill-picker-list">
          <div v-if="skillPickerLoading" class="skill-picker-empty">
            {{ t('common.loading') }}
          </div>
          <template v-else>
            <button
              v-for="skill in filteredSkillPickerItems"
              :key="skill.key"
              type="button"
              class="skill-picker-item"
              @click="selectSkill(skill)"
            >
              <span class="skill-picker-command">/skill {{ skill.commandName }}</span>
              <span class="skill-picker-name">{{ skill.name }}</span>
              <span class="skill-picker-desc">{{ skill.description }}</span>
            </button>
          </template>
          <div v-if="!skillPickerLoading && filteredSkillPickerItems.length === 0" class="skill-picker-empty">
            {{ skillSearch ? t('skills.noMatch') : t('skills.noSkills') }}
          </div>
        </div>
      </div>
    </NModal>

    <!-- Context Length Edit Modal -->
    <NModal
      v-model:show="showContextEditModal"
      :title="t('chat.contextEditTitle')"
      :mask-closable="true"
      preset="card"
      style="width: 400px"
    >
      <div class="context-edit-content">
        <p style="margin-bottom: 16px; color: #666;">
          {{ t('chat.contextEditDesc') }}
        </p>
        <NInputNumber
          v-model:value="editingContextLimit"
          :min="1000"
          :max="10000000"
          :step="1000"
          :show-button="false"
          :placeholder="t('chat.contextEditPlaceholder')"
          style="width: 100%"
        >
          <template #suffix>
            <span style="color: #999;">tokens</span>
          </template>
        </NInputNumber>
        <div style="margin-top: 12px; font-size: 12px; color: #999;">
          {{ t('chat.contextEditHint') }}
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <NButton @click="showContextEditModal = false" :disabled="isSavingContextLimit">
            {{ t('chat.contextEditCancel') }}
          </NButton>
          <NButton type="primary" @click="saveContextLimit" :loading="isSavingContextLimit">
            {{ t('chat.contextEditSave') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-input-area {
  padding: 12px 20px 16px;
  border-top: 1px solid $border-color;
  flex-shrink: 0;
}

.input-top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px;
}

.auto-play-speech-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 0 8px;
  border-left: 1px solid $border-light;
  margin-left: 4px;

  .switch-label {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: #999999;
    font-size: 12px;

    svg {
      opacity: 1;
    }
  }

  :deep(.n-switch),
  :deep(.n-switch__rail) {
    margin-right: 0;
  }
}

.tool-trace-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #999999;
  width: 24px;
  min-width: 24px;
  height: 22px;
  margin-left: -4px;
  padding: 0;
  background: transparent !important;
  opacity: 1;

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }

  .tool-trace-icon {
    display: block;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
  }

  &.active {
    color: #999999;
    opacity: 1;
  }

  &:hover {
    color: #999999;
    opacity: 1;
  }
}

.reasoning-effort-button {
  &.active {
    color: var(--reasoning-effort-accent-color);
  }
}

.reasoning-effort-slider-popover {
  width: min(320px, calc(100vw - 64px));
  padding: 4px 2px 2px;
}

.reasoning-effort-slider-heading,
.reasoning-effort-slider-range {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.reasoning-effort-slider-heading {
  margin-bottom: 10px;
  color: $text-secondary;
  font-size: 12px;

  strong {
    color: var(--reasoning-effort-accent-color);
    font-weight: 600;
  }
}

.reasoning-effort-slider {
  --n-handle-size: 24px !important;
  --n-rail-height: 10px !important;
  --reasoning-effort-gradient-width: min(314px, calc(100vw - 70px));
  margin: 0 3px;

  :deep(.n-slider-rail__fill) {
    background: linear-gradient(
      90deg,
      #38bdf8 0%,
      #22d3ee 20%,
      #34d399 40%,
      #facc15 62%,
      #fb923c 82%,
      #ef4444 100%
    );
    background-position: left center;
    background-repeat: no-repeat;
    // Pinning the gradient to the FULL rail width keeps every stop on the same
    // colour: sized to the fill it would restart at each position.
    background-size: var(--reasoning-effort-gradient-width) 100%;
  }
}

// Top stop only: the handle turns into a moving liquid-metal bead so "max"
// reads as the end of the scale rather than one more notch.
.reasoning-effort-slider--max {
  :deep(.n-slider-handle) {
    position: relative;
    overflow: hidden;
    isolation: isolate;
    border-radius: 50%;
    background:
      radial-gradient(circle at 24% 24%, #38bdf8 0 14%, transparent 34%),
      radial-gradient(circle at 78% 22%, #facc15 0 15%, transparent 36%),
      radial-gradient(circle at 78% 78%, #ef4444 0 16%, transparent 38%),
      radial-gradient(circle at 22% 76%, #34d399 0 15%, transparent 36%),
      conic-gradient(from 30deg, #22d3ee, #34d399, #facc15, #fb923c, #ef4444, #a855f7, #38bdf8, #22d3ee);
    background-size: 150% 150%, 145% 145%, 155% 155%, 145% 145%, 180% 180%;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.38),
      0 0 12px rgba(239, 68, 68, 0.46),
      0 3px 9px rgba(24, 18, 44, 0.44);
    animation: reasoning-effort-max-liquid 3.6s ease-in-out infinite;
  }

  :deep(.n-slider-handle::after) {
    content: '';
    position: absolute;
    inset: 2px 5px 11px 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.5);
    filter: blur(1px);
    animation: reasoning-effort-max-highlight 2.8s ease-in-out infinite;
  }
}

@keyframes reasoning-effort-max-liquid {
  0%, 100% {
    background-position: 0% 20%, 100% 0%, 100% 100%, 0% 100%, 50% 50%;
    background-size: 150% 150%, 145% 145%, 155% 155%, 145% 145%, 180% 180%;
  }

  33% {
    background-position: 65% 0%, 55% 70%, 30% 100%, 0% 35%, 100% 35%;
    background-size: 175% 135%, 135% 175%, 165% 140%, 140% 165%, 210% 170%;
  }

  66% {
    background-position: 100% 70%, 20% 100%, 0% 35%, 75% 0%, 0% 70%;
    background-size: 135% 175%, 170% 140%, 140% 170%, 170% 135%, 170% 210%;
  }
}

@keyframes reasoning-effort-max-highlight {
  0%, 100% {
    opacity: 0.72;
    transform: translate(-1px, -1px) rotate(0deg);
  }

  50% {
    opacity: 0.42;
    transform: translate(3px, 2px) rotate(180deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning-effort-slider--max {
    :deep(.n-slider-handle),
    :deep(.n-slider-handle::after) {
      animation: none;
    }
  }
}

.reasoning-effort-slider-range {
  margin-top: 4px;
  color: $text-muted;
  font-size: 10px;
}

.reasoning-effort-slider-hint {
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
  text-align: center;
}

.expert-slot-button {
  min-width: 24px;

  &.active {
    color: $accent-primary;
  }
}

.expert-slot-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  overflow: hidden;
  background: $bg-card;
  border: 1px solid $border-color;
  color: $text-primary;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  &.fallback {
    background: $bg-primary;
  }
}

.expert-slot-label {
  margin-left: 4px;
  font-size: 11px;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-info {
  font-size: 11px;
  color: $text-muted;
  min-width: 0;
  white-space: nowrap;

  &.context-warning {
    color: #e8a735;
  }
}

.context-limit-editable {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: all 0.2s ease;
  padding: 0 2px;

  &:hover {
    border-bottom-color: $text-muted;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 2px;
  }
}

.context-bar {
  width: 60px;
  height: 4px;
  margin-left: -4px;
  background: rgba(128, 128, 128, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(128, 128, 128, 0.3), rgba(128, 128, 128, 0.6));
  border-radius: 2px;
  transition: width 0.3s ease;

  &.context-bar-warn {
    background: linear-gradient(90deg, #c98a1a, #e8a735);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #c43a2a, #e85d4a);
  }
}

@media (max-width: 768px) {
  .input-top-bar {
    gap: 5px;
  }

  .context-info {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10px;
    line-height: 14px;
    margin-right: 10px;
  }

  .context-bar {
    width: 42px;
    flex-shrink: 0;
  }
}

.attachment-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 10px;
}

.feishu-link-previews {
  display: flex;
  flex: 1 0 100%;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.attachment-preview {
  position: relative;
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: $bg-secondary;
  border: 1px solid $border-color;

  &.image {
    width: 112px;
    height: 72px;
  }
}

.attachment-thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.attachment-thumb-button {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background:
    linear-gradient(45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%);
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
  background-size: 12px 12px;
  cursor: zoom-in;
}

.attachment-file {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 12px;
  min-width: 80px;
  max-width: 140px;
  color: $text-secondary;

  .file-name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .file-size {
    font-size: 10px;
    color: $text-muted;
  }
}

.attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-on-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity $transition-fast;

  .attachment-preview:hover & {
    opacity: 1;
  }
}

.file-input-hidden {
  display: none;
}

.input-wrapper {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  background-color: $bg-input;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 10px 12px;
  position: relative;
  transition: border-color $transition-fast, background-color $transition-fast;

  &:focus-within {
    border-color: $accent-primary;
  }

  .dark & {
    background-color: #333333;
  }
}

.resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 2;

  &:hover {
    background: rgba($accent-primary, 0.15);
    border-radius: 4px;
  }
}

.input-textarea {
  flex: 1;
  box-sizing: border-box;
  background: none;
  border: none;
  outline: none;
  color: $text-primary;
  font-family: $font-ui;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  max-height: 400px;
  min-height: 20px;
  overflow-y: auto;

  @media (max-width: 768px) {
    font-size: 16px;
  }

  &::placeholder {
    color: $text-muted;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.input-feishu-link-preview {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.input-feishu-link-preview__remove {
  flex: 0 0 auto;
  border: 0;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}

.agent-picker-slot {
  margin-right: auto;
}

.input-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

.slash-command-dropdown {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  max-height: 240px;
  overflow-y: auto;
  background: $bg-primary;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  z-index: 20;
  padding: 4px;

  .dark & {
    background: #2a2a2a;
  }
}

.slash-command-item {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  cursor: pointer;
  min-height: 36px;

  &.active,
  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }

}

.slash-command-name {
  font-family: $font-code;
  font-size: 13px;
  color: $accent-primary;
  white-space: nowrap;
}

.slash-command-args {
  font-family: $font-code;
  font-size: 12px;
  color: $text-muted;
  white-space: nowrap;
}

.slash-command-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  font-size: 12px;
}

.skill-picker-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-picker-search {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  outline: none;
  font-family: $font-ui;
  font-size: 13px;

  &:focus {
    border-color: $accent-primary;
  }
}

.skill-picker-list {
  max-height: min(420px, 52vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-picker-item {
  display: grid;
  grid-template-columns: minmax(160px, auto) minmax(120px, 0.6fr) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  padding: 8px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  color: $text-primary;
  text-align: left;
  cursor: pointer;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.5);
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.skill-picker-command {
  font-family: $font-code;
  font-size: 12px;
  color: $accent-primary;
  white-space: nowrap;
}

.skill-picker-name,
.skill-picker-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-picker-name {
  font-size: 13px;
  color: $text-primary;
}

.skill-picker-desc {
  font-size: 12px;
  color: $text-secondary;
}

.skill-picker-empty {
  padding: 18px 10px;
  text-align: center;
  color: $text-muted;
  font-size: 13px;
}

@media (max-width: 768px) {
  .skill-picker-item {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

// Drag-over state
.input-wrapper.drag-over {
  border-color: var(--accent-info);
  border-style: dashed;
  background-color: rgba(var(--accent-info-rgb), 0.04);
}
</style>
