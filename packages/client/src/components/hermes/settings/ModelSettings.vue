<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NInput, NButton, NSpin, NEmpty } from 'naive-ui'
import { useModelsStore } from '@/stores/hermes/models'
import { updateProvider } from '@/api/hermes/system'
import { useI18n } from 'vue-i18n'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'

const { t } = useI18n()
const modelsStore = useModelsStore()

const savingKey = ref<string | null>(null)
/** Validation and save failures for this pane, kept until the next attempt. */
const paneError = ref('')
const editKeys = ref<Record<string, string>>({})

onMounted(() => {
  if (modelsStore.providers.length === 0) {
    modelsStore.fetchProviders()
  }
})

const isCustom = (provider: string) => {
  const g = modelsStore.providers.find(p => p.provider === provider)
  return !g?.builtin && provider.startsWith('custom:')
}

function getEditKey(provider: string): string {
  if (!(provider in editKeys.value)) {
    const g = modelsStore.providers.find(p => p.provider === provider)
    editKeys.value[provider] = g?.api_key || ''
  }
  return editKeys.value[provider]
}

async function handleSaveApiKey(providerKey: string) {
  const key = getEditKey(providerKey)
  if (!key.trim()) {
    // Validation belongs beside the field, not at the edge of the screen.
    paneError.value = t('settings.models.apiKeyPlaceholder')
    return
  }
  savingKey.value = providerKey
  paneError.value = ''
  try {
    await updateProvider(providerKey, { api_key: key.trim() })
    // The provider card repaints with the stored key, which is the report.
    await modelsStore.fetchProviders()
  } catch (e: any) {
    paneError.value = e.message || t('settings.models.saveFailed')
  } finally {
    savingKey.value = null
  }
}

async function handleSaveCustom(providerKey: string) {
  const key = getEditKey(providerKey)
  savingKey.value = providerKey
  paneError.value = ''
  try {
    await updateProvider(providerKey, { api_key: key.trim() })
    await modelsStore.fetchProviders()
  } catch (e: any) {
    paneError.value = e.message || t('settings.models.saveFailed')
  } finally {
    savingKey.value = null
  }
}
</script>

<template>
  <section class="settings-section">
    <p v-if="paneError" class="settings-save-error" data-testid="model-settings-error">{{ paneError }}</p>
    <KpSectionTitle>{{ t('settings.tabs.models') }}</KpSectionTitle>
    <NSpin :show="modelsStore.loading">
      <div v-if="modelsStore.providers.length === 0" class="empty-hint">
        <NEmpty :description="t('settings.models.noProviders')" />
      </div>

      <div v-for="g in modelsStore.providers" :key="g.provider" class="provider-section">
        <div class="provider-header">
          <h4 class="provider-name">{{ g.label }}</h4>
          <span class="type-badge" :class="isCustom(g.provider) ? 'custom' : 'builtin'">
            {{ isCustom(g.provider) ? t('models.customType') : t('models.builtIn') }}
          </span>
        </div>

        <!-- Built-in provider: only API key -->
        <div v-if="!isCustom(g.provider)" class="provider-fields">
          <div class="field-row">
            <NInput
              :value="getEditKey(g.provider)"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.models.apiKeyPlaceholder')"
              autocomplete="off"
              @update:value="v => editKeys[g.provider] = v"
            />
            <NButton
              type="primary"
              size="small"
              :loading="savingKey === g.provider"
              @click="handleSaveApiKey(g.provider)"
            >
              {{ t('settings.models.save') }}
            </NButton>
          </div>
        </div>

        <!-- Custom provider: API key -->
        <div v-else class="provider-fields">
          <div class="field-row">
            <NInput
              :value="getEditKey(g.provider)"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.models.apiKeyPlaceholder')"
              autocomplete="off"
              @update:value="v => editKeys[g.provider] = v"
            />
            <NButton
              type="primary"
              size="small"
              :loading="savingKey === g.provider"
              @click="handleSaveCustom(g.provider)"
            >
              {{ t('settings.models.save') }}
            </NButton>
          </div>
        </div>
      </div>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.settings-save-error {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}


.settings-section {
  margin-top: 0;
}

.empty-hint {
  padding: 40px 0;
}

// Prototype card (usage summary): flat surface-2, r-card, 20px pad — no border.
.provider-section {
  border-radius: var(--r-card);
  padding: 20px;
  margin-bottom: 14px;
  background: var(--gray-f7);
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.provider-name {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  margin: 0;
}

// Prototype tag: 22px neutral pill on surface-3, no hue coding.
.type-badge {
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--gray-f2);
  font: var(--w-medium) var(--t-12) / 22px var(--font-cn);
  color: var(--fg-secondary);
}

.provider-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 10px;

  .n-input {
    flex: 1;
  }
}
</style>
