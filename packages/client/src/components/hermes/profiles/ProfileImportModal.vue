<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NUpload, NButton } from 'naive-ui'
import type { UploadFileInfo } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
/** Validation and import failures, kept in the dialog. */
const paneError = ref('')
const profilesStore = useProfilesStore()

const showModal = ref(true)
const loading = ref(false)
const fileList = ref<UploadFileInfo[]>([])

const ACCEPT_TYPES = [
  '.tar.gz',
  '.tgz',
  '.gz',
  '.zip',
]

function beforeUpload({ file }: { file: UploadFileInfo }) {
  const name = file.name?.toLowerCase() || ''
  const valid = ACCEPT_TYPES.some(ext => name.endsWith(ext))
  if (!valid) {
    paneError.value = t('profiles.importInvalidFile')
    return false
  }
  return true
}

async function handleSave() {
  if (!fileList.value.length) {
    paneError.value = t('profiles.importSelectFile')
    return
  }

  loading.value = true
  try {
    const file = fileList.value[0].file
    if (!file) {
      paneError.value = t('profiles.importFailed')
      return
    }
    const ok = await profilesStore.importProfile(file)
    // Success closes the dialog and the profile joins the list.
    if (ok) emit('saved')
    else paneError.value = t('profiles.importFailed')
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('profiles.import')"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <p v-if="paneError" class="pane-notice" data-testid="profile-import-error">{{ paneError }}</p>
    <NUpload
      v-model:file-list="fileList"
      :max="1"
      :accept="ACCEPT_TYPES.join(',')"
      :disabled="loading"
      @before-upload="beforeUpload"
    >
      <NButton>{{ t('profiles.importSelectFile') }}</NButton>
    </NUpload>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="!fileList.length" @click="handleSave">
          {{ t('common.confirm') }}
        </NButton>
      </div>
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
  white-space: pre-line;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
