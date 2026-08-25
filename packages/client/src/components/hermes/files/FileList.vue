<script setup lang="ts">
import { computed , ref } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { matchesTypeFilter, type FileTypeFilter } from '@/components/hermes/files/file-type-filter'
import { DEFAULT_EDITOR_SCOPE, useFilesStore, isHtmlFile, isPreviewableFile, isTextFile } from '@/stores/hermes/files'
import { downloadFile } from '@/api/hermes/download'
import KpIconBtn from '@/components/kippies/KpIconBtn.vue'
import KpAppIcon from '@/components/kippies/KpAppIcon.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import type { FileEntry } from '@/api/hermes/files'

const { t } = useI18n()
/** Failure loading or acting on the listing. */
const paneError = ref('')
const filesStore = useFilesStore()
const props = withDefaults(defineProps<{
  allowEdit?: boolean
  doubleClickEdits?: boolean
  editorScope?: string
  /** 全部类型 filter (prototype LibraryScreen); directories always pass. */
  typeFilter?: FileTypeFilter
  /**
   * An explicit list to render instead of the current directory. The library's
   * 最近 / 本地产物 views are flat lists that span folders, so they cannot come
   * from the store's cwd listing.
   */
  entries?: FileEntry[]
  loading?: boolean
  /** 位置 column — where the file sits, which only means something in a flat list. */
  showLocation?: boolean
}>(), {
  allowEdit: true,
  doubleClickEdits: true,
  editorScope: DEFAULT_EDITOR_SCOPE,
  typeFilter: 'all',
  showLocation: false,
})

const visibleEntries = computed(() =>
  (props.entries ?? filesStore.sortedEntries).filter(entry =>
    matchesTypeFilter(entry, props.typeFilter),
  ),
)

// 位置 = the folder holding the file; the root reads as the library's own name
// rather than an empty cell.
function locationOf(entry: FileEntry): string {
  const parent = entry.path.split('/').slice(0, -1).join('/')
  return parent || t('files.breadcrumbRoot')
}

const emit = defineEmits<{
  (e: 'contextmenu-entry', event: MouseEvent, entry: FileEntry): void
  (e: 'editor-opened'): void
}>()

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString()
}

// Keep AppIcon file glyphs by extension (prototype FILE_ICON / FILE_COLOR):
// a colored glyph on a white tile, never emoji.
const FILE_ICON: Record<string, string> = {
  dir: 'line_drawer',
  docx: 'line_content', doc: 'line_content', pdf: 'line_content', md: 'line_content', txt: 'line_content', log: 'line_content',
  xlsx: 'full_data', xls: 'full_data', csv: 'full_data',
  pptx: 'line_screening', ppt: 'line_screening',
  html: 'line_link', htm: 'line_link',
  png: 'line_photo', jpg: 'line_photo', jpeg: 'line_photo', gif: 'line_photo', svg: 'line_photo', webp: 'line_photo',
  json: 'line_setting', yaml: 'line_setting', yml: 'line_setting', toml: 'line_setting',
  zip: 'line_box', gz: 'line_box', tar: 'line_box',
}
const FILE_COLOR: Record<string, string> = {
  dir: 'var(--hue-blue)',
  docx: 'var(--hue-blue)', doc: 'var(--hue-blue)', pdf: 'var(--hue-orange)',
  xlsx: 'var(--hue-green)', xls: 'var(--hue-green)', csv: 'var(--hue-green)',
  pptx: 'var(--hue-orange)', ppt: 'var(--hue-orange)',
  html: 'var(--hue-purple)', htm: 'var(--hue-purple)',
  png: 'var(--hue-purple)', jpg: 'var(--hue-purple)', jpeg: 'var(--hue-purple)', gif: 'var(--hue-purple)', svg: 'var(--hue-purple)', webp: 'var(--hue-purple)',
  json: 'var(--hue-green)', yaml: 'var(--hue-green)', yml: 'var(--hue-green)', toml: 'var(--hue-green)',
  zip: 'var(--fg-secondary)', gz: 'var(--fg-secondary)', tar: 'var(--fg-secondary)',
}

function fileExt(entry: FileEntry): string {
  if (entry.isDir) return 'dir'
  return entry.name.split('.').pop()?.toLowerCase() || ''
}

function getFileIcon(entry: FileEntry): string {
  return FILE_ICON[fileExt(entry)] || 'line_content'
}

function getFileColor(entry: FileEntry): string {
  return FILE_COLOR[fileExt(entry)] || 'var(--fg-secondary)'
}

async function handlePreview(entry: FileEntry) {
  try {
    await filesStore.openPreview(entry)
  } catch {
    paneError.value = t('files.backendError')
  }
}

async function handleDoubleClick(entry: FileEntry) {
  if (entry.isDir) {
    filesStore.navigateTo(entry.path)
  } else if (isHtmlFile(entry.name)) {
    await handlePreview(entry)
  } else if (props.allowEdit && props.doubleClickEdits && isTextFile(entry.name)) {
    await handleEdit(entry)
  } else if (isPreviewableFile(entry.name)) {
    await handlePreview(entry)
  }
}

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  e.preventDefault()
  emit('contextmenu-entry', e, entry)
}

async function handleDownload(entry: FileEntry) {
  try {
    await downloadFile(entry.path, entry.name)
  } catch (err: any) {
    paneError.value = err.message || t('files.backendError')
  }
}

async function handleEdit(entry: FileEntry) {
  if (await filesStore.openEditor(entry.path, props.editorScope)) emit('editor-opened')
}
</script>

