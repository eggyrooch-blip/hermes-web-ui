<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import FilesPanel from './FilesPanel.vue'
import ArtifactBrowser from './ArtifactBrowser.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import { useChatStore } from '@/stores/hermes/chat'
import {
  decodeDisplayPathSegments,
  isHtmlFile,
  useFilesStore,
} from '@/stores/hermes/files'
import { useProfilesStore } from '@/stores/hermes/profiles'

type DetailSurface = 'overview' | 'file' | 'files'

interface SessionArtifact {
  name: string
  path: string
}

interface DiffMetadata {
  changeId: string
  fileId: number
  sessionId: string
  profile?: string | null
}

interface OpenArtifact extends SessionArtifact {
  key: string
  kind: 'preview' | 'browser'
  diff?: DiffMetadata
}

interface SessionWorkspaceState {
  surface: DetailSurface
  openArtifacts: OpenArtifact[]
  selectedKey: string | null
}

const chatStore = useChatStore()
const filesStore = useFilesStore()
const profilesStore = useProfilesStore()
const { t } = useI18n()
const artifactBrowserRef = ref<InstanceType<typeof ArtifactBrowser> | null>(null)
const workspaces = new Map<string, SessionWorkspaceState>()
const editorOwnerKey = ref<string | null>(filesStore.editingFile ? '__external__' : null)
const tabPanelId = `detail-artifact-panel-${getCurrentInstance()?.uid ?? 0}`

const workspaceScope = computed(() => [
  chatStore.runtimeMode,
  chatStore.activeSession?.profile || profilesStore.activeProfileName || '__default__',
].join(':'))
const sessionKey = computed(() => `${workspaceScope.value}:${chatStore.activeSessionId || '__new__'}`)
const editorScopeActive = computed(() => (
  !filesStore.editingFile || editorOwnerKey.value === sessionKey.value
))

function workspaceFor(key: string): SessionWorkspaceState {
  let value = workspaces.get(key)
  if (!value) {
    value = { surface: 'overview', openArtifacts: [], selectedKey: null }
    workspaces.set(key, value)
  }
  return value
}

const workspace = ref<SessionWorkspaceState>(workspaceFor(sessionKey.value))
const artifacts = computed<SessionArtifact[]>(() => chatStore.sessionArtifacts)
const selectedArtifact = computed(() => workspace.value.openArtifacts.find(
  artifact => artifact.key === workspace.value.selectedKey,
) || null)

function canonicalWorkspacePath(path: string): string {
  const decoded = decodeDisplayPathSegments(path.trim().replace(/^\/+/, ''))
  const parts: string[] = []
  for (const segment of decoded.replace(/^workspace\//, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else parts.push(segment)
    } else {
      parts.push(segment)
    }
  }
  return parts.join('/')
}

function displayName(path: string, preferredName?: string): string {
  const candidate = preferredName || path.split('/').filter(Boolean).pop() || path
  return decodeDisplayPathSegments(candidate)
}

function upsertArtifact(input: Omit<OpenArtifact, 'key'>): OpenArtifact {
  const key = canonicalWorkspacePath(input.path)
  let artifact = workspace.value.openArtifacts.find(item => item.key === key)
  if (!artifact) {
    artifact = { ...input, key }
    workspace.value.openArtifacts.push(artifact)
  } else {
    artifact.name = input.name
    artifact.path = input.path
    artifact.kind = input.kind
    artifact.diff = input.diff
  }
  workspace.value.selectedKey = key
  workspace.value.surface = 'file'
  return artifact
}

function loadPreviewArtifact(artifact: OpenArtifact): void {
  if (artifact.diff) {
    void filesStore.previewWorkspaceDiffFile({
      displayPath: artifact.path,
      fileName: artifact.name,
      ...artifact.diff,
    })
    return
  }
  void filesStore.previewByDisplayPath(artifact.path, artifact.name)
}

function selectArtifact(artifact: OpenArtifact): void {
  workspace.value.selectedKey = artifact.key
  workspace.value.surface = 'file'
  filesStore.closePreview()
  if (artifact.kind === 'browser') {
    artifactBrowserRef.value?.load(artifact)
  } else {
    loadPreviewArtifact(artifact)
  }
}

function tabId(index: number): string {
  return `${tabPanelId}-tab-${index}`
}

function handleTabKeydown(event: KeyboardEvent, index: number): void {
  const count = workspace.value.openArtifacts.length
  if (!count) return
  let target = index
  if (event.key === 'ArrowLeft') target = (index - 1 + count) % count
  else if (event.key === 'ArrowRight') target = (index + 1) % count
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = count - 1
  else return

  event.preventDefault()
  const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]')
  selectArtifact(workspace.value.openArtifacts[target])
  nextTick(() => tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus())
}

