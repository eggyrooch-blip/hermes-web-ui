<script setup lang="ts">
/**
 * Settings · 个性化 — what the assistant understands about you.
 *
 * The master switch is NOT a new local flag: it is bound to `memory_enabled`,
 * the one setting in this app that actually does what the section describes
 * (build up your preferences and conventions from your own tasks and reuse
 * them later). With it off the sub-sections show the prototype's "turn it on
 * first" state rather than a half-open one you can look at but not change.
 *
 * Only 基础配置 has a data source today. The other five sections describe
 * things Hermes has nowhere to read from yet — a directory to pick colleagues
 * out of, connected IM groups, a calendar — so they say so instead of showing
 * invented rows. Wire each one up when its source lands.
 */
import { computed, ref } from 'vue'
import { NInputNumber, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'
import KpBtn from '@/components/kippies/KpBtn.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import { useAutosave } from '@/composables/useAutosave'
import KpTabStrip from '@/components/kippies/KpTabStrip.vue'
import KpToggle from '@/components/kippies/KpToggle.vue'

const props = defineProps<{ canEdit?: boolean }>()

const { t } = useI18n()
// Autosave: the control already shows the new value on success, and a refused
// save puts it back rather than leaving the pane disagreeing with the server.
const { error: saveError, run: autosave } = useAutosave()
const settingsStore = useSettingsStore()

const SECTIONS = ['basic', 'pref', 'goal', 'peer', 'group', 'cal'] as const
type Section = (typeof SECTIONS)[number]

const section = ref<Section>('basic')
const tabs = computed(() =>
  SECTIONS.map(key => ({ key, label: t(`settings.personalize.sections.${key}`) })),
)

const active = computed(() => !!settingsStore.memory.memory_enabled)

// Each field keeps its own timer so a burst of typing in one input sends a
// single request, without delaying an unrelated switch.
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}

function save(values: Record<string, unknown>) {
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, (settingsStore.memory as Record<string, unknown>)[key]]),
  )
  void autosave({
    apply: () => settingsStore.updateLocal('memory', values),
    revert: () => settingsStore.updateLocal('memory', previous),
    save: () => settingsStore.saveSection('memory', values),
    failMessage: t('settings.saveFailed'),
  })
}

function debouncedSave(key: string, value: unknown) {
  // Captured BEFORE the optimistic write, and only on the first keystroke of a
  // burst — reading it inside the timer would capture the optimistic value and
  // make the revert a no-op.
  const previous = (settingsStore.memory as Record<string, unknown>)[key]
  settingsStore.updateLocal('memory', { [key]: value })
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(() => {
    void autosave({
      revert: () => settingsStore.updateLocal('memory', { [key]: previous }),
      save: () => settingsStore.saveSection('memory', { [key]: value }),
      failMessage: t('settings.saveFailed'),
    })
  }, 300)
}
</script>

<template>
  <section class="settings-section personalize">
    <p v-if="saveError" class="settings-save-error" data-testid="settings-save-error">{{ saveError }}</p>
    <!-- Title and master switch share a line: the switch governs the whole
         page, so it does not belong tucked inside one of the rows below. -->
    <div class="personalize__head">
      <span class="personalize__title">{{ t('settings.personalize.title') }}</span>
      <KpToggle
        :on="active"
        :disabled="!props.canEdit"
        data-testid="personalize-master"
        @update:on="value => save({ memory_enabled: value })"
      />
      <span class="personalize__master">{{ t('settings.personalize.master') }}</span>
    </div>
    <p class="t-sub-multi personalize__desc">{{ t('settings.personalize.desc') }}</p>

    <KpTabStrip :tabs="tabs" :active="section" @pick="key => (section = key as Section)" />

    <KpEmptyState
      v-if="!active"
      :title="t('settings.personalize.offTitle')"
      :body="t('settings.personalize.offBody')"
    >
      <template v-if="props.canEdit" #action>
        <KpBtn kind="dark" size="m" @click="save({ memory_enabled: true })">
          {{ t('settings.personalize.enable') }}
        </KpBtn>
      </template>
    </KpEmptyState>

    <div v-else class="tabfade">
      <template v-if="section === 'basic'">
        <KpSectionTitle :note="t('settings.personalize.memoryNote')">
          {{ t('settings.tabs.memory') }}
        </KpSectionTitle>
        <SettingRow :label="t('settings.memory.userProfile')" :hint="t('settings.memory.userProfileHint')">
          <NSwitch
            :value="settingsStore.memory.user_profile_enabled"
            :disabled="!props.canEdit"
            @update:value="value => save({ user_profile_enabled: value })"
          />
        </SettingRow>
        <SettingRow :label="t('settings.memory.charLimit')" :hint="t('settings.memory.charLimitHint')">
          <NInputNumber
            :value="settingsStore.memory.memory_char_limit"
            :min="100"
            :max="10000"
            :step="100"
            :disabled="!props.canEdit"
            size="small"
            class="input-sm"
            @update:value="value => value != null && debouncedSave('memory_char_limit', value)"
          />
        </SettingRow>
        <SettingRow :label="t('settings.memory.userCharLimit')" :hint="t('settings.memory.userCharLimitHint')">
          <NInputNumber
            :value="settingsStore.memory.user_char_limit"
            :min="100"
            :max="10000"
            :step="100"
            :disabled="!props.canEdit"
            size="small"
            class="input-sm"
            @update:value="value => value != null && debouncedSave('user_char_limit', value)"
          />
        </SettingRow>
      </template>

      <!-- No invented rows: each of these needs a source this app cannot read
           yet, and the empty state names which one. -->
      <KpEmptyState
        v-else
        :title="t(`settings.personalize.pending.${section}`)"
        :body="t('settings.personalize.pendingBody')"
      />
    </div>
  </section>
</template>

<style scoped lang="scss">
.settings-save-error {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.personalize__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.personalize__title {
  font: var(--w-semibold) var(--t-16) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
}

.personalize__master {
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
}

.personalize__desc {
  margin-bottom: 24px;
}
</style>
