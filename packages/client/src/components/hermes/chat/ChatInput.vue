<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { fetchContextLength } from '@/api/hermes/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { fetchSkills, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'
import { fetchExperts, type ExpertInfo } from '@/api/hermes/experts'
import { fetchSlashCommands, type SlashCommand } from '@/api/hermes/slash'
import { isStoredSuperAdmin } from '@/api/client'
import { NButton, NTooltip, NModal, NInputNumber, NPopselect, NPopover } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import VoiceDialogueControls from './VoiceDialogueControls.vue'
import AgentPicker from '@/components/hermes/agents/AgentPicker.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import ComposerBox from './ComposerBox.vue'
import ChatScheduledEntry from './ChatScheduledEntry.vue'
import { useMicRecorder } from '@/composables/useMicRecorder'
import { useNet } from '@/composables/useNet'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceDialogue } from '@/composables/useVoiceDialogue'
import { transcribeSpeech } from '@/api/hermes/stt'
import type { StoredSttProvider } from '@/api/hermes/stt-settings'
import { useSttSettings } from '@/composables/useSttSettings'
import { useBrowserSpeechRecognition } from '@/composables/useBrowserSpeechRecognition'
import { CHAT_INPUT_HEIGHT_MOBILE_QUERY, chatInputHeightStyle, clampChatInputHeight } from '@/utils/chat-input-height'
import { useComposerPrefill } from '@/composables/useComposerPrefill'

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const { t } = useI18n()
const router = useRouter()
// Named `netOnline` rather than destructured as `online` — this file already has
// plenty of short flags and a bare `online` reads ambiguously next to them.
const { online: netOnline } = useNet()