function openArtifact(artifact: SessionArtifact): void {
  const name = displayName(artifact.path, artifact.name)
  const remembered = upsertArtifact({
    name,
    path: artifact.path,
    kind: isHtmlFile(name) ? 'browser' : 'preview',
  })
  if (remembered.kind === 'browser') {
    artifactBrowserRef.value?.load(remembered)
  } else {
    filesStore.closePreview()
    loadPreviewArtifact(remembered)
  }
}

function rememberPreviewArtifact(): void {
  const preview = filesStore.previewFile
  if (!preview) return
  upsertArtifact({
    name: displayName(preview.path),
    path: preview.path,
    kind: 'preview',
    ...(preview.diff ? { diff: { ...preview.diff } } : {}),
  })
}

function closeArtifact(artifact: OpenArtifact): void {
  const index = workspace.value.openArtifacts.findIndex(item => item.key === artifact.key)
  if (index < 0) return
  workspace.value.openArtifacts.splice(index, 1)
  if (workspace.value.selectedKey !== artifact.key) {
    const selectedIndex = workspace.value.openArtifacts.findIndex(
      item => item.key === workspace.value.selectedKey,
    )
    if (selectedIndex >= 0) {
      nextTick(() => document.getElementById(tabId(selectedIndex))?.focus())
    }
    return
  }

  const adjacent = workspace.value.openArtifacts[Math.min(index, workspace.value.openArtifacts.length - 1)]
  if (adjacent) {
    selectArtifact(adjacent)
    const adjacentIndex = workspace.value.openArtifacts.findIndex(item => item.key === adjacent.key)
    nextTick(() => document.getElementById(tabId(adjacentIndex))?.focus())
  } else {
    workspace.value.selectedKey = null
    workspace.value.surface = 'overview'
    filesStore.closePreview()
  }
}

function openFiles(): void {
  filesStore.closePreview()
  workspace.value.surface = 'files'
}

function markEditorScope(): void {
  editorOwnerKey.value = sessionKey.value
}

function restoreWorkspace(): void {
  if (workspace.value.surface === 'files') return
  const selected = selectedArtifact.value
  if (selected) {
    selectArtifact(selected)
  } else {
    workspace.value.surface = 'overview'
  }
}

function consumeBrowserArtifact(): boolean {
  const request = filesStore.browserArtifactRequest
  if (!request) return false
  filesStore.browserArtifactRequest = null
  const artifact = upsertArtifact({
    name: displayName(request.path, request.name),
    path: request.path,
    kind: 'browser',
  })
  filesStore.closePreview()
  artifactBrowserRef.value?.load(artifact)
  return true
}

// Requests issued by chat cards carry a counter; previews opened inside the
// secondary FilesPanel only change previewFile.path. Watch both entry paths.
watch(() => filesStore.previewPanelRequestedAt, rememberPreviewArtifact)
watch(() => filesStore.previewFile?.path, path => {
  if (path) rememberPreviewArtifact()
})
watch(() => filesStore.browserArtifactRequestedAt, () => consumeBrowserArtifact())
watch(() => filesStore.editingFile, editor => {
  if (!editor) editorOwnerKey.value = null
}, { flush: 'sync' })

watch(sessionKey, key => {
  workspace.value = workspaceFor(key)
  filesStore.resetBrowser()
  filesStore.cancelPendingEditor()
  filesStore.closePreview()
  nextTick(restoreWorkspace)
})

onMounted(() => {
  nextTick(() => {
    if (consumeBrowserArtifact()) return
    if (filesStore.previewFile) {
      rememberPreviewArtifact()
      return
    }
    restoreWorkspace()
  })
})
</script>

