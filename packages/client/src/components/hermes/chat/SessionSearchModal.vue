<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NModal, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchSessions, searchSessions, type SessionSearchResult, type SessionSummary } from '@/api/hermes/sessions'
import { searchFiles, type FileEntry } from '@/api/hermes/files'
import { fetchSkills, type SkillInfo } from '@/api/hermes/skills'
import { useChatStore } from '@/stores/hermes/chat'
import { useFilesStore } from '@/stores/hermes/files'
import { useSessionSearch } from '@/composables/useSessionSearch'

const { t } = useI18n()
/** Search failure, shown in the palette above the results. */
const paneError = ref('')
const router = useRouter()
const chatStore = useChatStore()
const filesStore = useFilesStore()
const { sessionSearchOpen } = useSessionSearch()

const query = ref('')
const loading = ref(false)
const recentSessions = ref<SessionSummary[]>([])
const searchResults = ref<SessionSearchResult[]>([])
const fileResults = ref<FileEntry[]>([])
const skillResults = ref<SkillInfo[]>([])
const filesTruncated = ref(false)
const activeIndex = ref(0)
const inputRef = ref<InstanceType<typeof NInput> | null>(null)
const profileFilter = computed(() => chatStore.sessionProfileFilter || undefined)
const runtimeSource = computed(() => chatStore.runtimeMode === 'global_agent' ? 'global_agent' : undefined)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let requestSeq = 0

type SessionItem = SessionSearchResult | (SessionSummary & {
  snippet?: string
  matched_message_id: number | null
  rank: number
})

// The palette searches the three things you can look for by name: a task you
// ran, a file it produced or you gave it, and a skill you can invoke. They are
// kept in ONE flat list rather than three, so arrow keys walk the whole result
// set the way they always did — the group headers are rendered from the `kind`
// changing, not from separate lists.
type SearchItem =
  | { kind: 'task'; key: string; session: SessionItem }
  | { kind: 'file'; key: string; entry: FileEntry }
  | { kind: 'skill'; key: string; skill: SkillInfo }

const hasQuery = computed(() => query.value.trim().length > 0)

const items = computed<SearchItem[]>(() => {
  if (!hasQuery.value) {
    return recentSessions.value.map(session => ({
      kind: 'task' as const,
      key: `task:${session.id}`,
      session: { ...session, matched_message_id: null, snippet: session.preview || '', rank: 0 },
    }))
  }
  return [
    ...searchResults.value.map(result => ({
      kind: 'task' as const,
      key: `task:${result.id}`,
      session: result,
    })),
    ...fileResults.value.map(entry => ({
      kind: 'file' as const,
      key: `file:${entry.path}`,
      entry,
    })),
    ...skillResults.value.map(skill => ({
      kind: 'skill' as const,
      key: `skill:${skill.name}`,
      skill,
    })),
  ]
})

// A header is drawn on the first row of each kind.
function groupLabel(item: SearchItem, index: number): string | null {
  if (!hasQuery.value) return null
  if (index > 0 && items.value[index - 1].kind === item.kind) return null
  return t(`chat.searchGroup.${item.kind}`)
}

function formatSource(source: string): string {
  const map: Record<string, string> = {
    api_server: 'API Server',
    cli: 'CLI',
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
    matrix: 'Matrix',
    whatsapp: 'WhatsApp',
    signal: 'Signal',
    cron: 'Cron',
    weixin: 'WeChat',
    global_agent: 'Global Agent',
  }
  return map[source] || source
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const date = new Date(ts * 1000)
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getSessionTitle(session: SessionItem): string {
  const title = session.title?.trim()
  if (title) return title
  if (session.preview?.trim()) return session.preview.trim()
  return session.id
}

async function loadRecentSessions() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const sessions = profileFilter.value
      ? await fetchSessions(runtimeSource.value, 8, profileFilter.value)
      : await fetchSessions(runtimeSource.value, 8)
    if (seq !== requestSeq) return
    recentSessions.value = sessions
    searchResults.value = []
    activeIndex.value = 0
  } catch (err) {
    if (seq !== requestSeq) return
    paneError.value = err instanceof Error ? err.message : t('chat.searchFailed')
  } finally {
    if (seq === requestSeq) {
      loading.value = false
    }
  }
}

// Skills are fetched whole and filtered here: the endpoint returns the
// profile's catalog in one response and has no query parameter, so a request
// per keystroke would buy nothing.
async function searchSkills(text: string): Promise<SkillInfo[]> {
  const data = await fetchSkills(profileFilter.value)
  const needle = text.toLowerCase()
  if (!data) return []
  const out: SkillInfo[] = []
  for (const category of data.categories || []) {
    for (const skill of category.skills || []) {
      if (out.length >= 10) return out
      const haystack = `${skill.name} ${skill.description || ''}`.toLowerCase()
      if (haystack.includes(needle)) out.push(skill)
    }
  }
  return out
}