// The "+" AddMenu (prototype): a two-level hover menu. Level 1 = 添加文件 /
// 专家 / 技能 / 连接器; hovering the latter three fans out a right-side flyout
// listing real items, with a "manage" footer that jumps to the full surface.
// Defined further down (after experts/skills state) so the flyout can read
// live data — see `openAddMenu` and friends below `loadSlashCommands`.
const showAddMenu = ref(false)
const isSuperAdmin = computed(() => isStoredSuperAdmin())

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
const expertSelectionLocked = computed(() => Boolean(chatStore.activeSession?.expertId))
const scheduledExpert = computed(() => {
  const session = chatStore.activeSession
  if (!session?.id || !session.expertId || session.source === 'coding_agent' || session.source === 'global_agent') return null
  return activeExpert.value?.id === session.expertId ? activeExpert.value : null
})
function onExpertChange(value: string | null | undefined) {
  if (expertSelectionLocked.value) return
  const expert = experts.value.find(e => e.id === value)
  chatStore.setActiveExpert(value || null, expert ? {
    avatar: expert.avatar || '',
    label: expert.title || expert.name || expert.id,
  } : undefined)
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

// Home starter cards drop their text in here rather than sending it, so the
// user still gets to edit before committing.
const composerPrefill = useComposerPrefill()
watch(composerPrefill, (next) => {
  if (!next) return
  inputText.value = next.text
  void nextTick(() => textareaRef.value?.focus())
})
const inputWrapperRef = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const commandDropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
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

// The composer has two forms in the prototype. On the home screen it is the
// hero: a wide box with the scope pills (agent / project / cloud) along its
// floor. Once a run is under way it becomes the follow-up field — a narrower
// box wrapped in a pill-shaped halo, with the scope row dropped (the scope is
// already fixed by the running task) and a placeholder that invites steering
// rather than starting.
const isRunState = computed(
  () => (chatStore.messages?.length ?? 0) > 0 || !!chatStore.isStreaming,
)

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
// --- "+" AddMenu (prototype two-level hover menu) ---------------------------
const addBtnRef = ref<HTMLElement>()
const addMenuPos = ref<{ left: number; top?: number; bottom?: number } | null>(null)
const activeAddSub = ref<null | 'expert' | 'skill' | 'connector'>(null)

function openAddMenu() {
  if (!showAddMenu.value && addBtnRef.value) {
    const r = addBtnRef.value.getBoundingClientRect()
    const menuH = 260
    const openUp = window.innerHeight - r.bottom < menuH + 16
    addMenuPos.value = openUp
      ? { left: r.left - 4, bottom: window.innerHeight - r.top + 8 }
      : { left: r.left - 4, top: r.bottom + 8 }
  }
  activeAddSub.value = null
  showAddMenu.value = !showAddMenu.value
  // Prefetch what the menu itself shows; the "/" panel loads its own commands
  // when the user starts typing a slash.
  if (showAddMenu.value) void loadSkills()
}

function closeAddMenu() {
  showAddMenu.value = false
  activeAddSub.value = null
}

// Level-1 rows: `file` opens the picker and clears any flyout; the other three
// fan out their right-side sub-list on hover (and on click, matching the
// prototype where either gesture opens the flyout).
function onAddRowEnter(key: 'file' | 'expert' | 'skill' | 'connector') {
  if (key === 'file') {
    activeAddSub.value = null
    return
  }
  activeAddSub.value = key
  if (key === 'skill') void loadSkills()
}

function onAddRowClick(key: 'file' | 'expert' | 'skill' | 'connector') {
  if (key === 'file') {
    closeAddMenu()
    handleAttachClick()
    return
  }
  activeAddSub.value = key
  if (key === 'skill') void loadSkills()
}

const addSubExperts = computed(() => experts.value.slice(0, 8))
// Skills, not slash commands. This used to read `skillSlashCommands` — the
// broker's `/…` registry — so the 技能 flyout listed command descriptions
// ("Clear this profile's broker …") instead of skill names. Broker commands
// are still reachable by typing "/", which is their own surface.
const addSubSkills = computed(() => skillPickerItems.value.slice(0, 8))

// Prototype parity: picking an expert from the "+" menu does NOT stamp the
// session immediately — it becomes a removable pill sitting in the composer
// (same as an attachment) and only takes effect once the message is actually
// sent. This matches the prototype's generic `attachments` model (an expert
// pick is `onAttach({type:"expert", label})`, consumed by `onSend`), while
// the tool-row expert-slot popover keeps its own immediate-apply behavior
// (a different, already-shipped path this session doesn't touch).
const pendingExpertPick = ref<{ id: string; label: string } | null>(null)

function pickAddExpert(id: string) {
  const expert = experts.value.find(e => e.id === id)
  pendingExpertPick.value = { id, label: expert?.title || expert?.name || id }
  closeAddMenu()
}

function clearPendingExpertPick() {
  pendingExpertPick.value = null
}

// Skill picks work the same way (prototype: onAttach({type:"skill",...})):
// a removable pill until send, at which point the skill's slash command is
// prepended to the outgoing message (`/name <text>`), i.e. exactly what a
// user typing the command by hand would send.
const pendingSkillPick = ref<{ command: string; label: string } | null>(null)

// The pill echoes the label the user actually clicked (the skill's own name),
// matching the prototype's `onAttach({type:"skill", label})`. The slash
// command still goes out on send — that is `commandName`.
function pickAddSkill(skill: { commandName: string; name: string }) {
  pendingSkillPick.value = {
    command: skill.commandName,
    label: skill.name,
  }
  closeAddMenu()
}

function clearPendingSkillPick() {
  pendingSkillPick.value = null
}

// Home invites a task ("今天帮你做些什么？"), a live run invites a correction
// ("想改就直接说，不用等它做完") — see isRunState.
const composerPlaceholder = computed(() => {
  if (attachments.value.length > 0 || pendingExpertPick.value || pendingSkillPick.value)
    return t('chat.inputPlaceholderAttached')
  return isRunState.value ? t('chat.inputPlaceholderRun') : t('chat.inputPlaceholder')
})

function openAddSurface(surface: 'expert' | 'skills' | 'connectors') {
  closeAddMenu()
  void router.push({ name: 'hermes.chat', query: { surface } })
}

const skillPickerItems = computed(() => {
  const byName = new Map<string, SkillInfo>()
  for (const category of skillCategories.value) {
    for (const skill of category.skills || []) {
      if (skill.enabled === false) continue
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()]
    .map(skill => {
      const commandName = skillCommandName(skill.name)
      return {
        key: `skill:${commandName}`,
        name: skill.name,
        commandName,
        description: skill.description || skill.name,
      }
    })
    // Same ordering the automation and new-task composers use, so one skill
    // sits in the same place whichever composer you opened.
    .sort((a, b) => a.name.localeCompare(b.name))
})
// Experts as slash entries. The prototype's panel lists what you can hang on
// the task — 连接器 / 专家 / 技能 — not just typed commands, and an expert is
// the one of those three this app can actually attach (a connector is an
// authorization, not something a message carries; picking one would do
// nothing, so it stays out rather than becoming a dead row).
//
// `key` carries the `expert:` prefix the grouping and the picker both read.
const expertSlashEntries = computed<SlashCommandOption[]>(() =>
  experts.value.map(expert => ({
    key: `expert:${expert.id}`,
    name: expert.title || expert.name || expert.id,
    args: '',
    description: expert.tagline || '',
    insertText: '',
  })),
)

const filteredBridgeCommands = computed(() => {
  const query = slashQuery.value.toLowerCase()
  const all = [
    ...bridgeCommands.value,
    ...expertSlashEntries.value,
    ...skillSlashCommands.value,
  ]
  return all.filter(command =>
    command.name.toLowerCase().includes(query)
    || command.insertText?.includes(query)
    || command.description.toLowerCase().includes(query),
  )
})

// Prototype SlashPanel groups its entries under muted captions. Our real data
// has two natural groups — built-in bridge commands and per-profile skill
// commands (`slash:` keys) — rendered in the prototype's visual language.
// Items keep their FLAT index so keyboard navigation stays a single cursor.
// The prototype's slash rows carry a SOLID hue tile with the item's first
// character in white (measured: 30x30, radius 2, --hue-blue ground, white 600
// 13px); only a colourless item falls back to the grey tile + group glyph.
// Market items there ship their own brand colour — the closest stable local
// equivalent is the same name hash the skills wall already uses.
const SLASH_TILE_HUES = ['var(--hue-purple)', 'var(--hue-blue)', 'var(--hue-cyan)']
function slashTileHue(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return SLASH_TILE_HUES[h % SLASH_TILE_HUES.length]
}
function slashTileMark(name: string): string {
  return (name.trim()[0] || '?').toUpperCase()
}
// Bridge commands are the colourless case: they are verbs, not named things.
function slashHasTileMark(command: SlashCommandOption): boolean {
  return !command.key.startsWith('command:')
}

const SLASH_GROUP_META: Record<string, { label: string; icon: string }> = {
  expert: { label: 'chat.slashGroups.experts', icon: 'line_grade_report' },
  slash: { label: 'chat.slashGroups.skills', icon: 'line_menu' },
  command: { label: 'chat.slashGroups.commands', icon: 'line_control' },
}

function slashGroupKey(command: SlashCommandOption): string {
  if (command.key.startsWith('expert:')) return 'expert'
  if (command.key.startsWith('slash:')) return 'slash'
  return 'command'
}

const slashGroups = computed(() => {
  const groups: { label: string; icon: string; items: { command: SlashCommandOption; index: number }[] }[] = []
  filteredBridgeCommands.value.forEach((command, index) => {
    const meta = SLASH_GROUP_META[slashGroupKey(command)]
    const label = t(meta.label)
    let group = groups[groups.length - 1]
    if (!group || group.label !== label) {
      group = { label, icon: meta.icon, items: [] }
      groups.push(group)
    }
    group.items.push({ command, index })
  })
  return groups
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

// No bridge-session guard here: the "+" menu's skill flyout is available in
// every session, the same way the automation and new-task composers load
// skills unconditionally. `openSkillPicker` keeps its own CLI-only check, so
// the `/skill` picker stays bridge-only.
async function loadSkills() {
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

// With an inline pill the textarea shrinks to pill height (28px) so the caret
// lands right after the chip — the wrapper keeps its configured height, so
// picking a command never changes the composer's size.
const hasInlineChips = computed(() => !!(pendingExpertPick.value || pendingSkillPick.value))
const inputWrapperStyle = computed(() => {
  const style = chatInputHeightStyle(settingsStore.display.chat_input_height, textareaHeight.value, isMobileInput.value)
  // Prototype TaskInputBox: the field section is minHeight textarea+40 —
  // 20px above the caret and 20px of floor before the tool row. The wrapper
  // is border-box with a fixed inline height, so the +40 must land here (the
  // run composer instead compresses to its 80px min-height, CSS below).
  if (!isRunState.value && style.height) {
    style.height = `${Number.parseInt(style.height, 10) + 40}px`
  }
  return style
})
const inputTextareaStyle = computed(() => {
  if (isMobileInput.value) return {}
  return hasInlineChips.value ? { height: '28px' } : { height: '100%' }
})

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
  // 如果当前是 auto，用实际 clientHeight 作为起始值。home 态 wrapper 比配置值
  // 多 40px（原型 textarea+40 公式，见 inputWrapperStyle）——起始值要扣回去，
  // 否则第一次拖拽会跳 40px。
  const wrapperExtra = isRunState.value ? 0 : 40
  const startHeight = (inputWrapperRef.value?.clientHeight
    ? inputWrapperRef.value.clientHeight - wrapperExtra
    : el.clientHeight)
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
})

// 监听变化并保存
watch(autoPlaySpeech, (value) => {
  localStorage.setItem('autoPlaySpeech', String(value))
  // 通知 chat store
  chatStore.setAutoPlaySpeech(value)
})

watch(inputText, (value) => {
  saveDraftForActiveSession(value)
})

watch(() => settingsStore.display.chat_input_height, () => {
  textareaHeight.value = null
})

watch(() => chatStore.activeSession?.id, (_newId, oldId) => {
  // Agent swap: the picker replaces the session id underneath us. Anything the
  // user already typed belongs to the task they are composing, not to the old
  // session, so carry it over instead of loading the new session's empty draft.
  if (chatStore.agentSwitching && inputText.value.trim()) {
    const carried = inputText.value
    if (oldId) saveDraftForSession(oldId, '')
    saveDraftForActiveSession(carried)
    return
  }
  loadDraftForActiveSession()
})

watch(
  () => [chatStore.activeSession?.profile, profilesStore.activeProfileName],
  () => {
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
const canSend = computed(() => !chatStore.agentSwitching && (inputText.value.trim() || attachments.value.length > 0 || !!pendingExpertPick.value || !!pendingSkillPick.value))

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
  // Prototype SlashPanel: the panel is open whenever the "/" prefix is live —
  // an unmatched query shows the 没有匹配的结果 empty state, it doesn't close.
  slashActive.value = true
  syncSlashPanelMaxHeight()
}

// Prototype: maxHeight clamps to the space above the composer
// (max(160, min(360, top - 24))) so the panel never runs off-screen.
const slashPanelMaxHeight = ref(360)
function syncSlashPanelMaxHeight() {
  nextTick(() => {
    const wrapper = inputWrapperRef.value
    if (!wrapper) return
    const top = wrapper.getBoundingClientRect().top
    slashPanelMaxHeight.value = Math.max(160, Math.min(360, top - 24))
  })
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
  slashActive.value = true
  syncSlashPanelMaxHeight()
}

function selectBridgeCommand(command: SlashCommandOption) {
  if (command.opensSkillPicker) {
    slashActive.value = false
    void openSkillPicker()
    return
  }
  // An expert becomes the same removable pill the "+" menu produces — it is a
  // who, not a command, so nothing is prepended to the outgoing text.
  if (command.key.startsWith('expert:')) {
    pickAddExpert(command.key.slice('expert:'.length))
    inputText.value = ''
    slashActive.value = false
    nextTick(() => textareaRef.value?.focus())
    return
  }
  // Prototype pickSlash: the pick becomes an attachment pill in the composer
  // and the "/" query is cleared — NOT echoed back as text. Whatever the user
  // types next becomes the command's arguments (handleSend prepends `/name`).
  // The pill echoes the item as it appeared in the menu (`/usage`), like the
  // prototype's name-labelled pills — not the description sentence.
  pendingSkillPick.value = {
    command: command.insertText || command.name,
    label: `/${command.insertText || command.name}`,
  }
  inputText.value = ''
  slashActive.value = false
  nextTick(() => textareaRef.value?.focus())
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
/** Validation and save failure for the context-limit dialog. */
const contextEditError = ref('')
/** Why clicking the placeholder scope pill did nothing. */
const scopeHint = ref('')
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
    contextEditError.value = t('chat.contextEditInvalid')
    return
  }
  contextEditError.value = ''

  isSavingContextLimit.value = true
  try {
    const provider = chatStore.activeSession?.provider || appStore.selectedProvider || ''
    const model = chatStore.activeSession?.model || appStore.selectedModel || ''

    if (!provider || !model) {
      contextEditError.value = t('chat.contextEditFailed')
      return
    }

    await setModelContext(provider, model, editingContextLimit.value)
    contextLength.value = editingContextLimit.value
    contextLengthLoadedKey = currentContextLengthKey()
    // The dialog closes and the usage pill repaints against the new limit.
    showContextEditModal.value = false
  } catch (err: any) {
    contextEditError.value = `${t('chat.contextEditFailed')}: ${err.message || ''}`
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
// Prototype UsagePill is always present (📈 count) — it shows even at rest so
// the "this is what a turn costs" affordance never pops in and out. We only
// hide it for coding-agent sessions, which have no context-token concept.
const showContextUsage = computed(() => !isCodingAgentSession.value)

const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))

// Prototype UsagePill breakdown: 输入/输出 meter bars with the DS accent hues.
const usageParts = computed(() => {
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  const max = Math.max(input, output, 1)
  return [
    { key: 'in', name: t('chat.usagePopover.input'), value: input, pct: Math.round((input / max) * 100), color: 'var(--hue-purple)' },
    { key: 'out', name: t('chat.usagePopover.output'), value: output, pct: Math.round((output / max) * 100), color: 'var(--hue-orange)' },
  ]
})

function openUsageView() {
  void router.push({ name: 'hermes.usage' })
}

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

// --- Paste image ---

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
  let text = inputText.value.trim()
  if (!text && attachments.value.length === 0 && !pendingExpertPick.value && !pendingSkillPick.value) return
  if (isBridgeSession.value && text === '/skill' && attachments.value.length === 0) {
    void openSkillPicker()
    return
  }

  // Commit the pending expert pill to the session now — at send time, not
  // pick time — matching the prototype's attachment model.
  if (pendingExpertPick.value) {
    onExpertChange(pendingExpertPick.value.id)
    pendingExpertPick.value = null
  }

  // A pending skill pill becomes its slash command at the head of the message
  // — exactly what typing `/name <text>` by hand sends.
  if (pendingSkillPick.value) {
    text = `/${pendingSkillPick.value.command}${text ? ` ${text}` : ''}`
    pendingSkillPick.value = null
  }

  chatStore.sendMessage(text, attachments.value.length > 0 ? attachments.value : undefined)
  inputText.value = ''
  saveDraftForActiveSession('')
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
  // Escape closes the panel even when it is showing the no-match empty state.
  if (slashActive.value && e.key === 'Escape') {
    e.preventDefault()
    slashActive.value = false
    slashDismissed = true  // don't let the async command load reopen it
    return
  }
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

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
})

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx !== -1) {
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

// The cloud/local scope pill is still a placeholder — clicking it says so
// rather than pretending to switch anything.
function handleScopePillClick() {
  // Offline, the pill states the cause rather than the coming-soon notice — the
  // reason you can't send is the one thing worth saying at that moment.
  // Shown on the pill's own tooltip-style line under the scope row rather than a
  // toast: it explains why the click did nothing, so it belongs next to the pill
  // that was clicked.
  scopeHint.value = netOnline.value ? t('chat.featureComingSoon') : t('net.cloudUnreachableHint')
}
</script>

<template>
  <!-- The box (frame, section order, insets) is ComposerBox — the same one
       group chat's composer uses, so the two cannot drift apart again. This
       component owns what goes IN the sections. -->
  <ComposerBox :run="isRunState">

    <!-- Scope row: which agent, which workspace, where it runs. Sits inside
         the same rounded box as the field, divided from the tool row by a
         hairline — it describes THIS task, so it belongs to the box rather
         than floating underneath it. Agent comes first (it owns the run),
         then whatever the host passes in (workspace, etc). -->
    <div v-if="!isRunState" class="input-pillbar">
      <AgentPicker v-if="canPickAgent" class="agent-picker-slot" />
      <span v-if="canPickAgent" class="input-pillbar__sep" />

      <!-- Where it runs. The project pill that used to sit here went with the
           projects feature itself. -->
      <!--
        Losing the network is said HERE, not in a banner. This pill already
        answers "where does this task run", so when the cloud is unreachable it is
        the control that should speak — and unlike a banner it also explains the
        consequence (your message can't go out because the cloud is unreachable).

        ⚠️ Only the icon and the text colour change; NO red background. Tinting the
        ground turns a clickable selector into a warning block, and it is still a
        selector.

        The prototype gates this on `offline && scope === "cloud"` so that a user
        who has switched to local isn't still shown a wifi icon for a problem they
        already solved. Here the pill is always cloud — Hermes has no local
        execution mode — so plain `offline` is the same condition.
      -->
      <button
        type="button"
        class="composer-scope-pill"
        :class="{ 'is-offline': !netOnline }"
        @click="handleScopePillClick"
      >
        <KpIcon :name="netOnline ? 'line_weather_cloudy' : 'line_wifi_level1'" :size="14" />
        <span>{{ netOnline ? t('chat.cloudScope') : t('net.offline') }}</span>
        <KpIcon name="line_down" :size="10" class="composer-scope-pill__caret" />
      </button>

      <span v-if="$slots.pillbar" class="input-pillbar__sep" />
      <slot name="pillbar" />
    </div>

    <!-- Why the placeholder scope pill did nothing. Next to the pill that was
         clicked, and dismissible rather than timed. -->
    <p v-if="scopeHint" class="scope-hint" data-testid="scope-hint">
      <span class="scope-hint__text">{{ scopeHint }}</span>
      <button type="button" class="scope-hint__close" :title="t('common.close')" @click="scopeHint = ''">&times;</button>
    </p>

    <!-- Tool row. Ordered below the textarea (see the `order` rules in the
         style block) so it reads as the floor of the box rather than a strip
         above it — attach on the left, usage / model / voice on the right. -->
    <div class="input-top-bar">
      <!-- Attach sits alone on the far left. The "+" opens a two-level AddMenu
           (prototype): add a file, or fan out expert/skill/connector flyouts. -->
      <span ref="addBtnRef" class="add-menu-anchor">
        <NButton
          class="attach-button"
          :class="{ active: showAddMenu }"
          quaternary
          size="tiny"
          circle
          :title="t('chat.addMenu')"
          @click="openAddMenu"
        >
          <template #icon>
            <!-- Prototype AddMenu is a plus, not a paperclip. -->
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
        </NButton>
      </span>

      <Teleport to="body">
        <template v-if="showAddMenu && addMenuPos">
          <div class="add-menu-overlay" @click="closeAddMenu" />
          <!-- Level 1 -->
          <div
            class="add-menu"
            :style="{
              left: `${addMenuPos.left}px`,
              top: addMenuPos.top != null ? `${addMenuPos.top}px` : undefined,
              bottom: addMenuPos.bottom != null ? `${addMenuPos.bottom}px` : undefined,
            }"
          >
            <div class="add-menu__row" @mouseenter="onAddRowEnter('file')" @click="onAddRowClick('file')">
              <KpIcon class="add-menu__icon" name="line_link" :size="16" />
              <span class="add-menu__label">{{ t('chat.attachFiles') }}</span>
            </div>
            <div
              class="add-menu__row"
              :class="{ active: activeAddSub === 'expert' }"
              @mouseenter="onAddRowEnter('expert')"
              @click="onAddRowClick('expert')"
            >
              <KpIcon class="add-menu__icon" name="line_grade_report" :size="16" />
              <span class="add-menu__label">{{ t('sidebar.expert') }}</span>
              <KpIcon class="add-menu__caret" name="line_arrow_right" :size="12" />
            </div>
            <div
              class="add-menu__row"
              :class="{ active: activeAddSub === 'skill' }"
              @mouseenter="onAddRowEnter('skill')"
              @click="onAddRowClick('skill')"
            >
              <KpIcon class="add-menu__icon" name="line_menu" :size="16" />
              <span class="add-menu__label">{{ t('sidebar.skills') }}</span>
              <KpIcon class="add-menu__caret" name="line_arrow_right" :size="12" />
            </div>
            <div
              class="add-menu__row"
              :class="{ active: activeAddSub === 'connector' }"
              @mouseenter="onAddRowEnter('connector')"
              @click="onAddRowClick('connector')"
            >
              <KpIcon class="add-menu__icon" name="full_link" :size="16" />
              <span class="add-menu__label">{{ t('sidebar.connectors') }}</span>
              <KpIcon class="add-menu__caret" name="line_arrow_right" :size="12" />
            </div>
          </div>

          <!-- Level 2 flyout -->
          <div
            v-if="activeAddSub"
            class="add-menu add-menu--sub"
            :style="{
              left: `${addMenuPos.left + 216}px`,
              top: addMenuPos.top != null ? `${addMenuPos.top}px` : undefined,
              bottom: addMenuPos.bottom != null ? `${addMenuPos.bottom}px` : undefined,
            }"
          >
            <template v-if="activeAddSub === 'expert'">
              <div v-for="e in addSubExperts" :key="e.id" class="add-menu__row" @click="pickAddExpert(e.id)">
                <span class="add-menu__label add-menu__label--ellipsis">{{ e.title || e.name }}</span>
              </div>
              <div class="add-menu__row add-menu__more" @click="openAddSurface('expert')">
                <KpIcon class="add-menu__more-arrow" name="line_arrow_right" :size="12" />
                <span>{{ t('chat.addMore.expert') }}</span>
              </div>
            </template>
            <template v-else-if="activeAddSub === 'skill'">
              <div v-for="s in addSubSkills" :key="s.key" class="add-menu__row" @click="pickAddSkill(s)">
                <span class="add-menu__label add-menu__label--ellipsis" :title="s.description">{{ s.name }}</span>
              </div>
              <div class="add-menu__row add-menu__more" @click="openAddSurface('skills')">
                <KpIcon class="add-menu__more-arrow" name="line_arrow_right" :size="12" />
                <span>{{ t('chat.addMore.skill') }}</span>
              </div>
            </template>
            <template v-else>
              <div class="add-menu__row add-menu__more" @click="openAddSurface('connectors')">
                <KpIcon class="add-menu__more-arrow" name="line_arrow_right" :size="12" />
                <span>{{ t('chat.addMore.connector') }}</span>
              </div>
            </template>
          </div>
        </template>
      </Teleport>

      <!-- Flexible spacer: everything after it clusters at the right edge,
           regardless of which of the optional right-group items render. -->
      <span class="tool-row-spacer" />

      <!-- Usage: a compact chart pill (prototype UsagePill = 📈 count). The
           used / limit / remaining detail lives in the tooltip; clicking the
           pill edits the context limit (kept from the old inline control). -->
      <!-- Usage pill → breakdown popover on click (prototype UsagePill):
           big total, input/output meter bars, then footer rows. The old
           click-to-edit-limit action moved into a footer row. -->
      <NPopover v-if="showContextUsage" trigger="click" placement="top-end" raw :show-arrow="false">
        <template #trigger>
          <button
            type="button"
            class="context-info"
            :class="{ 'context-warning': usagePercent > 80 }"
          >
            <KpIcon name="line_chart" :size="14" />
            <span class="context-info__count">{{ formatTokens(totalTokens) }}</span>
          </button>
        </template>
        <div class="usage-popover">
          <div class="usage-popover__caption">{{ t('chat.usagePopover.title') }}</div>
          <div class="usage-popover__total">
            <span class="usage-popover__total-num">{{ formatTokens(totalTokens) }}</span>
            <span class="usage-popover__total-unit">tokens</span>
          </div>
          <div class="usage-popover__meta">
            {{ t('chat.usagePopover.limit') }} {{ formatTokens(contextLength) }}
            · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
          </div>
          <div v-for="part in usageParts" :key="part.key" class="usage-popover__part">
            <div class="usage-popover__part-head">
              <span class="usage-popover__part-dot" :style="{ background: part.color }" />
              <span class="usage-popover__part-name">{{ part.name }}</span>
              <span class="usage-popover__part-value">{{ formatTokens(part.value) }}</span>
            </div>
            <div class="usage-popover__part-track">
              <div class="usage-popover__part-fill" :style="{ width: `${part.pct}%`, background: part.color }" />
            </div>
          </div>
          <div class="usage-popover__divider" />
          <button type="button" class="usage-popover__row" @click="openUsageView">
            <span>{{ t('chat.usagePopover.history') }}</span>
            <KpIcon name="line_arrow_right" :size="12" />
          </button>
          <button type="button" class="usage-popover__row" @click="handleEditContextLimit">
            <span>{{ t('chat.usagePopover.setLimit') }}</span>
            <KpIcon name="line_arrow_right" :size="12" />
          </button>
        </div>
      </NPopover>

      <!-- Model picker trigger. Injected by the host (ChatPanel) so the model
           selection logic/store stays there; the composer only owns placement:
           right cluster, immediately after usage and before the effort/mic/send
           controls (see prototype: usage · model · mic · send). -->
      <slot name="model" />

      <!-- Reasoning effort now lives inside the model-selection modal (folded
           into the composer's model pill by the host), so a single pill opens
           one menu covering both model AND effort. See ChatPanel.vue. -->

      <!-- Expert slot. -->
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
              :aria-label="`${t('chat.expertSlot.tooltip')}: ${activeExpertLabel || t('chat.expertSlot.none')}`"
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
          {{ t('chat.expertSlot.tooltip') }}: {{ activeExpertLabel || t('chat.expertSlot.none') }}
        </NTooltip>
      </NPopselect>

      <!-- The overflow "⋯" menu (auto-play speech + tool-trace toggles) was
           removed to match the prototype; both toggles now live in
           设置 → 显示 (DisplaySettings). -->

      <!-- Mic + stop + send close out the right group. -->
      <div class="input-actions">
        <VoiceDialogueControls
          :status="voiceDialogue.status.value"
          :transcript="voiceDialogueTranscript"
          :error="voiceDialogueError"
          :events="voiceDialogue.events.value"
          :on-start="startVoiceCapture"
          :on-stop="stopVoiceCapture"
          :on-cancel="cancelVoiceCapture"
        />
        <!-- Compact round send, icon-only (prototype). While a run is
             streaming the SAME circle turns into the stop control (gray-33
             ground, ✕ glyph) instead of a separate labelled button. -->
        <NButton
          v-if="chatStore.isStreaming"
          class="send-button is-running"
          size="small"
          circle
          :disabled="chatStore.isAborting"
          :aria-label="t('chat.stop')"
          :title="t('chat.stop')"
          @click="chatStore.stopStreaming()"
        >
          <template #icon>
            <KpIcon name="full_close" :size="16" />
          </template>
        </NButton>
        <NButton
          v-else
          class="send-button"
          size="small"
          type="primary"
          circle
          :disabled="!canSend"
          :aria-label="t('chat.send')"
          :title="t('chat.send')"
          @click="handleSend"
        >
          <template #icon>
            <!-- Keep glyph, matching the prototype (not a hand-drawn plane). -->
            <KpIcon name="full_send" :size="16" />
          </template>
        </NButton>
      </div>
    </div>

    <!-- Attachment previews (file/image thumbnails only — the expert/skill
         pills live inline with the textarea, prototype-style) -->
    <div v-if="attachments.length > 0" class="attachment-previews">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="attachment-preview"
        :class="{ image: isImage(att.type) }"
      >
        <template v-if="isImage(att.type)">
          <img :src="att.url" :alt="att.name" class="attachment-thumb" />
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

    <div
      ref="inputWrapperRef"
      class="input-wrapper"
      :class="{ 'drag-over': isDragging, 'has-inline-chips': !!(pendingExpertPick || pendingSkillPick) }"
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
      <!-- Prototype attachment pills (expert/skill picks): inline with the
           textarea in one wrapping row, so the caret lands right after the
           pill instead of on a line below. Removable until send. -->
      <div v-if="pendingExpertPick" class="expert-chip">
        <button class="expert-chip__remove" type="button" @click="clearPendingExpertPick">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <span>{{ pendingExpertPick.label }}</span>
      </div>
      <div v-if="pendingSkillPick" class="expert-chip" data-testid="skill-chip">
        <button class="expert-chip__remove" type="button" @click="clearPendingSkillPick">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <span>{{ pendingSkillPick.label }}</span>
      </div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        :style="inputTextareaStyle"
        :placeholder="composerPlaceholder"
        rows="1"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @input="handleInput"
        @paste="handlePaste"
      ></textarea>
      <!-- Prototype SlashPanel: entries grouped under muted captions, each row
           an icon + name + description. Keyboard nav keeps the flat index.
           No enter/leave transition — the prototype panel appears instantly —
           and an unmatched query shows the empty state instead of closing. -->
      <div
        v-if="slashActive"
        ref="commandDropdownRef"
        class="slash-command-dropdown"
        :style="{ maxHeight: `${slashPanelMaxHeight}px` }"
      >
        <div v-if="filteredBridgeCommands.length === 0" class="slash-command-empty">
          {{ t('chat.slashNoMatch') }}
        </div>
        <template v-for="group in slashGroups" :key="group.label">
          <div class="slash-command-group">{{ group.label }}</div>
          <div
            v-for="entry in group.items"
            :key="entry.command.key"
            class="slash-command-item"
            :class="{ active: entry.index === slashActiveIndex }"
            @mousedown.prevent="selectBridgeCommand(entry.command)"
            @mouseenter="handleCommandHover(entry.index)"
          >
            <span
              class="slash-command-tile"
              :class="{ 'is-mark': slashHasTileMark(entry.command) }"
              :style="slashHasTileMark(entry.command)
                ? { background: slashTileHue(entry.command.name) }
                : undefined"
            >
              <template v-if="slashHasTileMark(entry.command)">
                {{ slashTileMark(entry.command.name) }}
              </template>
              <KpIcon v-else :name="group.icon" :size="15" />
            </span>
            <div class="slash-command-body">
              <span class="slash-command-name">
                {{ entry.command.key.startsWith('expert:') ? entry.command.name : `/${entry.command.name}` }}
              </span>
              <span class="slash-command-desc">{{ entry.command.description }}</span>
            </div>
          </div>
        </template>
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
        <p v-if="contextEditError" class="context-edit-error" data-testid="context-edit-error">
          {{ contextEditError }}
        </p>
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
  </ComposerBox>

  <!-- 会话内「定时执行」入口 (digital-employee-scheduled-entry). Deliberately
       OUTSIDE ComposerBox: it is a dialog trigger, not part of the box, and
       nesting it inside means a stubbed ComposerBox swallows it — which is
       exactly how it silently disappeared once already. Renders only for an
       expert-bound session; cancelling stays a zero-write gesture. -->
  <ChatScheduledEntry
    v-if="scheduledExpert"
    :session-id="chatStore.activeSession!.id"
    :expert-id="scheduledExpert.id"
    :expert-label="scheduledExpert.title || scheduledExpert.name"
    :initial-name="chatStore.activeSession!.title"
    :initial-prompt="inputText"
    :initial-skills="scheduledExpert.skills || []"
  />
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.scope-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 8px 8px;
  padding: 8px 10px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--fg-secondary);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  position: relative;
  z-index: 5;
}

