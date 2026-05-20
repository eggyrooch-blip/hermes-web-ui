<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSwitch, NText, NSelect, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchAvailableModels, type AvailableModelGroup } from '@/api/hermes/system'
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
const selectedModelKey = ref<string | null>(null)
const availableModelGroups = ref<AvailableModelGroup[]>([])

const rolePresets = [
  { value: 'coder', labelKey: 'profiles.rolePresetCoder', descriptionKey: 'profiles.rolePresetCoderDescription' },
  { value: 'researcher', labelKey: 'profiles.rolePresetResearcher', descriptionKey: 'profiles.rolePresetResearcherDescription' },
  { value: 'writer', labelKey: 'profiles.rolePresetWriter', descriptionKey: 'profiles.rolePresetWriterDescription' },
  { value: 'operator', labelKey: 'profiles.rolePresetOperator', descriptionKey: 'profiles.rolePresetOperatorDescription' },
  { value: 'custom', labelKey: 'profiles.rolePresetCustom', descriptionKey: '' },
] as const

const roleOptions = computed(() => rolePresets.map(role => ({
  label: t(role.labelKey),
  value: role.value,
})))

const roleDescription = computed(() => {
  if (selectedRole.value === 'custom') return customDescription.value.trim()
  const preset = rolePresets.find(role => role.value === selectedRole.value)
  return preset ? t(preset.descriptionKey).trim() : ''
})

function modelKey(provider: string, model: string): string {
  return `${provider}|||${model}`
}

function parseModelKey(key: string | null): { provider: string; model: string } | null {
  if (!key) return null
  const delimiter = key.indexOf('|||')
  if (delimiter < 0) return null
  const provider = key.slice(0, delimiter).trim()
  const model = key.slice(delimiter + 3).trim()
  if (!provider || !model) return null
  return { provider, model }
}

const modelOptions = computed(() =>
  availableModelGroups.value.flatMap(group =>
    group.models.map(model => ({
      label: `${model} · ${group.label || group.provider}`,
      value: modelKey(group.provider, model),
    })),
  ),
)

const selectedModel = computed(() => parseModelKey(selectedModelKey.value))

onMounted(async () => {
  try {
    const res = await fetchAvailableModels()
    const groups = res.groups?.length ? res.groups : (res.allProviders || [])
    availableModelGroups.value = groups || []
    const preferredModel = profilesStore.activeProfile?.model || res.default
    const preferredProvider = res.default_provider || groups.find(group => group.models.includes(preferredModel))?.provider
    if (preferredModel && preferredProvider) {
      selectedModelKey.value = modelKey(preferredProvider, preferredModel)
    }
  } catch {
    // Model selection is an enhancement; profile creation should keep working.
  }
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
      model: selectedModel.value?.model,
      provider: selectedModel.value?.provider,
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
        <NSelect
          v-model:value="selectedRole"
          :options="roleOptions"
        />
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

      <NFormItem v-if="modelOptions.length" :label="t('profiles.model')">
        <NSelect
          v-model:value="selectedModelKey"
          :options="modelOptions"
          filterable
        />
      </NFormItem>

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

.role-description {
  display: block;
  margin: -6px 0 16px;
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}
</style>