<template>
  <div class="detail-panel">
    <div class="detail-panel-header">
      <div
        class="detail-tab-strip"
        role="tablist"
        :aria-label="t('files.openArtifacts')"
      >
        <div
          v-for="(artifact, index) in workspace.openArtifacts"
          :key="artifact.key"
          class="detail-tab-item"
          :class="{ 'is-active': artifact.key === workspace.selectedKey && workspace.surface === 'file' }"
        >
          <button
            class="detail-tab"
            type="button"
            role="tab"
            :id="tabId(index)"
            :tabindex="artifact.key === workspace.selectedKey ? 0 : -1"
            :aria-selected="artifact.key === workspace.selectedKey && workspace.surface === 'file'"
            :aria-controls="tabPanelId"
            :title="artifact.path"
            @click="selectArtifact(artifact)"
            @keydown="handleTabKeydown($event, index)"
          >
            <span class="detail-tab-name">{{ artifact.name }}</span>
          </button>
          <button
            class="detail-tab-close"
            type="button"
            :aria-label="t('files.closeArtifact', { name: artifact.name })"
            @click.stop="closeArtifact(artifact)"
          >
            ×
          </button>
        </div>
      </div>
      <div class="detail-header-actions">
        <button
          class="detail-open-files"
          type="button"
          :aria-label="t('files.browseWorkspace')"
          :title="t('files.browseWorkspace')"
          @click="openFiles"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path fill="currentColor" d="M10 4H2v16h20V6H12zM4 8h16v10H4z" />
          </svg>
        </button>
        <button
          class="detail-tab-add"
          type="button"
          :aria-label="t('files.openFile')"
          :title="t('files.openFile')"
          @click="openFiles"
        >
          +
        </button>
      </div>
    </div>

    <div class="detail-panel-body">
      <div
        v-show="workspace.surface === 'overview'"
        class="detail-overview"
      >
        <template v-if="artifacts.length > 0">
          <button
            v-for="artifact in artifacts"
            :key="artifact.path"
            class="detail-artifact-card"
            type="button"
            :title="artifact.path"
            @click="openArtifact(artifact)"
          >
            <svg class="detail-artifact-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 2l4 4h-4z" />
            </svg>
            <span class="detail-artifact-name">{{ artifact.name }}</span>
          </button>
        </template>
        <div v-else class="detail-empty">
          <span>{{ t('files.noArtifacts') }}</span>
          <button type="button" class="detail-browse-workspace" @click="openFiles">
            {{ t('files.browseWorkspace') }}
          </button>
        </div>
      </div>

      <FilesPanel
        v-if="workspace.surface === 'files'"
        :key="sessionKey"
        :editor-scope-active="editorScopeActive"
        @editor-opened="markEditorScope"
      />

      <div
        v-show="workspace.surface === 'file'"
        :id="tabPanelId"
        class="detail-artifact-panel"
        role="tabpanel"
        :aria-labelledby="workspace.openArtifacts.findIndex(item => item.key === workspace.selectedKey) >= 0 ? tabId(workspace.openArtifacts.findIndex(item => item.key === workspace.selectedKey)) : undefined"
      >
        <FilePreview
          v-if="selectedArtifact?.kind === 'preview' && filesStore.previewFile"
          :show-close="false"
        />
        <div
          v-else-if="selectedArtifact?.kind === 'preview'"
          class="detail-file-loading"
        >
          {{ t('files.loading') }}
        </div>

        <ArtifactBrowser
          :key="sessionKey"
          v-show="selectedArtifact?.kind === 'browser'"
          ref="artifactBrowserRef"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.detail-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.detail-panel-header {
  display: flex;
  align-items: stretch;
  min-width: 0;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.detail-tab-strip {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.detail-tab-item {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: 220px;
  margin: 5px 0 5px 6px;
  color: var(--text-color-2, inherit);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;

  &.is-active {
    color: var(--text-color-1, inherit);
    background: var(--hover-color, rgba(127, 127, 127, 0.12));
    border-color: var(--border-color, rgba(255, 255, 255, 0.08));
  }
}

.detail-tab,
.detail-tab-close,
.detail-open-files,
.detail-tab-add,
.detail-browse-workspace {
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.detail-tab {
  min-width: 0;
  padding: 6px 4px 6px 10px;
  font-size: 13px;
}

.detail-tab-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-tab-close {
  padding: 4px 8px 4px 4px;
  font-size: 16px;
  line-height: 1;
  opacity: 0.65;

  &:hover {
    opacity: 1;
  }
}

.detail-header-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  padding: 4px 6px;
  background: var(--card-color, inherit);
}

.detail-open-files,
.detail-tab-add {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;

  &:hover {
    background: var(--hover-color, rgba(127, 127, 127, 0.12));
  }
}

.detail-tab-add {
  font-size: 22px;
  font-weight: 300;
  line-height: 1;
}

.detail-panel-body {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.detail-panel-body > * {
  flex: 1;
  min-height: 0;
}

.detail-artifact-panel {
  display: flex;
  flex-direction: column;
}

.detail-artifact-panel > * {
  flex: 1;
  min-height: 0;
}

.detail-overview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  overflow-y: auto;
}

.detail-artifact-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  color: var(--text-color-1, inherit);
  background: var(--card-color, rgba(127, 127, 127, 0.06));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  cursor: pointer;

  &:hover {
    background: var(--hover-color, rgba(127, 127, 127, 0.14));
  }
}

.detail-artifact-icon {
  flex-shrink: 0;
  opacity: 0.75;
}

.detail-artifact-name {
  overflow: hidden;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.detail-empty,
.detail-file-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--text-color-3, rgba(127, 127, 127, 0.7));
}

.detail-empty {
  flex-direction: column;
  gap: 10px;
}

.detail-browse-workspace {
  padding: 6px 10px;
  color: var(--primary-color, #4f8cff);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
}
</style>
