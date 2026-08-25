<script setup lang="ts">
import { computed } from 'vue'
import { NSelect, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import SettingRow from './SettingRow.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import { useAutosave } from '@/composables/useAutosave'

const settingsStore = useSettingsStore()
const profilesStore = useProfilesStore()
const { t } = useI18n()
// Autosave: the control already shows the new value on success, and a refused
// save puts it back rather than leaving the pane disagreeing with the server.
const { error: saveError, run: autosave } = useAutosave()

const enabled = computed(() => settingsStore.gatewayAutoStart.enabled !== false)
const mode = computed(() => Array.isArray(settingsStore.gatewayAutoStart.include) ? 'include' : 'all')
const includeProfiles = computed(() => settingsStore.gatewayAutoStart.include || [])
const excludeProfiles = computed(() => settingsStore.gatewayAutoStart.exclude || [])
const profileOptions = computed(() =>
  profilesStore.profiles.map(profile => ({
    label: profile.name,
    value: profile.name,
  })),
)
const modeOptions = computed(() => [
  { label: t('settings.gatewayAutoStart.modeAll'), value: 'all' },
  { label: t('settings.gatewayAutoStart.modeInclude'), value: 'include' },
])

function normalizeProfileList(raw: string[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const part of raw) {
    const name = String(part || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

async function save(values: Record<string, any>) {
  // The whole section is replaced, so the revert restores the snapshot rather
  // than a per-key diff — `mergeGatewayAutoStart` means a partial put-back would
  // not undo a list that was emptied.
  const previous = { ...settingsStore.gatewayAutoStart }
  await autosave({
    apply: () => settingsStore.updateLocal('gatewayAutoStart', values),
    revert: () => settingsStore.updateLocal('gatewayAutoStart', previous),
    save: () => settingsStore.saveSection('gatewayAutoStart', values, { restart: false }),
    failMessage: t('settings.saveFailed'),
  })
}

function saveMode(value: string) {
  void save(value === 'include'
    ? { include: settingsStore.gatewayAutoStart.include || [], exclude: null }
    : { include: null })
}

function saveInclude(value: string[]) {
  void save({ include: normalizeProfileList(value), exclude: null })
}

function saveExclude(value: string[]) {
  const exclude = normalizeProfileList(value)
  void save({ exclude: exclude.length > 0 ? exclude : null })
}
</script>

<template>
  <section class="settings-section gateway-auto-start-settings">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <!-- Prototype SectionTitle carries its description inline as a note. -->
    <KpSectionTitle :note="t('settings.gatewayAutoStart.description')">{{ t('settings.gatewayAutoStart.title') }}</KpSectionTitle>

    <SettingRow :label="t('settings.gatewayAutoStart.enabled')" :hint="t('settings.gatewayAutoStart.enabledHint')">
      <NSwitch :value="enabled" @update:value="value => save({ enabled: value })" />
    </SettingRow>

    <SettingRow :label="t('settings.gatewayAutoStart.mode')" :hint="t('settings.gatewayAutoStart.modeHint')">
      <NSelect
        :value="mode"
        :options="modeOptions"
        size="small"
        class="input-md"
        @update:value="saveMode"
      />
    </SettingRow>

    <SettingRow
      v-if="mode === 'include'"
      :label="t('settings.gatewayAutoStart.include')"
      :hint="t('settings.gatewayAutoStart.includeHint')"
    >
      <NSelect
        multiple
        filterable
        :value="includeProfiles"
        :options="profileOptions"
        size="small"
        class="input-md"
        :placeholder="t('settings.gatewayAutoStart.profileListPlaceholder')"
        @update:value="saveInclude"
      />
    </SettingRow>

    <SettingRow
      v-if="mode === 'all'"
      :label="t('settings.gatewayAutoStart.exclude')"
      :hint="t('settings.gatewayAutoStart.excludeHint')"
    >
      <NSelect
        multiple
        filterable
        :value="excludeProfiles"
        :options="profileOptions"
        size="small"
        class="input-md"
        :placeholder="t('settings.gatewayAutoStart.profileListPlaceholder')"
        @update:value="saveExclude"
      />
    </SettingRow>
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

.gateway-auto-start-settings {
  margin-top: 36px;
}

.input-md {
  max-width: 320px;
}
</style>