.scope-hint__text {
  flex: 1;
  min-width: 0;
}

.scope-hint__close {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}

.context-edit-error {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}


// Box, section order and insets live in ComposerBox — the same component
// group chat's composer uses, so the two cannot drift apart again. What stays
// here is what goes INSIDE the sections.


// Pushes the whole right group (usage / model / expert / more / send) to the
// right edge, leaving `+ attach` alone on the left.
.tool-row-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

// Prototype AddMenu trigger is a 32px ghost circle, same weight as the rest
// of the toolrow controls.
.attach-button {
  flex-shrink: 0;
  width: 32px !important;
  height: 32px !important;
}

// AddMenu (prototype "+"): a two-level hover menu. The anchor is a tight
// inline wrapper so we can measure the button for fixed-position placement.
.add-menu-anchor {
  display: inline-flex;
}

.add-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 29;
}

.add-menu {
  position: fixed;
  width: 208px;
  padding: 8px;
  background: var(--bg);
  border-radius: var(--r-card);
  // Hairline in and out, no drop shadow — the chrome every prototype popover
  // carries (it uses no drop shadow at all) and what the model menu and the
  // automation dialog's popovers already use.
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);
  z-index: 30;
}

.add-menu--sub {
  width: 220px;
  max-height: 320px;
  overflow: auto;
}