async function runSearch(text: string) {
  const seq = ++requestSeq
  const trimmed = text.trim()
  if (!trimmed) {
    searchResults.value = []
    fileResults.value = []
    skillResults.value = []
    filesTruncated.value = false
    activeIndex.value = 0
    return
  }
  loading.value = true
  try {
    // One slow or failing source must not blank the other two — each settles on
    // its own and an error there costs that group, not the palette.
    const [sessions, files, skills] = await Promise.allSettled([
      profileFilter.value
        ? searchSessions(trimmed, runtimeSource.value, 10, profileFilter.value)
        : searchSessions(trimmed, runtimeSource.value, 10),
      searchFiles(trimmed, 10),
      searchSkills(trimmed),
    ])
    if (seq !== requestSeq) return
    searchResults.value = sessions.status === 'fulfilled' ? sessions.value ?? [] : []
    fileResults.value = files.status === 'fulfilled' ? files.value?.entries ?? [] : []
    filesTruncated.value = files.status === 'fulfilled' ? !!files.value?.truncated : false
    skillResults.value = skills.status === 'fulfilled' ? skills.value ?? [] : []
    activeIndex.value = 0
    if (sessions.status === 'rejected') {
      paneError.value =
        sessions.reason instanceof Error ? sessions.reason.message : t('chat.searchFailed')
    }
  } finally {
    if (seq === requestSeq) {
      loading.value = false
    }
  }
}

async function ensureChatSessionsLoaded() {
  if (chatStore.sessions.length === 0) {
    await chatStore.loadSessions(chatStore.sessionProfileFilter)
  }
}

async function openItem(item: SearchItem) {
  if (item.kind === 'file') return openFileItem(item.entry)
  if (item.kind === 'skill') return openSkillItem()
  return openSessionItem(item.session)
}

// Land in the folder that holds the match rather than opening the file blind:
// the palette searched by name, and the surrounding folder is what tells you
// whether this is the one you meant.
async function openFileItem(entry: FileEntry) {
  sessionSearchOpen.value = false
  const parent = entry.isDir ? entry.path : entry.path.split('/').slice(0, -1).join('/')
  await router.push({ name: 'hermes.chat', query: { surface: 'files' } })
  await filesStore.navigateTo(parent)
}

// There is no per-skill route, so this opens the market's skills section.
async function openSkillItem() {
  sessionSearchOpen.value = false
  await router.push({ name: 'hermes.chat', query: { surface: 'skills' } })
}

async function openSessionItem(item: SessionItem) {
  const messageId = item.matched_message_id != null ? String(item.matched_message_id) : null
  sessionSearchOpen.value = false

  await ensureChatSessionsLoaded()
  if (!chatStore.sessions.some(session => session.id === item.id) && typeof chatStore.addOrUpdateSession === 'function') {
    chatStore.addOrUpdateSession({
      id: item.id,
      profile: item.profile || 'default',
      title: item.title || '',
      source: item.source,
      messages: [],
      createdAt: Math.round(item.started_at * 1000),
      updatedAt: Math.round((item.last_active || item.ended_at || item.started_at) * 1000),
      model: item.model,
      provider: item.provider || item.billing_provider || '',
      messageCount: item.message_count,
      endedAt: item.ended_at != null ? Math.round(item.ended_at * 1000) : null,
      lastActiveAt: item.last_active != null ? Math.round(item.last_active * 1000) : undefined,
      workspace: item.workspace || null,
    })
  }
  await chatStore.switchSession(item.id, messageId)
  const routeName = chatStore.runtimeMode === 'global_agent' ? 'hermes.globalAgentSession' : 'hermes.session'
  if (router.currentRoute.value.name !== routeName || router.currentRoute.value.params.sessionId !== item.id) {
    await router.push({ name: routeName, params: { sessionId: item.id } })
  }
}

function closeModal() {
  sessionSearchOpen.value = false
}

function moveSelection(delta: number) {
  const list = items.value
  if (list.length === 0) return
  const next = activeIndex.value + delta
  activeIndex.value = (next + list.length) % list.length
}

async function handleKeydown(e: KeyboardEvent) {
  if (!sessionSearchOpen.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const item = items.value[activeIndex.value]
    if (item) {
      await openItem(item)
    }
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    closeModal()
  }
}

watch(
  () => sessionSearchOpen.value,
  async (open) => {
    if (!open) {
      query.value = ''
      searchResults.value = []
      recentSessions.value = []
      activeIndex.value = 0
      return
    }

    query.value = ''
    searchResults.value = []
    activeIndex.value = 0
    await loadRecentSessions()
    await nextTick()
    inputRef.value?.focus?.()
  },
)

watch(query, (value) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  debounceTimer = setTimeout(() => {
    if (!sessionSearchOpen.value) return
    void runSearch(value)
  }, 160)
})

watch(items, () => {
  if (activeIndex.value >= items.value.length) {
    activeIndex.value = 0
  }
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
})
</script>

