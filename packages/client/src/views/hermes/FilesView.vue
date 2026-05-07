<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useFilesStore } from '@/stores/hermes/files'
import { isUserMode } from '@/api/client'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileBreadcrumb from '@/components/hermes/files/FileBreadcrumb.vue'
import FileToolbar from '@/components/hermes/files/FileToolbar.vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileEditor from '@/components/hermes/files/FileEditor.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'
import type { FileEntry } from '@/api/hermes/files'

const filesStore = useFilesStore()
const { t } = useI18n()
const showUserModeHeader = computed(() => isUserMode())
const folderCount = computed(() => filesStore.sortedEntries.filter(entry => entry.isDir).length)
const fileCount = computed(() => filesStore.sortedEntries.filter(entry => !entry.isDir).length)
const currentWorkspacePath = computed(() => filesStore.currentPath || t('files.breadcrumbRoot'))

const contextMenuRef = ref<InstanceType<typeof FileContextMenu> | null>(null)
const showUpload = ref(false)
const showRenameModal = ref(false)
const showTreePanel = ref(false)
const renameMode = ref<'newFile' | 'newFolder' | 'rename'>('newFile')
const renameEntry = ref<FileEntry | null>(null)

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  contextMenuRef.value?.show(e, entry)
}

function handleShowNewFile() {
  renameMode.value = 'newFile'
  renameEntry.value = null
  showRenameModal.value = true
}

function handleShowNewFolder() {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  showRenameModal.value = true
}

function handleRename(entry: FileEntry) {
  renameMode.value = 'rename'
  renameEntry.value = entry
  showRenameModal.value = true
}

onMounted(() => {
  filesStore.fetchEntries('')
})
</script>

<template>
  <div class="files-view">
    <div
      v-if="showTreePanel"
      class="files-tree-overlay"
      @click="showTreePanel = false"
    />
    <div class="files-tree-panel" :class="{ 'mobile-visible': showTreePanel }">
      <FileTree />
    </div>
    <div class="files-main-panel">
      <header v-if="showUserModeHeader" class="files-page-header">
        <div>
          <h2>{{ t('files.title') }}</h2>
          <span class="workspace-scope">{{ t('files.workspaceScope') }}</span>
        </div>
        <div class="workspace-stats" aria-label="workspace stats">
          <span>{{ t('files.workspaceFolders', { count: folderCount }) }}</span>
          <span>{{ t('files.workspaceFiles', { count: fileCount }) }}</span>
          <span>{{ t('files.workspaceCurrentPath', { path: currentWorkspacePath }) }}</span>
        </div>
      </header>
      <div class="files-toolbar-row">
        <NButton
          size="small"
          class="tree-toggle"
          @click="showTreePanel = true"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </template>
          {{ t('files.fileTree') }}
        </NButton>
        <FileToolbar
          @show-new-file="handleShowNewFile"
          @show-new-folder="handleShowNewFolder"
          @show-upload="showUpload = true"
        />
      </div>
      <FileBreadcrumb />
      <div class="files-content">
        <FileEditor v-if="filesStore.editingFile" />
        <FilePreview v-else-if="filesStore.previewFile" />
        <FileList v-else @contextmenu-entry="handleContextMenu" />
      </div>
    </div>
    <FileContextMenu ref="contextMenuRef" @rename="handleRename" />
    <FileUploadModal v-model:show="showUpload" />
    <FileRenameModal v-model:show="showRenameModal" :mode="renameMode" :entry="renameEntry" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.files-view {
  display: flex;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.files-tree-overlay {
  display: none;
}

.files-tree-panel {
  width: 240px;
  min-width: 180px;
  max-width: 400px;
  border-right: 1px solid $border-color;
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

.files-toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;

  :deep(.file-toolbar) {
    flex: 1;
    min-width: 0;
    border-bottom: none;
  }
}

.tree-toggle {
  display: none;
  margin-left: 12px;
}

.files-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 72px;
  padding: 16px 24px;
  border-bottom: 1px solid $border-color;
  background: linear-gradient(180deg, rgba(var(--accent-primary-rgb), 0.05), transparent);

  h2 {
    margin: 0;
    color: $text-primary;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: 0;
  }

  .workspace-scope {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    max-width: 100%;
    margin-top: 6px;
    padding: 3px 8px;
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.08);
    border: 1px solid rgba(var(--accent-primary-rgb), 0.14);
    border-radius: 6px;
    font-size: 12px;
  }
}

.workspace-stats {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
  color: $text-secondary;

  span {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 4px 8px;
    border: 1px solid $border-color;
    border-radius: 6px;
    background: rgba(var(--accent-primary-rgb), 0.04);
    font-size: 12px;
  }
}

.files-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .files-view {
    flex-direction: row;
  }

  .files-tree-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(82vw, 320px);
    max-width: none;
    height: auto;
    padding-top: 56px;
    border-right: none;
    border-bottom: none;
    background: $bg-card;
    box-shadow: 2px 0 12px rgba(0, 0, 0, 0.18);
    z-index: 80;
    transform: translateX(-100%);
    transition: transform $transition-normal;

    &.mobile-visible {
      transform: translateX(0);
    }
  }

  .files-tree-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    z-index: 79;
  }

  .files-toolbar-row {
    gap: 4px;
    padding: 8px;
    flex-wrap: wrap;
  }

  .tree-toggle {
    display: inline-flex;
    margin-left: 0;
  }

  .files-page-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
    min-height: 64px;
    padding: 12px 16px 12px 52px;

    h2 {
      font-size: 18px;
    }
  }

  .workspace-stats {
    justify-content: flex-start;
  }
}
</style>