.add-menu__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--r-ctl);
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-14) / var(--lh-tight) var(--font-cn);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);

  // Same hover ground as the automation dialog's menu rows (prototype `.row`).
  &:hover,
  &.active {
    background: var(--surface-3);
  }
}

.add-menu__icon :deep(.kp-icon-font),
.add-menu__icon {
  color: var(--fg-aux);
  flex: none;
}

.add-menu__label {
  flex: 1;
  min-width: 0;
}

.add-menu__label--ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-menu__caret :deep(.kp-icon-font),
.add-menu__caret {
  color: var(--fg-disabled);
  flex: none;
}

// "manage / summon more" footer row (prototype: rotated arrow + muted meta).
.add-menu__more {
  gap: 8px;
  color: var(--fg-aux);
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
}

.add-menu__more-arrow :deep(.kp-icon-font),
.add-menu__more-arrow {
  color: var(--fg-aux);
  flex: none;
  transform: rotate(-45deg);
}

// Compact round send (prototype: 32×32 pill). Icon-only. Ground is driven by
// `canSend` via NButton's :disabled — no text/attachments reads as the
// disabled look (transparent ground, muted icon); with content it fills.
//
// The ground is `--gray-33`, the same as every other main button (create agent,
// new automation, custom expert). It has been three colours: keep-green read as
// a status badge (green is the status colour here — running/succeeded), and
// hue-purple did fix the hierarchy but left this key as the only purple control
// on the site, so it looked like it came from another product. Consistency wins
// over hierarchy here, because hierarchy has other carriers — this key is round,
// alone, and in the corner of the field — while an inconsistent colour has none.
// Purple stays selection-only, green stays status-only, and nothing moonlights.
//
// Hover/press are the §9.1 overlay (black at 8% / 20%), not a second ground
// colour, so this key answers the pointer the same way every other button does.
// The overlay is written out here instead of borrowing the global `.ab` class:
// every other carrier of `.ab` in this repo is a native <button>, and this is an
// NButton whose label lives in a child element, so the content is stacked
// explicitly rather than trusting naive-ui's internal z-order to keep the glyph
// above the overlay.
.send-button {
  width: 32px !important;
  height: 32px !important;
  min-width: 32px !important;
  border-radius: 9999px !important;
  background-color: var(--gray-33) !important;
  color: #fff !important;
  transition: background-color var(--motion-fast) var(--ease-std),
    color var(--motion-fast) var(--ease-std);

  :deep(.n-button__border),
  :deep(.n-button__state-border) {
    display: none;
  }

  &::after {
    content: '';
    position: absolute;
    inset: 0;
    // Follows the pill without restating the radius.
    border-radius: inherit;
    pointer-events: none;
    background: #000;
    opacity: 0;
    transition: opacity 90ms var(--ease-std);
  }

  // The glyph has to outrank the overlay, or pressing the key hides the icon.
  :deep(.n-button__content) {
    position: relative;
    z-index: 1;
  }

  &:hover::after { opacity: 0.08; }
  &:active::after { opacity: 0.2; }

  // Disabled neither hovers nor presses (§9.1).
  &:disabled::after { opacity: 0 !important; }

  // Dark mode overlays white — stacking more black on a dark ground is
  // invisible. Same flip, and same depths, as the global `.ab` rule.
  .dark &,
  [data-theme='dark'] & {
    &::after { background: #fff; }
    &:hover::after { opacity: 0.1; }
    &:active::after { opacity: 0.22; }
  }

  &:disabled {
    background-color: transparent !important;
    color: var(--fg-disabled) !important;
    opacity: 1 !important;
  }

  // While a run is streaming the SAME circle is the stop control — same ground,
  // same size, same slot; only the glyph changes (send vs close). Its disabled
  // state is "abort already requested", so it keeps the ground and just dims.
  &.is-running:disabled {
    background-color: var(--gray-33) !important;
    color: #fff !important;
    opacity: 0.6 !important;
  }
}

// Pills 4px apart. The 8px inset, the hairline over the row and the lift above
// the beam layers come from ComposerBox.
.input-pillbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  row-gap: 4px;
  margin: 0;

  // A thin rule between pills, not a gap, so "which agent / which workspace"
  // reads as one scope statement broken into parts, not two unrelated chips.
  &__sep {
    width: 1px;
    align-self: stretch;
    background: var(--divider);
    flex: none;
  }
}

