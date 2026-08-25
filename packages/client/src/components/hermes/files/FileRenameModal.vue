<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { NModal, NInput, NButton, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { DEFAULT_EDITOR_SCOPE, useFilesStore } from '@/stores/hermes/files'
import type { FileEntry } from '@/api/hermes/files'

const { t } = useI18n()
const filesStore = useFilesStore()

const props = defineProps<{
  show: boolean
  mode: 'newFile' | 'newFolder' | 'rename'
  entry?: FileEntry | null
  targetPath?: string | null
  editorScope?: string
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

/** Create / rename failure. Success closes the dialog and the entry appears in the list. */
const paneError = ref('')
const inputValue = ref('')
const submitting = ref(false)

watch(() => props.show, (val) => {
  if (val) {
    if (props.mode === 'rename' && props.entry) {
      inputValue.value = props.entry.name
    } else {
      inputValue.value = ''
    }
  }
})

const title = computed(() => {
  switch (props.mode) {
    case 'newFile': return t('files.newFile')
    case 'newFolder': return t('files.newFolder')
    case 'rename': return t('files.rename')
  }
})

const placeholder = computed(() => {
  switch (props.mode) {
    case 'newFile': return t('files.newFileName')
    case 'newFolder': return t('files.newFolderName')
    case 'rename': return t('files.renameTo')
  }
})

async function handleSubmit() {
  if (!inputValue.value.trim()) return
  submitting.value = true
  try {
    switch (props.mode) {
      case 'newFile':
        await filesStore.createFile(inputValue.value.trim())
        break
      case 'newFolder':
        await filesStore.createDir(inputValue.value.trim(), props.targetPath || undefined)
        break
      case 'rename':
        if (props.entry) {
          await filesStore.renameEntry(props.entry, inputValue.value.trim(), props.editorScope || DEFAULT_EDITOR_SCOPE)
        }
        break
    }
    emit('update:show', false)
  } catch (err: any) {
    const msg = props.mode === 'rename' ? t('files.renameFailed') : t('files.createFailed')
    paneError.value = err.message || msg
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <NModal :show="props.show" preset="dialog" :title="title" @update:show="emit('update:show', false)" style="width: 400px;">
    <p v-if="paneError" class="pane-notice" data-testid="file-rename-error">{{ paneError }}</p>
    <NInput
      v-model:value="inputValue"
      :placeholder="placeholder"
      @keydown.enter="handleSubmit"
      autofocus
    />
    <template #action>
      <NSpace>
        <NButton @click="emit('update:show', false)">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="submitting" :disabled="!inputValue.trim()" @click="handleSubmit">
          {{ t('common.ok') }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.pane-notice {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}
</style>