<template>
  <NModal
    v-model:show="sessionSearchOpen"
    preset="card"
    :title="t('chat.searchTitle')"
    :style="{ width: 'min(760px, calc(100vw - 24px))' }"
    :mask-closable="true"
    :auto-focus="false"
  >
    <p v-if="paneError" class="pane-notice" data-testid="session-search-error">{{ paneError }}</p>
    <div class="session-search-modal">
      <div class="search-header">
        <div class="search-title">{{ t('chat.searchSubtitle') }}</div>
        <div class="search-hint">{{ t('chat.searchHint') }}</div>
      </div>
      <div class="search-scope">{{ t('chat.searchScope') }}</div>

      <NInput
        ref="inputRef"
      v-model:value="query"
      :placeholder="t('chat.searchPlaceholder')"
      clearable
      size="large"
    />

      <div class="search-body">
        <NSpin :show="loading">
          <div v-if="items.length === 0" class="search-empty">
            {{ hasQuery ? t('chat.searchNoResults') : t('chat.searchEmpty') }}
          </div>
          <div v-else class="result-list">
            <template v-for="(item, idx) in items" :key="item.key">
              <div v-if="groupLabel(item, idx)" class="result-group">{{ groupLabel(item, idx) }}</div>
              <button
                class="result-item"
                :class="{ active: idx === activeIndex }"
                :data-kind="item.kind"
                @click="openItem(item)"
                @mouseenter="activeIndex = idx"
              >
                <template v-if="item.kind === 'task'">
                  <div class="result-main">
                    <div class="result-title-row">
                      <span class="result-title">{{ getSessionTitle(item.session) }}</span>
                      <span class="result-source">{{ formatSource(item.session.source) }}</span>
                    </div>
                    <div class="result-snippet">
                      {{ hasQuery
                        ? item.session.snippet || t('chat.searchNoSnippet')
                        : item.session.preview || t('chat.searchRecent') }}
                    </div>
                  </div>
                  <div class="result-meta">
                    <span class="result-time">
                      {{ formatTime(item.session.last_active || item.session.started_at) }}
                    </span>
                    <span v-if="hasQuery && item.session.matched_message_id != null" class="result-match">
                      #{{ item.session.matched_message_id }}
                    </span>
                  </div>
                </template>

                <template v-else-if="item.kind === 'file'">
                  <div class="result-main">
                    <div class="result-title-row">
                      <span class="result-title">{{ item.entry.name }}</span>
                    </div>
                    <div class="result-snippet">{{ item.entry.path }}</div>
                  </div>
                </template>

                <template v-else>
                  <div class="result-main">
                    <div class="result-title-row">
                      <span class="result-title">{{ item.skill.name }}</span>
                      <span v-if="item.skill.enabled === false" class="result-source">
                        {{ t('skills.stateDisabled') }}
                      </span>
                    </div>
                    <div class="result-snippet">
                      {{ item.skill.description || t('skills.noDescription') }}
                    </div>
                  </div>
                </template>
              </button>
            </template>
            <!-- The file walk is capped; say so rather than letting a partial
                 list read as the whole workspace. -->
            <div v-if="filesTruncated" class="result-group result-group--note">
              {{ t('chat.searchFilesTruncated') }}
            </div>
          </div>
        </NSpin>
      </div>

      <div class="search-footer">
        <span>{{ t('chat.searchEnterHint') }}</span>
        <NButton quaternary size="small" @click="closeModal">{{ t('common.cancel') }}</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.pane-notice {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  white-space: pre-line;
}


.session-search-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.search-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.search-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.search-hint {
  font-size: 12px;
  color: $text-muted;
}

.search-scope {
  font-size: 12px;
  color: $text-muted;
  line-height: 1.5;
}

.search-body {
  max-height: min(60vh, 540px);
  overflow: hidden;
}

.search-empty {
  padding: 28px 0;
  text-align: center;
  color: $text-muted;
  font-size: 13px;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(60vh, 540px);
  overflow-y: auto;
  padding-right: 2px;
}

.result-item {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  color: $text-primary;
  text-align: left;
  cursor: pointer;
  transition: border-color $transition-fast, background-color $transition-fast, transform $transition-fast;

  &:hover,
  &.active {
    border-color: $accent-muted;
    background: rgba(var(--accent-primary-rgb), 0.04);
  }
}

.result-main {
  flex: 1;
  min-width: 0;
}

.result-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.result-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-source {
  flex-shrink: 0;
  font-size: 11px;
  color: $text-muted;
}

.result-snippet {
  margin-top: 4px;
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.result-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 11px;
  color: $text-muted;
  flex-shrink: 0;
}

.result-match {
  font-family: $font-code;
}

.result-group {
  padding: 10px 4px 4px;
  font-size: 12px;
  color: var(--fg-disabled);
}

.result-group--note {
  padding-top: 8px;
}

.search-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: $text-muted;
}

@media (max-width: $breakpoint-mobile) {
  :deep(.n-modal-body-wrapper) {
    width: calc(100vw - 24px);
  }

  .search-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .result-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .result-meta {
    align-items: flex-start;
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