// The scope pill: a small height-28 pill with a subtle surface tint, no drop
// shadow, hover raises the text to title colour.
.composer-scope-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--gray-f7);
  color: var(--fg-secondary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  flex: none;
  transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);

  // Offline: the text and glyph go danger, the ground does NOT. A danger ground
  // would read as a warning block; this is still a control you can press.
  &.is-offline {
    color: var(--danger);
  }

  &:hover {
    background: var(--gray-f2);
    color: var(--fg-title);
  }

  &__caret {
    color: var(--fg-aux);
  }
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

// Prototype UsagePill: a compact chart pill (📈 count). Flat Keep pill,
// consistent with the scope/model pills; detail is in the hover tooltip.
// Prototype UsagePill: a bare 32px ghost pill in the tool row — the surface
// tint only appears on hover, so the number reads as a quiet readout rather
// than another button competing with the model picker.
.context-info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--motion-fast) var(--ease-std),
    color var(--motion-fast) var(--ease-std);

  :deep(.kp-icon-font) {
    color: var(--fg-aux);
  }

  &:hover {
    background: var(--gray-f7);
    color: var(--fg-title);
  }

  &.context-warning {
    color: var(--warning);

    :deep(.kp-icon-font) {
      color: var(--warning);
    }
  }
}

// Prototype UsagePill number: medium 13px.
.context-info__count {
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-data);
  font-variant-numeric: tabular-nums;
}

