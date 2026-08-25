<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { useProfilesStore } from '@/stores/hermes/profiles'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileBreadcrumb from '@/components/hermes/files/FileBreadcrumb.vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileEditor from '@/components/hermes/files/FileEditor.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import { fetchRecentFiles, type FileEntry } from '@/api/hermes/files'
import { useChatStore } from '@/stores/hermes/chat'
import type { LibraryView } from '@/components/hermes/files/FileTree.vue'
import type { FileTypeFilter } from '@/components/hermes/files/file-type-filter'

// `embedded` lets the file library render inside the chat sidebar surface,
// which owns the viewport height. The root is already `height: 100%`, so this
// flag only exists so the host can pass it; default false keeps the standalone
// route unchanged.
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const filesStore = useFilesStore()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()
const editorScope = computed(() => `files-view:${profilesStore.activeProfileName || '__default__'}`)
const scopedEditingFile = computed(() => filesStore.getEditingFile(editorScope.value))

const { t } = useI18n()

// Prototype view tabs. Only `recent` is backed by data locally — the two share
// views have no backend yet, so they render an honest empty state.
type ViewTab = 'recent' | 'sharedByMe' | 'sharedWithMe'
const VIEW_TABS: Array<{ key: ViewTab; label: string }> = [
  { key: 'recent', label: 'files.tabRecent' },
  { key: 'sharedByMe', label: 'files.tabSharedByMe' },
  { key: 'sharedWithMe', label: 'files.tabSharedWithMe' },
]
const viewTab = ref<ViewTab>('recent')

const TYPE_OPTIONS: Array<{ key: FileTypeFilter; label: string }> = [
  { key: 'all', label: 'files.typeAll' },
  { key: 'doc', label: 'files.typeDoc' },
  { key: 'sheet', label: 'files.typeSheet' },
  { key: 'image', label: 'files.typeImage' },
  { key: 'other', label: 'files.typeOther' },
]
const typeFilter = ref<FileTypeFilter>('all')
const showTypeMenu = ref(false)

// Which rail view is open. `tree` is the document browser (the default and the
// only one the standalone panel has ever had); the other two are the
// prototype's 最近 / 本地产物, both answered from real data.
const libraryView = ref<LibraryView>('tree')
const recentEntries = ref<FileEntry[]>([])
const recentLoading = ref(false)
const recentTruncated = ref(false)

async function loadRecent() {
  recentLoading.value = true
  try {
    const res = await fetchRecentFiles(50)
    recentEntries.value = res.entries
    recentTruncated.value = res.truncated
  } catch {
    recentEntries.value = []
    recentTruncated.value = false
  } finally {
    recentLoading.value = false
  }
}

// 本地产物 = what the runs actually wrote (the MEDIA: paths the assistant
// emitted), which is the same list the run panel's 产物 section shows. No
// backend call: it is derived from the transcript already in the store.
const artifactEntries = computed<FileEntry[]>(() =>
  chatStore.sessionArtifacts.map(artifact => ({
    name: artifact.name,
    path: artifact.path.replace(/^\/workspace\//, ''),
    isDir: false,
    size: 0,
    modTime: '',
  })),
)

function selectView(view: LibraryView) {
  libraryView.value = view
  if (view === 'recent') void loadRecent()
}

// The page title follows the rail, exactly like the prototype: the selected
// view names the page, and only the document browser falls back to the folder.
const showBreadcrumbTitle = computed(() => libraryView.value === 'tree')
const viewTitle = computed(() =>
  libraryView.value === 'recent' ? t('files.viewRecent') : t('files.viewLocal'),
)

watch(() => profilesStore.activeProfileName, () => {
  if (libraryView.value === 'recent') void loadRecent()
})

const contextMenuRef = ref<InstanceType<typeof FileContextMenu> | null>(null)
/**
 * What the context menu tried and could not do. It lives here because a context
 * menu closes the moment an item is picked, leaving it nowhere to report.
 */
const fileOpError = ref('')
const showUpload = ref(false)
const showRenameModal = ref(false)
const renameMode = ref<'newFile' | 'newFolder' | 'rename'>('newFile')
const renameEntry = ref<FileEntry | null>(null)
const renameTargetPath = ref<string | null>(null)

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  contextMenuRef.value?.show(e, entry)
}

function handleShowNewFile() {
  renameMode.value = 'newFile'
  renameEntry.value = null
  renameTargetPath.value = null
  showRenameModal.value = true
}

function handleShowNewFolder() {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  renameTargetPath.value = null
  showRenameModal.value = true
}

function handleContextNewFolder(entry: FileEntry) {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  renameTargetPath.value = entry.isDir ? entry.path : filesStore.currentPath
  showRenameModal.value = true
}

function handleRename(entry: FileEntry) {
  renameMode.value = 'rename'
  renameEntry.value = entry
  renameTargetPath.value = null
  showRenameModal.value = true
}

async function loadRoot() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  await filesStore.fetchEntries('')
}

onMounted(() => {
  void loadRoot()
})
</script>

