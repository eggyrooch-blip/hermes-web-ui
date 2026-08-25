<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NSpin, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import AgentArtifactPreview, { type ArtifactKind } from '@/components/hermes/agents/AgentArtifactPreview.vue'
import KpCatalogGroup from '@/components/kippies/KpCatalogGroup.vue'
import KpCatalogRow from '@/components/kippies/KpCatalogRow.vue'
import KpIconBtn from '@/components/kippies/KpIconBtn.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { isHtmlFile, isImageFile, isMarkdownFile, isTextFile } from '@/stores/hermes/files'
import { fetchMemory, fetchSkills, saveMemory, type MemoryData, type SkillsData } from '@/api/hermes/skills'
import { listFiles, readFile, type FileEntry } from '@/api/hermes/files'
import { downloadFile } from '@/api/hermes/download'
import { fetchAgentShares, revokeAgentShare, type AgentShare } from '@/api/hermes/agents'
import { safeShareAvatarUrl } from '@/utils/hermes/share-identity'
import { agentDisplayName, agentKind, isUnnamedGroup } from '@/utils/hermes/agent-identity'

type TabKey = 'persona' | 'artifacts' | 'skills' | 'model' | 'safe'
type PersonaKey = 'soul' | 'user' | 'memory'

const props = withDefaults(defineProps<{ agentName?: string; embedded?: boolean }>(), {
  agentName: '',
  embedded: false,
})
const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const dialog = useDialog()
const route = useRoute()
const router = useRouter()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()

const tab = ref<TabKey>('persona')
const personaKey = ref<PersonaKey>('soul')
const loading = ref(false)
const loadError = ref('')
const memory = ref<MemoryData | null>(null)
const artifacts = ref<FileEntry[]>([])
const skills = ref<SkillsData | null>(null)
const starting = ref(false)

// Embedded in the chat sidebar the name comes from the parent, not the route.
const profileName = computed(() => props.agentName || String(route.params.name || ''))
// The server only honours ?profile= for a profile the caller OWNS; for anything
// else it silently falls back to the caller's own profile. Rendering that as
// the requested agent would show one agent's persona under another's name, so
// unknown/shared profiles get an explicit notice instead of scoped reads.
const knownProfile = computed(() => profilesStore.profiles.find(p => p.name === profileName.value))
const isSharedAgent = computed(() => !!knownProfile.value?.shareRole)
const scopedReadsAllowed = computed(() => !!knownProfile.value && !isSharedAgent.value)
const profile = computed(() =>
  profilesStore.profiles.find(p => p.name === profileName.value)
  // Deep-link / refresh: the store may not be populated yet. Render off the
  // route param so the page never blanks; grouping helpers infer kind from the
  // profile name when metadata is missing.
  ?? { name: profileName.value, active: false, model: '', alias: '' } as any,
)

const kind = computed(() => agentKind(profile.value))
const displayName = computed(() => agentDisplayName(profile.value, t('agentsHub.unnamedGroup')))
const pendingGroupName = computed(() => isUnnamedGroup(profile.value))
const modelLabel = computed(() => {
  const model = profile.value.model?.trim()
  return !model || model === '—' || model === '-' ? t('agentsHub.followGlobalModel') : model
})
const skillCount = computed(() =>
  skills.value?.categories?.reduce((sum, category) => sum + (category.skills?.length ?? 0), 0) ?? 0,
)
const artifactCount = computed(() => artifacts.value.length)

const personaFile = computed(() => {
  if (personaKey.value === 'soul') return { file: 'SOUL.md', body: memory.value?.soul ?? '' }
  if (personaKey.value === 'user') return { file: 'memories/USER.md', body: memory.value?.user ?? '' }
  return { file: 'memories/MEMORY.md', body: memory.value?.memory ?? '' }
})