<template>
  <div class="file-list">
    <p v-if="paneError" class="pane-notice" data-testid="file-list-error">{{ paneError }}</p>
    <NSpin :show="props.loading || filesStore.loading">
      <KpEmptyState
        v-if="!props.loading && !filesStore.loading && visibleEntries.length === 0"
        :title="t('files.emptyDir')"
      />
      <div v-else class="file-list-items">
        <div class="file-list-header file-list-grid" :class="{ 'has-location': showLocation }">
          <div class="file-name sort-header" @click="filesStore.setSort('name')">
            {{ t('files.name') }}
            <span v-if="filesStore.sortBy === 'name'" class="sort-indicator">{{ filesStore.sortOrder === 'asc' ? '↑' : '↓' }}</span>
          </div>
          <div v-if="showLocation" class="file-location">{{ t('files.location') }}</div>
          <div class="file-size sort-header" @click="filesStore.setSort('size')">
            {{ t('files.size') }}
            <span v-if="filesStore.sortBy === 'size'" class="sort-indicator">{{ filesStore.sortOrder === 'asc' ? '↑' : '↓' }}</span>
          </div>
          <div class="file-date sort-header" @click="filesStore.setSort('modTime')">
            {{ t('files.modified') }}
            <span v-if="filesStore.sortBy === 'modTime'" class="sort-indicator">{{ filesStore.sortOrder === 'asc' ? '↑' : '↓' }}</span>
          </div>
          <div class="file-actions-placeholder" />
        </div>
        <div
          v-for="entry in visibleEntries"
          :key="entry.path"
          class="file-list-row file-list-grid"
          :class="{ 'has-location': showLocation }"
          @dblclick="handleDoubleClick(entry)"
          @contextmenu="handleContextMenu($event, entry)"
        >
          <div class="file-name">
            <KpAppIcon class="file-icon" :icon="getFileIcon(entry)" :color="getFileColor(entry)" :size="30" :radius="8" />
            <span class="file-label">{{ entry.name }}</span>
          </div>
          <div v-if="showLocation" class="file-location" :title="locationOf(entry)">{{ locationOf(entry) }}</div>
          <div class="file-size">{{ entry.isDir ? '—' : formatSize(entry.size) }}</div>
          <div class="file-date">{{ formatDate(entry.modTime) }}</div>
          <div class="file-actions">
            <KpIconBtn v-if="isPreviewableFile(entry.name) && !entry.isDir" name="line_eye" :size="15" :title="t('files.preview')" @click.stop="handlePreview(entry)" />
            <KpIconBtn v-if="allowEdit && isTextFile(entry.name) && !entry.isDir" name="line_edit" :size="15" :title="t('files.edit')" @click.stop="handleEdit(entry)" />
            <KpIconBtn v-if="!entry.isDir" name="line_download" :size="15" :title="t('files.download')" @click.stop="handleDownload(entry)" />
          </div>
        </div>
      </div>
    </NSpin>
  </div>
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
}


.file-list {
  padding: 12px 40px 40px;

  @media (max-width: $breakpoint-mobile) {
    padding: 8px 12px;
  }
}

// Measured off the prototype's <colgroup>: 46% / 18% / 18% / 18% on a
// table-layout:fixed table. Fixed pixel meta columns are what made the name
// swallow a wide screen and pinned 大小 / 修改时间 to the far right edge — the
// proportions have to scale with the table, not sit at its end.
.file-list-grid {
  display: grid;
  grid-template-columns: 46% 18% 18% 18%;
  align-items: center;
  column-gap: 0;

  // With 位置 the row carries the prototype's four data columns, so the hover
  // actions stop being a column of their own and overlay the last one.
  &.has-location {
    grid-template-columns: 46% 18% 18% 18%;

    .file-actions,
    .file-actions-placeholder {
      display: none;
    }
  }
}

.file-location {
  padding: 0 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
}

// Prototype table head: quiet 12px labels on a full-width rule, sitting well
// above the rows rather than reading as a first row of their own.
.file-list-header {
  padding: 0 0 12px;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
  border-bottom: 0.5px solid var(--divider);
  margin-bottom: 4px;
  user-select: none;
}

.sort-header {
  cursor: pointer;

  &:hover {
    color: var(--fg-title);
  }
}

.sort-indicator {
  margin-left: 2px;
  font-size: 11px;
}

.file-actions-placeholder {
  min-width: 0;
}

// Measured against the prototype's table: cells are 8px/12px, which with the
// 30px type tile makes a 46px row.
.file-list-row {
  padding: 8px 0;
  border-radius: var(--r-ctl);
  cursor: pointer;
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
  transition: background var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--surface-3);

    .file-actions {
      opacity: 1;
    }
  }
}

.file-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 12px;
  color: var(--fg-title);
}

.file-icon {
  flex-shrink: 0;
}

// The file name is the one thing that carries weight in the row; everything
// else recedes to fg-aux (prototype LibraryScreen table).
.file-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  // Medium, not semibold — measured 14px/500 on the prototype's name cell.
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
}

// Every column reads left-aligned in the prototype, including the numeric one:
// the table is a list of files, not a spreadsheet to sum down.
.file-size,
.file-date {
  padding: 0 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
}

.file-size {
  color: var(--fg-aux);
}

.file-date {
  color: var(--fg-disabled);
}

.file-actions {
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-std);
  display: flex;
  justify-content: flex-end;
  padding: 0 12px;
  gap: 2px;
}

@media (max-width: $breakpoint-mobile) {
  .file-list-grid {
    grid-template-columns: minmax(0, 1fr) 60px;
  }

  .file-size,
  .file-date {
    display: none;
  }

  .file-actions {
    opacity: 1;
  }
}
</style>