// Usage breakdown popover (prototype UsagePill): 288 card, big total, then
// per-part meter bars, then footer rows. Rendered `raw` so this owns the card.
.usage-popover {
  width: 288px;
  padding: 20px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);
}

.usage-popover__caption {
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-aux);
  margin-bottom: 8px;
}

.usage-popover__total {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 4px;
}

.usage-popover__total-num {
  font: var(--w-semibold) 24px / var(--lh-24) var(--font-data);
  color: var(--fg-title);
  font-variant-numeric: tabular-nums;
}

.usage-popover__total-unit {
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-aux);
}

.usage-popover__meta {
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-aux);
  margin-bottom: 24px;
}

.usage-popover__part {
  margin-bottom: 16px;
}

.usage-popover__part-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.usage-popover__part-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex: 0 0 6px;
  transform: translateY(-1px);
}

.usage-popover__part-name {
  flex: 1;
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
}

.usage-popover__part-value {
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-data);
  color: var(--fg-primary);
  font-variant-numeric: tabular-nums;
}

.usage-popover__part-track {
  height: 4px;
  border-radius: 9999px;
  background: var(--gray-f2);
  overflow: hidden;
}

.usage-popover__part-fill {
  height: 100%;
  border-radius: 2px;
  transition: width var(--motion-page) var(--ease-out);
}