const PERSONA_TABS: { key: PersonaKey; label: string }[] = [
  { key: 'soul', label: 'agentDetail.persona.soul' },
  { key: 'user', label: 'agentDetail.persona.user' },
  { key: 'memory', label: 'agentDetail.persona.memory' },
]
const TABS: { key: TabKey; label: string }[] = [
  { key: 'persona', label: 'agentDetail.tabs.persona' },
  { key: 'artifacts', label: 'agentDetail.tabs.artifacts' },
  { key: 'skills', label: 'agentDetail.tabs.skills' },
  { key: 'model', label: 'agentDetail.tabs.model' },
  { key: 'safe', label: 'agentDetail.tabs.safe' },
]

// ── 安全 · who can reach this agent ─────────────────────────
// Real sharing, the same grants the profiles page manages: an agent only has
// them once it is registered in the chat plane (that is what gives it an
// agentId), and only its owner or a manager may see or change them.
const shares = ref<AgentShare[]>([])
/** Failures on this page: shares, persona save, and file downloads. */
const paneError = ref('')
const sharesLoading = ref(false)
const sharesLoaded = ref(false)
// A shared agent never gets this far — the whole panel shows `sharedNotice`
// instead — so this only has to gate the fetch for agents you own.
const canManageShares = computed(
  () => !!profile.value.agentId && (!profile.value.shareRole || profile.value.shareRole === 'manager'),
)

async function loadShares() {
  const agentId = profile.value.agentId
  if (!agentId || !canManageShares.value) return
  sharesLoading.value = true
  try {
    shares.value = await fetchAgentShares(agentId)
    sharesLoaded.value = true
  } catch (err: any) {
    paneError.value = err?.message || t('profiles.share.loadFailed')
    shares.value = []
  } finally {
    sharesLoading.value = false
  }
}

function shareName(share: AgentShare): string {
  return share.principal?.display_name || share.principal?.email || share.grantee_open_id
}

// Revoking is the one destructive action on this page, so it confirms first.
function confirmRevoke(share: AgentShare) {
  const agentId = profile.value.agentId
  if (!agentId) return
  dialog.warning({
    title: t('profiles.share.revoke'),
    content: t('agentDetail.safe.revokeConfirm', { name: shareName(share) }),
    positiveText: t('profiles.share.revoke'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await revokeAgentShare(agentId, share.share_id || share.grantee_open_id)
        // The row leaving the list is the report.
        await loadShares()
      } catch (err: any) {
        paneError.value = err?.message || t('profiles.share.revokeFailed')
      }
    },
  })
}

// ── 人设 · editing the file in place ────────────────────────
// The three persona files are what the agent actually reads, so editing them
// here is editing its behaviour — hence an explicit save rather than
// autosave-on-blur, and a cancel that puts the original back.
const editing = ref(false)
const draft = ref('')
const saving = ref(false)

function startEdit() {
  draft.value = personaFile.value.body
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = ''
}

async function savePersona() {
  if (saving.value) return
  saving.value = true
  try {
    await saveMemory(personaKey.value, draft.value, profileName.value)
    if (memory.value) memory.value[personaKey.value] = draft.value
    // Leaving edit mode with the new text in place is the report.
    editing.value = false
  } catch (err: any) {
    paneError.value = err?.message || t('settings.saveFailed')
  } finally {
    saving.value = false
  }
}

/**
 * Every read is scoped with ?profile= so the page shows THIS agent's data even
 * when it is not the active profile — the server only honours the selector for
 * a profile the caller owns, so this cannot be used to peek at someone else's.
 */
async function load(name: string) {
  if (!name) return
  loading.value = true
  loadError.value = ''
  memory.value = null
  artifacts.value = []
  skills.value = null
  if (!scopedReadsAllowed.value) {
    // Either the list has not arrived yet (caller re-runs after fetchProfiles)
    // or this is a shared agent whose data lives under the owner's profile.
    loading.value = false
    return
  }
  // NOT fetchProfileDetail: GET /api/hermes/profiles/:name is blocked in chat
  // plane (the allowlist only admits the exact /api/hermes/profiles collection),
  // and chat plane is what prod runs. The list endpoint already carries `model`,
  // so the Model tab reads it from the store instead of 403-ing here.
  const [memoryRes, filesRes, skillsRes] = await Promise.allSettled([
    fetchMemory(name),
    listFiles('', name),
    fetchSkills(name),
  ])
  if (name !== profileName.value) return
  if (memoryRes.status === 'fulfilled') memory.value = memoryRes.value
  if (filesRes.status === 'fulfilled') artifacts.value = filesRes.value.entries.filter(entry => !entry.isDir)
  if (skillsRes.status === 'fulfilled') skills.value = skillsRes.value
  // A brand-new agent has no SOUL.md and no workspace yet — that is an empty
  // state, not an error. Only report failure when nothing at all came back.
  if ([memoryRes, filesRes, skillsRes].every(res => res.status === 'rejected')) {
    loadError.value = t('agentDetail.loadFailed')
  }
  loading.value = false
}

