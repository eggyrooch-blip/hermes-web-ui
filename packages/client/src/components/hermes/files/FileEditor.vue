<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { NButton, NSpace, useMessage, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { DEFAULT_EDITOR_SCOPE, useFilesStore } from '@/stores/hermes/files'
import * as monaco from 'monaco-editor'

// Configure Monaco workers using import.meta.url
;(self as any).MonacoEnvironment = {
  getWorker(_: any, _label: string) {
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' }
    )
  },
}

const { t } = useI18n()
const message = useMessage()
const dialogApi = useDialog()
const filesStore = useFilesStore()
const props = withDefaults(defineProps<{ editorScope?: string }>(), {
  editorScope: DEFAULT_EDITOR_SCOPE,
})
const editingFile = computed(() => filesStore.getEditingFile(props.editorScope))

const editorContainer = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
const saving = ref(false)

onMounted(() => {
  if (!editorContainer.value || !editingFile.value) return

  editor = monaco.editor.create(editorContainer.value, {
    value: editingFile.value.content,
    language: editingFile.value.language,
    theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
  })

  editor.onDidChangeModelContent(() => {
    if (editingFile.value) {
      editingFile.value.content = editor!.getValue()
    }
  })

  // Ctrl/Cmd + S to save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    handleSave()
  })
})

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})

async function handleSave() {
  saving.value = true
  try {
    if (!await filesStore.saveEditor(props.editorScope)) return
    message.success(t('files.saved'))
  } catch {
    message.error(t('files.saveFailed'))
  } finally {
    saving.value = false
  }
}

function handleClose() {
  if (filesStore.hasUnsavedChangesForScope(props.editorScope)) {
    dialogApi.warning({
      title: t('files.unsavedChanges'),
      positiveText: t('common.ok'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        filesStore.closeEditor(props.editorScope)
      },
    })
  } else {
    filesStore.closeEditor(props.editorScope)
  }
}
</script>

<template>
  <div v-if="editingFile" class="file-editor">
    <div class="editor-header">
      <span class="editor-filename">{{ editingFile.path }}</span>
      <NSpace>
        <NButton size="small" type="primary" :loading="saving" @click="handleSave">
          {{ t('files.saveFile') }}
        </NButton>
        <NButton size="small" @click="handleClose">
          {{ t('files.closeEditor') }}
        </NButton>
      </NSpace>
    </div>
    <div ref="editorContainer" class="editor-container" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background-color: $bg-card;
}

.editor-filename {
  font-size: 13px;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;

  @media (max-width: $breakpoint-mobile) {
    max-width: 120px;
    font-size: 12px;
  }
}

.editor-container {
  flex: 1;
  min-height: 0;
}
</style>
