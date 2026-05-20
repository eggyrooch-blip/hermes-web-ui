<script setup lang="ts">
import { computed, ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSwitch, NText, NRadioGroup, NRadioButton, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const name = ref('')
const clone = ref(false)
const nameValidationMessage = ref('')
const selectedRole = ref<'coder' | 'researcher' | 'writer' | 'operator' | 'custom'>('coder')
const customDescription = ref('')

const rolePresets = [
  { value: 'coder', labelKey: 'profiles.rolePresetCoder', descriptionKey: 'profiles.rolePresetCoderDescription' },
  { value: 'researcher', labelKey: 'profiles.rolePresetResearcher', descriptionKey: 'profiles.rolePresetResearcherDescription' },
  { value: 'writer', labelKey: 'profiles.rolePresetWriter', descriptionKey: 'profiles.rolePresetWriterDescription' },
  { value: 'operator', labelKey: 'profiles.rolePresetOperator', descriptionKey: 'profiles.rolePresetOperatorDescription' },
  { value: 'custom', labelKey: 'profiles.rolePresetCustom', descriptionKey: '' },
] as const

const roleDescription = computed(() => {
  if (selectedRole.value === 'custom') return customDescription.value.trim()
  const preset = rolePresets.find(role => role.value === selectedRole.value)
  return preset ? t(preset.descriptionKey).trim() : ''
})

function handleNameInput(value: string) {
  // 过滤掉不符合规则的字符，只保留小写字母、数字、下划线和连字符
  const filtered = value.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (filtered !== value) {
    nameValidationMessage.value = t('profiles.nameValidation')
  } else {
    nameValidationMessage.value = ''
  }
  name.value = filtered
}

async function handleSave() {
  if (!name.value) {
    message.warning(t('profiles.namePlaceholder'))
    return
  }

  if (!/^[a-z0-9_-]+$/.test(name.value)) {
    message.error(t('profiles.nameValidation'))
    return
  }

  loading.value = true
  try {
    const res = await profilesStore.createProfile(name.value.trim(), {
      clone: clone.value,
      description: roleDescription.value || undefined,
    })
    if (res.success) {
      const stripped = res.strippedCredentials ?? []
      const disabled = res.disabledPlatforms ?? []
      const cfgStripped = res.strippedConfigCredentials ?? []
      if (clone.value && (stripped.length > 0 || disabled.length > 0 || cfgStripped.length > 0)) {
        const parts: string[] = []
        if (stripped.length > 0) parts.push(t('profiles.cloneStrippedCredentials', { count: stripped.length, list: stripped.join(', ') }))
        if (disabled.length > 0) parts.push(t('profiles.cloneDisabledPlatforms', { count: disabled.length, list: disabled.join(', ') }))
        if (cfgStripped.length > 0) parts.push(t('profiles.cloneStrippedConfigCredentials', { count: cfgStripped.length, list: cfgStripped.join(', ') }))
        message.info(`${t('profiles.createSuccess', { name: name.value.trim() })}\n${parts.join('\n')}`, { duration: 6000 })
      } else {
        message.success(t('profiles.createSuccess', { name: name.value.trim() }))
      }
      emit('saved')
    } else {
      const errorMsg = res.error || t('profiles.createFailed')
      message.error(errorMsg)
    }
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
    :title="t('profiles.create')"
    :style="{ width: 'min(480px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('profiles.name')" required>
        <NInput
          v-model:value="name"
          :placeholder="t('profiles.namePlaceholder')"
          @input="handleNameInput"
        />
      </NFormItem>
      <NText v-if="nameValidationMessage" depth="3" type="warning" style="font-size: 12px;">
        {{ nameValidationMessage }}
      </NText>

      <NFormItem :label="t('profiles.rolePreset')">
        <NRadioGroup v-model:value="selectedRole" class="role-presets">
          <NRadioButton
            v-for="role in rolePresets"
            :key="role.value"
            :value="role.value"
          >
            {{ t(role.labelKey) }}
          </NRadioButton>
        </NRadioGroup>
      </NFormItem>
      <NFormItem
        v-if="selectedRole === 'custom'"
        :label="t('profiles.roleDescription')"
      >
        <NInput
          v-model:value="customDescription"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 5 }"
          :placeholder="t('profiles.roleDescriptionPlaceholder')"
        />
      </NFormItem>
      <NText v-else depth="3" class="role-description">
        {{ roleDescription }}
      </NText>

      <NFormItem :label="t('profiles.cloneFromCurrent')">
        <NSwitch v-model:value="clone" />
      </NFormItem>
      <NText v-if="clone" depth="3" style="font-size: 12px;">
        {{ t('profiles.cloneCleanupNotice') }}
      </NText>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ t('common.create') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.role-presets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 8px;
  width: 100%;
}

.role-presets :deep(.n-radio-button) {
  width: 100%;
  min-width: 0;
  text-align: center;
  justify-content: center;
  border-radius: 6px;
}

.role-presets :deep(.n-radio-button:not(:first-child)) {
  margin-left: 0;
}

.role-description {
  display: block;
  margin: -6px 0 16px;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}
</style>