watch(profileName, name => {
  if (!profilesStore.profiles.length) void profilesStore.fetchProfiles()
  void load(name)
}, { immediate: true })

// Re-run once the profile list lands: on a deep link / refresh the first pass
// cannot yet tell an owned agent from an unknown one.
watch(scopedReadsAllowed, allowed => {
  if (allowed) void load(profileName.value)
})

// Switching agents drops both the share list and any half-written persona edit
// — carrying either across would attribute one agent's state to another.
watch(profileName, () => {
  shares.value = []
  sharesLoaded.value = false
  cancelEdit()
})

// Shares are only fetched when their tab is opened: it is one request per agent
// and most visits never look.
watch(tab, next => {
  if (next === 'safe' && !sharesLoaded.value) void loadShares()
})

// Changing which persona file you are looking at abandons the edit; the draft
// belongs to the file it was started from.
watch(personaKey, () => cancelEdit())

async function startNewTask() {
  if (starting.value) return
  // Captured up front: navigating away mid-await would otherwise switch one
  // agent and open a chat for another.
  const name = profileName.value
  if (!name || !knownProfile.value) return
  starting.value = true
  chatStore.agentSwitching = true
  try {
    if (profilesStore.activeProfileName !== name) {
      if (!await profilesStore.switchProfile(name)) return
    }
    await router.push({ name: 'hermes.chat', query: { profile: name, new: '1' } })
  } finally {
    chatStore.agentSwitching = false
    starting.value = false
  }
}

