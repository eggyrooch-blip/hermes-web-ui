<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NTree } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import * as filesApi from '@/api/hermes/files'
import KpIcon from '@/components/kippies/KpIcon.vue'
import type { TreeOption } from 'naive-ui'

// `showActions` surfaces the prototype LibraryScreen affordances (a "+" new
// menu, and a hover-revealed refresh) in the "文件树" section header — matching
// where the prototype puts them, next to the 我的文档 label. FilesPanel keeps
// its own toolbar, so it renders the tree without these and stays unchanged.
// `showViews` adds the prototype's 最近 / 本地产物 rows above the document
// tree; `view` is which one is lit (`tree` = you are browsing the documents).
// FilesPanel renders neither and stays a plain tree.
export type LibraryView = 'recent' | 'local' | 'tree'

const props = withDefaults(
  defineProps<{ showActions?: boolean; showViews?: boolean; view?: LibraryView }>(),
  { showActions: false, showViews: false, view: 'tree' },
)

const emit = defineEmits<{
  (e: 'showNewFile'): void
  (e: 'showNewFolder'): void
  (e: 'showUpload'): void
  (e: 'select-view', view: LibraryView): void
}>()

const { t } = useI18n()
/** Failure loading the tree. */
const paneError = ref('')
const filesStore = useFilesStore()

const treeData = ref<TreeOption[]>([])
const selectedKeys = ref<string[]>([])
const pattern = ref('')

const menuOpen = ref(false)
const menuPos = ref({ x: 0, y: 0 })

function openMenu(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // Right-align the 180px popover under the "+" trigger (prototype anchors it
  // to the right edge of the header).
  menuPos.value = { x: rect.right - 180, y: rect.bottom + 6 }
  menuOpen.value = true
}

function pick(action: 'showNewFile' | 'showNewFolder' | 'showUpload') {
  menuOpen.value = false
  // emit()'s generated overloads only take literal event names, not a union.
  if (action === 'showNewFile') emit('showNewFile')
  else if (action === 'showNewFolder') emit('showNewFolder')
  else emit('showUpload')
}

async function handleRefresh() {
  try {
    await filesStore.fetchEntries()
  } catch {
    paneError.value = t('files.backendError')
  }
}

async function loadChildren(path: string): Promise<TreeOption[]> {
  try {
    const result = await filesApi.listFiles(path)
    return result.entries
      .filter(e => e.isDir)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({
        key: e.path,
        label: e.name,
        isLeaf: false,
      }))
  } catch {
    return []
  }
}

async function handleLoad(node: TreeOption): Promise<void> {
  node.children = await loadChildren(node.key as string)
}

function handleSelect(keys: string[]) {
  if (keys.length > 0) {
    selectedKeys.value = keys
    // Picking a folder is also how you leave 最近 / 本地产物.
    emit('select-view', 'tree')
    filesStore.navigateTo(keys[0])
  }
}

function handleRootClick() {
  selectedKeys.value = []
  emit('select-view', 'tree')
  filesStore.navigateTo('')
}

onMounted(async () => {
  treeData.value = await loadChildren('')
})
</script>

