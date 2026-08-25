<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { NDropdown, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { DEFAULT_EDITOR_SCOPE, useFilesStore, isTextFile, isPreviewableFile } from '@/stores/hermes/files'
import { downloadFile } from '@/api/hermes/download'
import type { FileEntry } from '@/api/hermes/files'
import { copyToClipboard } from '@/utils/clipboard'
import { getClipboardPathForEntry } from '@/utils/file-path'

const { t } = useI18n()
const dialog = useDialog()
const filesStore = useFilesStore()
const props = withDefaults(defineProps<{ allowEdit?: boolean, editorScope?: string }>(), {
  allowEdit: true,
  editorScope: DEFAULT_EDITOR_SCOPE,
})

const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const targetEntry = ref<FileEntry | null>(null)

const emit = defineEmits<{
  (e: 'rename', entry: FileEntry): void
  (e: 'newFolder', entry: FileEntry): void
  (e: 'editor-opened'): void
  /**
   * Something this menu started did not work. Raised to the host rather than
   * shown here: a context menu closes the moment you pick an item, so it has no
   * surface of its own to report on, and the host already owns a resident spot
   * for this.
   */
  (e: 'failed', reason: string): void
}>()

function show(e: MouseEvent, entry: FileEntry) {
  targetEntry.value = entry
  menuX.value = e.clientX
  menuY.value = e.clientY
  showMenu.value = false
  nextTick(() => {
    showMenu.value = true
  })
}

function getOptions() {
  const entry = targetEntry.value
  if (!entry) return []
  const options: any[] = []

  if (entry.isDir) {
    options.push({ label: t('files.open'), key: 'open' })
  } else {
    if (props.allowEdit && isTextFile(entry.name)) {
      options.push({ label: t('files.edit'), key: 'edit' })
    }
    if (isPreviewableFile(entry.name)) {
      options.push({ label: t('files.preview'), key: 'preview' })
    }
    options.push({ label: t('files.download'), key: 'download' })
  }
  options.push({ type: 'divider', key: 'd1' })
  options.push({ label: t('files.copyPath'), key: 'copyPath' })
  options.push({ label: t('files.newFolder'), key: 'newFolder' })
  options.push({ label: t('files.rename'), key: 'rename' })
  options.push({ type: 'divider', key: 'd2' })
  options.push({ label: t('files.delete'), key: 'delete' })
  return options
}

async function handleSelect(key: string) {
  showMenu.value = false
  const entry = targetEntry.value
  if (!entry) return

  switch (key) {
    case 'open':
      filesStore.navigateTo(entry.path)
      break
    case 'edit':
      if (!props.allowEdit) break
      try {
        if (await filesStore.openEditor(entry.path, props.editorScope)) emit('editor-opened')
      } catch {
        emit('failed', t('files.backendError'))
      }
      break
    case 'preview':
      try { await filesStore.openPreview(entry) } catch { emit('failed', t('files.backendError')) }
      break
    case 'download':
      // A download that starts is announced by the browser itself.
      try { await downloadFile(entry.path, entry.name) } catch (err: any) { emit('failed', err.message) }
      break
    case 'copyPath': {
      // Nothing visible changes on a successful copy, but the user asked for it
      // and pasting verifies it. A FAILED copy has to be said, or they paste
      // whatever was in the clipboard before.
      const ok = await copyToClipboard(getClipboardPathForEntry(entry))
      if (!ok) emit('failed', t('files.copyPathFailed'))
      break
    }
    case 'rename':
      emit('rename', entry)
      break
    case 'newFolder':
      emit('newFolder', entry)
      break
    case 'delete':
      dialog.warning({
        title: t('files.delete'),
        content: entry.isDir ? t('files.confirmDeleteDir', { name: entry.name }) : t('files.confirmDelete', { name: entry.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            // The entry leaving the list is the report.
            await filesStore.deleteEntry(entry, props.editorScope)
          } catch {
            emit('failed', t('files.deleteFailed'))
          }
        },
      })
      break
  }
}

function handleClickOutside() {
  showMenu.value = false
}

defineExpose({ show })
</script>

<template>
  <NDropdown
    :show="showMenu"
    :x="menuX"
    :y="menuY"
    :options="getOptions()"
    placement="bottom-start"
    trigger="manual"
    @select="handleSelect"
    @clickoutside="handleClickOutside"
  />
</template>