<template>
  <div class="files-view" :class="{ 'is-embedded': props.embedded }">
    <!-- The context menu closes on select, so what it started reports here. -->
    <p v-if="fileOpError" class="file-op-error" data-testid="file-op-error">
      <span class="file-op-error__text">{{ fileOpError }}</span>
      <button
        type="button"
        class="file-op-error__close"
        :title="t('common.close')"
        @click="fileOpError = ''"
      >&times;</button>
    </p>
    <div class="files-tree-panel">
      <FileTree
        show-actions
        show-views
        :view="libraryView"
        @select-view="selectView"
        @show-new-file="handleShowNewFile"
        @show-new-folder="handleShowNewFolder"
        @show-upload="showUpload = true"
      />
    </div>
    <div class="files-main-panel">
      <!-- Prototype LibraryScreen has no top toolbar: the current location is
           the page title, and create/refresh live in the left-nav header. -->
      <FileBreadcrumb v-if="showBreadcrumbTitle" prominent />
      <h1 v-else class="t-h1 files-view-title">{{ viewTitle }}</h1>

      <!-- Prototype LibraryScreen: view tabs (最近访问 | 我分享的 | 与我共享)
           on the left, the 全部类型 filter on the right. Only the first tab
           has real data locally; the share tabs state their emptiness. -->
      <div class="files-viewbar">
        <div class="files-viewtabs" role="tablist">
          <button
            v-for="tab in VIEW_TABS"
            :key="tab.key"
            type="button"
            role="tab"
            class="files-viewtab"
            :class="{ 'is-on': viewTab === tab.key }"
            :aria-selected="viewTab === tab.key"
            @click="viewTab = tab.key"
          >
            {{ t(tab.label) }}
          </button>
        </div>
        <div class="files-typefilter">
          <button type="button" class="files-typefilter__btn" @click="showTypeMenu = !showTypeMenu">
            {{ t(TYPE_OPTIONS.find(o => o.key === typeFilter)!.label) }}
            <KpIcon name="line_down" :size="10" />
          </button>
          <template v-if="showTypeMenu">
            <div class="files-typefilter__backdrop" @click="showTypeMenu = false" />
            <div class="files-typefilter__menu">
              <button
                v-for="option in TYPE_OPTIONS"
                :key="option.key"
                type="button"
                class="files-typefilter__item"
                :class="{ 'is-on': typeFilter === option.key }"
                @click="typeFilter = option.key; showTypeMenu = false"
              >
                {{ t(option.label) }}
              </button>
            </div>
          </template>
        </div>
      </div>

      <div class="files-content">
        <KpEmptyState v-if="viewTab !== 'recent'" :title="t('files.sharedEmpty')" />
        <FileEditor
          v-else-if="scopedEditingFile"
          :editor-scope="editorScope"
        />
        <FilePreview v-else-if="filesStore.previewFile" />
        <!-- 本地产物: nothing to browse until a run has written something. -->
        <KpEmptyState
          v-else-if="libraryView === 'local' && artifactEntries.length === 0"
          :title="t('files.localEmpty')"
          :body="t('files.localEmptyBody')"
        />
        <FileList
          v-else
          :allow-edit="true"
          :editor-scope="editorScope"
          :type-filter="typeFilter"
          :entries="libraryView === 'tree' ? undefined : (libraryView === 'recent' ? recentEntries : artifactEntries)"
          :loading="libraryView === 'recent' && recentLoading"
          show-location
          @contextmenu-entry="handleContextMenu"
        />
      </div>
    </div>
    <FileContextMenu
      ref="contextMenuRef"
      :allow-edit="true"
      :editor-scope="editorScope"
      @failed="(reason: string) => (fileOpError = reason)"
      @rename="handleRename"
      @new-folder="handleContextNewFolder"
    />
    <FileUploadModal v-model:show="showUpload" />
    <FileRenameModal
      v-model:show="showRenameModal"
      :mode="renameMode"
      :entry="renameEntry"
      :target-path="renameTargetPath"
      :editor-scope="editorScope"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.file-op-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.file-op-error__text {
  flex: 1;
  min-width: 0;
}

.file-op-error__close {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}


.files-view {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

// Prototype LibraryScreen view bar: pill-tab group left, type filter right.
// Prototype rhythm: title →20px→ tab row →20px→ table. The prominent
// breadcrumb owns the first 20px; this row's 8px bottom + FileList's 12px top
// make the second.
// Measured: the prototype's tab row is 34 tall with 20px under it before the
// table starts. The list contributes 12 of its own, so 8 here.
.files-view-title {
  padding: 32px 40px 20px;
  flex-shrink: 0;
}

.files-viewbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 40px 8px;
  min-height: 34px;
  flex-shrink: 0;

  @media (max-width: $breakpoint-mobile) {
    padding: 0 12px 8px;
  }
}

.files-viewtabs {
  display: flex;
  gap: 4px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-2);
  flex: 0 0 auto;
}

.files-viewtab {
  padding: 4px 16px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);

  // The selected pill carries a hairline ring, not a drop shadow (measured:
  // inset 0 0 0 0.5px var(--divider)).
  &.is-on {
    background: var(--bg);
    color: var(--fg-title);
    box-shadow: inset 0 0 0 0.5px var(--divider);
  }
}

.files-typefilter {
  position: relative;
  flex: 0 0 auto;
}

.files-typefilter__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--gray-f7);
  color: var(--fg-secondary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  white-space: nowrap;
}

.files-typefilter__backdrop {
  position: fixed;
  inset: 0;
  z-index: 19;
}

.files-typefilter__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 128px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-notification, 0 8px 24px rgba(0, 0, 0, 0.12));
}

.files-typefilter__item {
  display: block;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--gray-fa);
  }

  &.is-on {
    background: var(--gray-f2);
    color: var(--fg-title);
    font-weight: var(--w-medium);
  }
}

.files-tree-panel {
  flex: 0 0 240px;
  width: 240px;
  min-width: 180px;
  max-width: 400px;
  border-right: 0.5px solid var(--divider);
  overflow-y: auto;
  flex-shrink: 0;
}

.files-main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.files-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .files-view {
    flex-direction: column;
  }

  .files-tree-panel {
    flex: 0 0 auto;
    width: 100%;
    max-width: none;
    max-height: 40vh;
    height: auto;
    border-right: none;
    border-bottom: 0.5px solid var(--divider);
  }
}
</style>