<template>
  <div class="file-tree">
    <p v-if="paneError" class="pane-notice" data-testid="file-tree-error">{{ paneError }}</p>
    <div class="file-tree__search">
      <KpIcon name="line_search" :size="15" />
      <input
        v-model="pattern"
        type="text"
        class="file-tree__search-input"
        :placeholder="t('sidebar.search')"
      />
    </div>

    <!-- Prototype library rail: two views above the document tree. 最近 is the
         whole workspace by mtime, 本地产物 is what the runs actually wrote —
         both real, both answerable without the tree. -->
    <template v-if="props.showViews">
      <button
        type="button"
        class="file-tree__nav"
        :class="{ 'is-active': props.view === 'recent' }"
        data-testid="library-view-recent"
        @click="emit('select-view', 'recent')"
      >
        <KpIcon name="line_reload" :size="15" />
        <span>{{ t('files.viewRecent') }}</span>
      </button>
      <button
        type="button"
        class="file-tree__nav"
        :class="{ 'is-active': props.view === 'local' }"
        data-testid="library-view-local"
        @click="emit('select-view', 'local')"
      >
        <KpIcon name="line_drafts" :size="15" />
        <span>{{ t('files.viewLocal') }}</span>
      </button>
      <div class="file-tree__nav-gap" />
    </template>

    <div class="file-tree__section">
      <span class="file-tree__section-label t-meta">
        {{ props.showViews ? t('files.viewDocuments') : t('files.fileTree') }}
      </span>
      <template v-if="props.showActions">
        <button
          type="button"
          class="ab file-tree__action file-tree__action--refresh"
          :title="t('files.refresh')"
          @click="handleRefresh"
        >
          <KpIcon name="line_reload" :size="13" />
        </button>
        <button
          type="button"
          class="ab file-tree__action"
          :title="t('files.newMenu')"
          @click="openMenu"
        >
          <KpIcon name="line_add" :size="13" />
        </button>
      </template>
    </div>

    <div
      class="file-tree__root"
      :class="{ 'is-active': selectedKeys.length === 0 && props.view === 'tree' }"
      @click="handleRootClick"
    >
      <KpIcon name="line_homepage" :size="15" />
      <span>{{ t('files.breadcrumbRoot') }}</span>
    </div>

    <NTree
      class="file-tree__tree"
      :data="treeData"
      :selected-keys="selectedKeys"
      :pattern="pattern"
      :show-irrelevant-nodes="false"
      :on-load="handleLoad"
      expand-on-click
      block-line
      @update:selected-keys="handleSelect"
    />

    <teleport to="body">
      <template v-if="menuOpen">
        <div class="file-tree__menu-backdrop" @click="menuOpen = false" />
        <div
          class="file-tree__menu"
          :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
        >
          <button type="button" class="row file-tree__menu-item" @click="pick('showNewFile')">
            <KpIcon name="line_write" :size="15" />
            <span>{{ t('files.newFile') }}</span>
          </button>
          <button type="button" class="row file-tree__menu-item" @click="pick('showNewFolder')">
            <KpIcon name="line_add" :size="15" />
            <span>{{ t('files.newFolder') }}</span>
          </button>
          <button type="button" class="row file-tree__menu-item" @click="pick('showUpload')">
            <KpIcon name="line_download" :size="15" />
            <span>{{ t('files.upload') }}</span>
          </button>
        </div>
      </template>
    </teleport>
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


.file-tree {
  padding: 20px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-tree__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--fg-aux);
  margin-bottom: 8px;
}

.file-tree__search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  font: var(--w-regular) var(--t-13) / 1.35 var(--font-cn);
  color: var(--fg-title);

  &::placeholder {
    color: var(--fg-aux);
  }
}

// Section header carries the prototype "我的文档 + +" affordance layout: the
// label takes the row, the "+" pins right, refresh reveals on hover.
.file-tree__section {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px 0 8px;
  min-height: 24px;

  &:hover .file-tree__action--refresh {
    opacity: 1;
  }
}

.file-tree__section-label {
  flex: 1;
  min-width: 0;
  // Measured #CCC on the prototype's 我的文档 caption — one step lighter than
  // the rows it heads.
  color: var(--fg-disabled);
}

.file-tree__action {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-disabled);
  display: grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    background: var(--gray-f2);
    color: var(--fg-secondary);
  }
}

.file-tree__action--refresh {
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-std);
}

// Library view rows: same 32/0-8/r2/gap-8 geometry as the tree rows, so the
// rail reads as one column rather than two stacked lists.
.file-tree__nav {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-secondary);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--surface-3);
  }

  &.is-active {
    background: var(--selected-bg);
    color: var(--fg-title);
  }
}

// Measured on the prototype: 14px of air between the two views and the
// document group below them.
.file-tree__nav-gap {
  height: 14px;
}

.file-tree__root {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  cursor: pointer;
  border-radius: var(--r-ctl);
  // Unselected rows sit at fg-secondary and only the selected one comes up to
  // fg-title — measured off the prototype's own inline styles.
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);

  &:hover {
    background: var(--surface-3);
  }

  &.is-active {
    background: var(--selected-bg);
    color: var(--fg-title);
  }
}

.file-tree__tree {
  :deep(.n-tree-node) {
    border-radius: var(--r-ctl);
  }

  :deep(.n-tree-node-content) {
    min-height: 32px;
    font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
    color: var(--fg-secondary);
  }

  :deep(.n-tree-node--selected) {
    background: var(--selected-bg);
  }

  :deep(.n-tree-node:hover:not(.n-tree-node--selected)) {
    background: var(--surface-3);
  }
}

.file-tree__menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
}

.file-tree__menu {
  position: fixed;
  z-index: 3001;
  width: 180px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: inset 0 0 0 0.5px var(--divider), var(--shadow-notification);
}

.file-tree__menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  cursor: pointer;
  font: var(--w-regular) var(--t-13) / 1.35 var(--font-cn);
  color: var(--fg-title);

  .kp-icon-font,
  :deep(.kp-icon-font) {
    color: var(--fg-aux);
  }

  &:hover {
    background: var(--gray-fa);
  }
}
</style>
