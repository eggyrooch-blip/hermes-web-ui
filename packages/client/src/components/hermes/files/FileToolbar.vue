<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import KpBtn from '@/components/kippies/KpBtn.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpIconBtn from '@/components/kippies/KpIconBtn.vue'

const { t } = useI18n()
/** Failure of a toolbar action. */
const paneError = ref('')
const filesStore = useFilesStore()

const emit = defineEmits<{
  (e: 'showNewFile'): void
  (e: 'showNewFolder'): void
  (e: 'showUpload'): void
}>()

const menuOpen = ref(false)
const menuPos = ref({ x: 0, y: 0 })

function openMenu(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  menuPos.value = { x: rect.left, y: rect.bottom + 6 }
  menuOpen.value = true
}

function pick(action: 'showNewFile' | 'showNewFolder' | 'showUpload') {
  menuOpen.value = false
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
</script>

<template>
  <div class="file-toolbar">
    <p v-if="paneError" class="pane-notice" data-testid="file-toolbar-error">{{ paneError }}</p>
    <!-- Dark, not Keep green: green is reserved for the primary action in a
         run, and every other page-level create button in the design is dark. -->
    <KpBtn kind="dark" size="s" icon="line_add" @click="openMenu">
      {{ t('files.newMenu') }}
    </KpBtn>
    <div class="file-toolbar__spacer" />
    <KpIconBtn name="line_reload" :size="16" :title="t('files.refresh')" @click="handleRefresh" />

    <teleport to="body">
      <template v-if="menuOpen">
        <div class="file-toolbar__backdrop" @click="menuOpen = false" />
        <div
          class="file-toolbar__menu"
          :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
        >
          <button type="button" class="row file-toolbar__item" @click="pick('showNewFile')">
            <KpIcon name="line_write" :size="15" />
            <span>{{ t('files.newFile') }}</span>
          </button>
          <button type="button" class="row file-toolbar__item" @click="pick('showNewFolder')">
            <KpIcon name="line_add" :size="15" />
            <span>{{ t('files.newFolder') }}</span>
          </button>
          <button type="button" class="row file-toolbar__item" @click="pick('showUpload')">
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


// Sits above the breadcrumb-title on the same 40px gutter; the rule under it
// is gone since the title block now separates it from the table.
.file-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 40px;
  flex-shrink: 0;

  @media (max-width: $breakpoint-mobile) {
    padding: 0 12px;
  }
}

.file-toolbar__spacer {
  flex: 1;
}

.file-toolbar__backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
}

.file-toolbar__menu {
  position: fixed;
  z-index: 3001;
  min-width: 180px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: inset 0 0 0 0.5px var(--divider), var(--shadow-notification);
}

.file-toolbar__item {
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