.usage-popover__divider {
  height: 1px;
  background: var(--divider);
  margin: 8px 0 8px;
}

.usage-popover__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 24px);
  padding: 8px 12px;
  margin: 0 -12px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  cursor: pointer;
  text-align: left;

  > span {
    flex: 1;
    font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
    color: var(--fg-secondary);
  }

  :deep(.kp-icon-font) {
    color: var(--fg-disabled);
  }

  &:hover {
    background: var(--gray-fa);
  }
}

@media (max-width: 768px) {
  .input-top-bar {
    gap: 5px;
  }

}

.attachment-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// Prototype attachment pill: height 28, full pill, purple tint, leading ×
// (always visible — unlike the file-thumbnail's hover-only remove button).
.expert-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 9999px;
  background: var(--hue-purple-bg);
  color: var(--hue-purple);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  flex: none;
}

.expert-chip__remove {
  display: inline-flex;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.attachment-preview {
  position: relative;
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: $bg-secondary;
  border: 1px solid $border-color;

  &.image {
    width: 64px;
    height: 64px;
  }
}

.attachment-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
  // Send / voice sit on the floor of the field, level with the tool row,
  // rather than floating in the middle of a tall box.
  align-items: flex-end;
  gap: 10px;
  // Insets, the transparent ground (the beam layers ARE the frame) and the lift
  // above them come from ComposerBox.

  // Pill + caret share one wrapping row (prototype: pills and the textarea
  // live in the same flex-wrap container, textarea flex 1 1 60px). Lines pack
  // to the top of the fixed-height wrapper so the composer height is stable.
  &.has-inline-chips {
    flex-wrap: wrap;
    align-items: center;
    align-content: flex-start;

    .input-textarea {
      flex: 1 1 60px;
      min-width: 60px;
    }
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
  font-size: 16px;
  line-height: 1.6;
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

// Model / voice / send, at the right end of the tool row — one floor for the
// box, `+` at one end and the controls at the other. This block lives in the
// tool row's markup rather than the field wrapper's; positioning alone could
// not do it, because once the scope row exists the box's bottom edge is the
// scope row, not this line.
.input-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  align-items: center;

  // Prototype: the send/stop circle sits 4px further from the mic.
  .send-button {
    margin-left: 4px;
  }
}

// Prototype SlashPanel: a floating sheet (r-sheet, notification shadow,
// 10px padding), muted group captions, rows led by a 30px rounded tile with
// name + inline muted description.
.slash-command-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  // max-height is inline-bound: prototype clamps it to the space above the
  // composer (max(160, min(360, top - 24))).
  overflow-y: auto;
  background: var(--bg);
  border-radius: var(--r-sheet);
  // Hairline in and out, no drop shadow — §7.1, and the prototype's own panel.
  // The dark override is gone with it: --bg already carries the theme.
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);
  z-index: 50;
  padding: 8px;
}

.slash-command-group {
  padding: 8px 8px 4px;
  margin-bottom: 4px;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
}

.slash-command-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: var(--r-ctl);
  cursor: pointer;

  &.active,
  &:hover {
    background: var(--surface-3);
  }
}

// Prototype: an unmatched query keeps the panel open with a centered notice.
.slash-command-empty {
  padding: 20px 8px;
  text-align: center;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
}

.slash-command-tile {
  width: 30px;
  height: 30px;
  border-radius: var(--r-ctl);
  background: var(--surface-3);
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  flex: 0 0 30px;
  font: var(--w-semibold) var(--t-13) / var(--lh-1) var(--font-cn);

  // Named things get the solid hue + white mark; the ground comes inline from
  // the name hash.
  &.is-mark {
    color: var(--white);
  }
}

.slash-command-body {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  overflow: hidden;
}

.slash-command-name {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  white-space: nowrap;
}

.slash-command-desc {
  margin-left: 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
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

</style>