function formatModTime(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

// ── 产物 · preview + download ───────────────────────────────
// The prototype's 产物 rows are CatalogRows with a file-type tile (FILE_ICON /
// FILE_COLOR, athand-manage.jsx:2311). Extensions the prototype does not name
// fall back to a neutral document tile rather than inventing a colour.
const ARTIFACT_TILES: Record<string, { icon: string; color: string }> = {
  docx: { icon: 'line_content', color: 'var(--hue-blue)' },
  doc: { icon: 'line_content', color: 'var(--hue-blue)' },
  pdf: { icon: 'line_content', color: 'var(--hue-blue)' },
  xlsx: { icon: 'full_data', color: 'var(--hue-green)' },
  xls: { icon: 'full_data', color: 'var(--hue-green)' },
  csv: { icon: 'full_data', color: 'var(--hue-green)' },
  pptx: { icon: 'line_screening', color: 'var(--hue-orange)' },
  html: { icon: 'line_link', color: 'var(--hue-purple)' },
  htm: { icon: 'line_link', color: 'var(--hue-purple)' },
  md: { icon: 'line_content', color: 'var(--fg-secondary)' },
}
const NEUTRAL_TILE = { icon: 'line_content', color: 'var(--fg-secondary)' }

function artifactExt(name: string): string {
  return (name.match(/\.(\w+)$/)?.[1] || '').toLowerCase()
}

function artifactTile(name: string) {
  return ARTIFACT_TILES[artifactExt(name)] || NEUTRAL_TILE
}

/** `HTML · 2026/8/18 14:52` — the prototype's `文档 · 8 月 7 日` line, with a
 * real extension instead of a translated type word (extensions aren't localised). */
function artifactMeta(entry: FileEntry): string {
  const ext = artifactExt(entry.name).toUpperCase()
  const when = formatModTime(entry.modTime)
  return [ext, when].filter(Boolean).join(' · ')
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exp
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`
}

function artifactKind(name: string): ArtifactKind {
  if (isImageFile(name)) return 'image'
  if (isMarkdownFile(name)) return 'markdown'
  if (isHtmlFile(name)) return 'html'
  if (isTextFile(name)) return 'text'
  return 'binary'
}

// The prototype's group note reads「按最近一次用到排序」— newest first is also
// the useful order for artifacts, so the raw directory order is not shown.
const sortedArtifacts = computed(() =>
  [...artifacts.value].sort((a, b) => (b.modTime || '').localeCompare(a.modTime || '')),
)

const previewEntry = ref<FileEntry | null>(null)
const previewKind = ref<ArtifactKind>('binary')
const previewContent = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const downloadingPath = ref('')
// Late reads must not land on a preview the user has since replaced or closed.
let previewRequestId = 0

async function openArtifact(entry: FileEntry) {
  const requestId = ++previewRequestId
  const kind = artifactKind(entry.name)
  previewEntry.value = entry
  previewKind.value = kind
  previewContent.value = ''
  previewError.value = ''
  // Images stream from /download; binaries have nothing to read.
  if (kind === 'image' || kind === 'binary') {
    previewLoading.value = false
    return
  }
  previewLoading.value = true
  try {
    const result = await readFile(entry.path, profileName.value)
    if (requestId !== previewRequestId) return
    previewContent.value = result.content
  } catch (err: any) {
    if (requestId !== previewRequestId) return
    previewError.value = err?.message || t('agentDetail.artifacts.previewFailed')
  } finally {
    if (requestId === previewRequestId) previewLoading.value = false
  }
}

function closeArtifact() {
  previewRequestId += 1
  previewEntry.value = null
  previewContent.value = ''
  previewError.value = ''
  previewLoading.value = false
}

async function downloadArtifact(entry: FileEntry) {
  if (downloadingPath.value) return
  downloadingPath.value = entry.path
  try {
    // Scoped to THIS agent's profile: the artifact list is read with ?profile=,
    // so the download has to be too or it would fetch the active profile's file
    // of the same name.
    await downloadFile(entry.path, entry.name, profileName.value)
  } catch (err: any) {
    paneError.value = err?.message || t('download.downloadFailed')
  } finally {
    downloadingPath.value = ''
  }
}

// A preview belongs to the agent and the tab it was opened from.
watch([profileName, tab], () => closeArtifact())
</script>

<template>
  <div class="agent-detail-view" :class="{ 'is-embedded': props.embedded }">
    <p v-if="paneError" class="pane-notice is-error" data-testid="agent-detail-error">{{ paneError }}</p>
    <header class="page-header">
      <div class="crumb">
        <a class="crumb-link" @click="props.embedded ? emit('back') : router.push({ name: 'hermes.agents' })">{{ t('agentsHub.title') }}</a>
        <span class="crumb-sep">/</span>
        <span class="crumb-current">{{ displayName }}</span>
      </div>
    </header>

    <div class="agent-detail-body">
      <aside class="agent-identity">
        <ProfileAvatar class="agent-identity-avatar" :name="profile.name" :avatar="profile.avatar" :size="84" />
        <div class="agent-identity-name">
          <span>{{ displayName }}</span>
          <span class="agent-tag">{{ t(`agentsHub.kind.${kind}`) }}</span>
        </div>
        <div v-if="pendingGroupName" class="agent-identity-pending">{{ t('agentsHub.groupNamePending') }}</div>
        <div class="agent-identity-profile">{{ profile.name }}</div>
        <div class="agent-identity-chips">
          <span class="agent-tag hollow">{{ modelLabel }}</span>
        </div>

        <div class="agent-stats">
          <div class="agent-stat">
            <div class="agent-stat-value">{{ artifactCount }}</div>
            <div class="agent-stat-key">{{ t('agentDetail.stats.artifacts') }}</div>
          </div>
          <div class="agent-stat">
            <div class="agent-stat-value">{{ skillCount }}</div>
            <div class="agent-stat-key">{{ t('agentDetail.stats.skills') }}</div>
          </div>
          <div class="agent-stat">
            <div class="agent-stat-value">{{ memory?.soul ? 1 : 0 }}</div>
            <div class="agent-stat-key">{{ t('agentDetail.stats.persona') }}</div>
          </div>
        </div>

        <button
          class="agent-primary-btn"
          data-testid="agent-detail-new-task"
          :disabled="!knownProfile"
          @click="startNewTask"
        >
          {{ t('agentsHub.newTask') }}
        </button>

        <p class="agent-credential-note">
          {{ kind === 'user' ? t('agentDetail.credentials.owner') : t('agentDetail.credentials.scoped') }}
        </p>
      </aside>

      <section class="agent-panel">
        <div class="agent-tabs">
          <button
            v-for="item in TABS"
            :key="item.key"
            class="agent-tab"
            :class="{ on: tab === item.key }"
            :data-testid="`agent-tab-${item.key}`"
            @click="tab = item.key"
          >
            {{ t(item.label) }}
          </button>
        </div>

        <NSpin :show="loading">
          <div class="agent-panel-body">
            <div v-if="loadError" class="agent-panel-empty">{{ loadError }}</div>
            <div v-else-if="isSharedAgent" class="agent-panel-empty">{{ t('agentDetail.sharedNotice') }}</div>
            <div v-else-if="!knownProfile && !loading" class="agent-panel-empty">{{ t('agentDetail.unknownAgent') }}</div>

            <template v-else-if="tab === 'persona'">
              <div class="agent-chips">
                <button
                  v-for="item in PERSONA_TABS"
                  :key="item.key"
                  class="agent-chip"
                  :class="{ on: personaKey === item.key }"
                  @click="personaKey = item.key"
                >
                  {{ t(item.label) }}
                </button>
              </div>
              <div class="agent-file-card">
                <div class="agent-file-head">
                  <div class="agent-file-titles">
                    <div class="agent-file-name">{{ personaFile.file }}</div>
                    <div class="agent-file-desc">{{ t(`agentDetail.persona.${personaKey}Hint`) }}</div>
                  </div>
                  <button
                    v-if="!editing"
                    type="button"
                    class="agent-file-edit"
                    data-testid="agent-persona-edit"
                    @click="startEdit"
                  >{{ t('agentDetail.persona.edit') }}</button>
                </div>
                <template v-if="editing">
                  <!-- ⌘/Ctrl+Enter saves, Esc cancels — the file is what the
                       agent reads, so nothing is written until you say so. -->
                  <textarea
                    v-model="draft"
                    class="agent-file-editor"
                    data-testid="agent-persona-editor"
                    @keydown.esc.prevent="cancelEdit"
                    @keydown.meta.enter.prevent="savePersona"
                    @keydown.ctrl.enter.prevent="savePersona"
                  />
                  <div class="agent-file-actions">
                    <span class="agent-file-hint">{{ t('agentDetail.persona.editHint') }}</span>
                    <button type="button" class="agent-file-btn" @click="cancelEdit">
                      {{ t('common.cancel') }}
                    </button>
                    <button
                      type="button"
                      class="agent-file-btn is-primary"
                      :disabled="saving"
                      data-testid="agent-persona-save"
                      @click="savePersona"
                    >{{ t('common.save') }}</button>
                  </div>
                </template>
                <template v-else>
                  <pre v-if="personaFile.body" class="agent-file-body">{{ personaFile.body }}</pre>
                  <div v-else class="agent-panel-empty">{{ t('agentDetail.persona.empty') }}</div>
                </template>
              </div>
            </template>

            <template v-else-if="tab === 'artifacts'">
              <!-- Opening an artifact replaces the list, the way the prototype's
                   library swaps its right pane for the document. -->
              <AgentArtifactPreview
                v-if="previewEntry"
                :entry="previewEntry"
                :kind="previewKind"
                :content="previewContent"
                :profile="profileName"
                :loading="previewLoading"
                :error="previewError"
                :downloading="downloadingPath === previewEntry.path"
                @close="closeArtifact"
                @download="downloadArtifact(previewEntry)"
              />
              <template v-else>
                <div v-if="artifactCount === 0" class="agent-panel-empty">{{ t('agentDetail.artifacts.empty') }}</div>
                <KpCatalogGroup
                  v-else
                  :cols="1"
                  :title="t('agentDetail.artifacts.title')"
                  :note="t('agentDetail.artifacts.summary', { count: artifactCount })"
                >
                  <KpCatalogRow
                    v-for="entry in sortedArtifacts"
                    :key="entry.path"
                    clickable
                    :name="entry.name"
                    :icon="artifactTile(entry.name).icon"
                    :color="artifactTile(entry.name).color"
                    :meta="artifactMeta(entry)"
                    :desc="`${entry.path} · ${formatSize(entry.size)}`"
                    data-testid="agent-artifact-row"
                    @click="openArtifact(entry)"
                  >
                    <!-- Download stays on the row: it is the one thing you may
                         want without opening the file first. -->
                    <template #action>
                      <KpIconBtn
                        name="line_download"
                        :size="16"
                        :title="t('files.download')"
                        data-testid="agent-artifact-row-download"
                        @click.stop="downloadArtifact(entry)"
                      />
                    </template>
                  </KpCatalogRow>
                </KpCatalogGroup>
              </template>
            </template>

            <template v-else-if="tab === 'skills'">
              <div class="agent-list-bar">
                {{ t('agentDetail.skills.summary', { count: skillCount }) }}
              </div>
              <div v-if="skillCount === 0" class="agent-panel-empty">{{ t('agentDetail.skills.empty') }}</div>
              <div v-else class="agent-rows">
                <template v-for="category in skills?.categories ?? []" :key="category.name">
                  <div v-for="skill in category.skills ?? []" :key="`${category.name}/${skill.name}`" class="agent-row">
                    <div class="agent-row-main">
                      <div class="agent-row-name">
                        {{ skill.name }}
                        <span class="agent-tag">{{ category.name }}</span>
                      </div>
                      <div class="agent-row-desc">{{ skill.description }}</div>
                    </div>
                  </div>
                </template>
              </div>
            </template>

            <template v-else-if="tab === 'model'">
              <div class="agent-list-bar">{{ t('agentDetail.model.summary') }}</div>
              <div class="agent-rows">
                <div class="agent-row">
                  <div class="agent-row-main">
                    <div class="agent-row-name">{{ modelLabel }}</div>
                    <div class="agent-row-desc">{{ profile.name }}</div>
                  </div>
                </div>
              </div>
            </template>

            <template v-else>
              <div class="agent-list-bar">{{ t('agentDetail.safe.summary') }}</div>
              <!-- An agent that was never registered in the chat plane has no
                   agentId, so there is nothing to share it by. -->
              <div v-if="!profile.agentId" class="agent-panel-empty">
                {{ t('agentDetail.safe.unavailable') }}
              </div>
              <NSpin v-else :show="sharesLoading">
                <div v-if="shares.length === 0" class="agent-panel-empty">
                  {{ t('profiles.share.empty') }}
                </div>
                <div v-else class="agent-rows">
                  <div v-for="share in shares" :key="share.share_id || share.grantee_open_id" class="agent-row">
                    <img
                      v-if="safeShareAvatarUrl(share.principal?.avatar_url)"
                      class="agent-share-avatar"
                      :src="safeShareAvatarUrl(share.principal?.avatar_url)"
                      alt=""
                    />
                    <div class="agent-row-main">
                      <div class="agent-row-name">
                        {{ shareName(share) }}
                        <span class="agent-tag">{{ share.role }}</span>
                      </div>
                      <div class="agent-row-desc">{{ share.principal?.email || share.grantee_open_id }}</div>
                    </div>
                    <button
                      type="button"
                      class="agent-file-btn"
                      data-testid="agent-share-revoke"
                      @click="confirmRevoke(share)"
                    >{{ t('profiles.share.revoke') }}</button>
                  </div>
                </div>
              </NSpin>
            </template>
          </div>
        </NSpin>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.pane-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.pane-notice.is-error {
  background: var(--danger-bg);
  color: var(--danger);
}

.pane-notice.is-info {
  background: var(--surface-2);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 0.5px var(--divider);
}


.agent-detail-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.agent-detail-view.is-embedded {
  height: 100%;
  min-height: 0;
}

.crumb {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  color: var(--text-muted);
}

.crumb-link {
  cursor: pointer;

  &:hover {
    color: var(--text-primary);
  }
}

.crumb-current {
  color: var(--text-primary);
  font-weight: 600;
}

.agent-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: grid;
  grid-template-columns: 290px minmax(0, 1fr);
  gap: 26px;
  align-items: start;
}

@media (max-width: 900px) {
  .agent-detail-body {
    grid-template-columns: minmax(0, 1fr);
  }
}

.agent-identity {
  text-align: center;
}

.agent-identity-avatar {
  margin: 0 auto;
}

.agent-identity-name {
  margin-top: 13px;
  font-size: 19px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  flex-wrap: wrap;
}

.agent-identity-pending,
.agent-identity-profile {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.agent-identity-profile {
  font-family: ui-monospace, Menlo, monospace;
  word-break: break-all;
  padding: 0 10px;
}

.agent-identity-chips {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 11px;
  flex-wrap: wrap;
}

.agent-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin: 20px 0 16px;
}

.agent-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.agent-stat-key {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.agent-primary-btn {
  width: calc(100% - 28px);
  margin: 0 14px;
  padding: 9px 13px;
  border-radius: 8px;
  border: 1px solid var(--accent-primary);
  background: var(--accent-primary);
  color: var(--text-on-accent);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--accent-hover);
  }
}

.agent-credential-note {
  margin: 14px 14px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-muted);
  text-align: left;
}

.agent-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  min-height: 420px;
  display: flex;
  flex-direction: column;
}

.agent-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 12px 0;
  border-bottom: 1px solid var(--border-light);
}

.agent-tab {
  padding: 11px 13px;
  font-size: 13.5px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;

  &.on {
    color: var(--text-primary);
    font-weight: 600;
    border-bottom-color: var(--accent-primary);
  }
}

.agent-panel-body {
  padding: 16px 18px;
  flex: 1;
}

.agent-chips {
  display: flex;
  gap: 7px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.agent-chip {
  padding: 5px 11px;
  border-radius: 20px;
  border: none;
  font-size: 12.5px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;

  &.on {
    background: var(--accent-primary);
    color: var(--text-on-accent);
  }
}

.agent-file-card {
  border: 1px solid var(--border-light);
  border-radius: 10px;
  overflow: hidden;
}

.agent-file-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 13px;
  border-bottom: 1px solid var(--border-light);
  background: var(--bg-secondary);
}

.agent-file-titles {
  flex: 1;
  min-width: 0;
}

.agent-file-edit {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--btn-line);
  color: var(--fg-primary);
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
  cursor: pointer;

  &:hover {
    background: var(--surface-1);
  }
}

// Same measure as the read view, so switching in and out does not reflow the
// card.
.agent-file-editor {
  display: block;
  width: 100%;
  min-height: 220px;
  max-height: 420px;
  padding: 14px 15px;
  border: 0;
  outline: none;
  resize: vertical;
  background: transparent;
  color: var(--text-secondary);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.agent-file-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 13px 12px;
}

.agent-file-hint {
  flex: 1;
  min-width: 0;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
}

.agent-file-btn {
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--btn-line);
  color: var(--fg-primary);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;

  &.is-primary {
    background: var(--gray-33);
    box-shadow: none;
    color: var(--white);
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

.agent-share-avatar {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: var(--r-pill);
  object-fit: cover;
}

.agent-file-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: ui-monospace, Menlo, monospace;
}

.agent-file-desc {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.agent-file-body {
  margin: 0;
  padding: 14px 15px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow-y: auto;
  font-family: inherit;
}

.agent-list-bar {
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.agent-rows {
  display: flex;
  flex-direction: column;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 4px;
  border-bottom: 1px solid var(--border-light);

  &:last-child {
    border-bottom: none;
  }
}

.agent-row-main {
  min-width: 0;
}

.agent-row-name {
  font-size: 13.5px;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.agent-row-desc {
  margin-top: 1px;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-panel-empty {
  border: 1px dashed var(--border-color);
  border-radius: 10px;
  padding: 22px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.agent-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  white-space: nowrap;

  &.hollow {
    background: transparent;
  }
}
</style>
