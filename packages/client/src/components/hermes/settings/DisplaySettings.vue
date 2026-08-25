<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NSwitch, NSelect, NInputNumber } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useChatStore } from '@/stores/hermes/chat'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import { useTheme, type BrightnessMode } from '@/composables/useTheme'
import { requestCompletionNotificationPermission, showCompletionNotification, type CompletionNotificationPermissionResult } from '@/utils/completion-notification'
import { CHAT_INPUT_HEIGHT_DEFAULT, CHAT_INPUT_HEIGHT_MAX, CHAT_INPUT_HEIGHT_MIN, clampChatInputHeight } from '@/utils/chat-input-height'
import SettingRow from './SettingRow.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'

const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const { t } = useI18n()
const { brightness, setBrightness } = useTheme()

// Two display toggles relocated here from the composer's removed "⋯" menu.
const { toolTraceVisible, setToolTraceVisible } = useToolTraceVisibility()
/** Save failures and notification-permission problems for this pane. */
const paneError = ref('')
const autoPlaySpeech = ref(readAutoPlaySpeech())

function readAutoPlaySpeech(): boolean {
  try {
    return localStorage.getItem('autoPlaySpeech') === 'true'
  } catch {
    return false
  }
}

function handleAutoPlaySpeechChange(value: boolean) {
  autoPlaySpeech.value = value
  try {
    localStorage.setItem('autoPlaySpeech', String(value))
  } catch {
    // Ignore storage failures; the in-memory toggle still drives this session.
  }
  chatStore.setAutoPlaySpeech(value)
}
const chatInputHeight = computed(() => clampChatInputHeight(settingsStore.display.chat_input_height ?? CHAT_INPUT_HEIGHT_DEFAULT))

const themeOptions = [
  { label: t('settings.display.themeLight'), value: 'light' },
  { label: t('settings.display.themeDark'), value: 'dark' },
  { label: t('settings.display.themeSystem'), value: 'system' },
]

async function save(values: Record<string, any>): Promise<boolean> {
  paneError.value = ''
  try {
    await settingsStore.saveSection('display', values)
    // The control is already showing the new value; nothing to announce.
    return true
  } catch {
    paneError.value = t('settings.saveFailed')
    return false
  }
}

async function handleThemeChange(val: string) {
  const next = val as BrightnessMode
  const previous = settingsStore.display.skin as BrightnessMode | undefined
  // Applied straight away so the theme responds to the click, and put back if
  // the save is refused — otherwise the app sits in a theme the server does not
  // have, and the next reload silently undoes it.
  setBrightness(next)
  const ok = await save({ skin: next })
  if (!ok && previous) setBrightness(previous)
}

function handleChatInputHeightChange(value: number | null) {
  save({ chat_input_height: clampChatInputHeight(value) })
}

function notificationPermissionErrorKey(result: CompletionNotificationPermissionResult): string {
  if (result.reason === 'insecure') return 'settings.display.notifyOnCompleteInsecure'
  if (result.reason === 'unsupported') return 'settings.display.notifyOnCompleteUnsupported'
  return 'settings.display.notifyOnCompleteDenied'
}

async function handleNotifyOnCompleteChange(value: boolean) {
  if (value) {
    const result = await requestCompletionNotificationPermission()
    if (!result.granted) {
      paneError.value = t(notificationPermissionErrorKey(result))
      return
    }
  }
  await save({ notify_on_complete: value })
  if (value) {
    void showCompletionNotification({
      title: 'Hermes',
      body: t('settings.display.notifyOnCompleteTest'),
      icon: '/coding-agents/hermes.png',
      tag: `hermes-complete-test-${Date.now()}`,
    })
  }
}

async function testCompletionNotification() {
  paneError.value = ''
  const result = await requestCompletionNotificationPermission()
  if (!result.granted) {
    paneError.value = t(notificationPermissionErrorKey(result))
    return
  }
  const shown = await showCompletionNotification({
    title: 'Hermes',
    body: t('settings.display.notifyOnCompleteTest'),
    icon: '/coding-agents/hermes.png',
    tag: `hermes-complete-test-${Date.now()}`,
  })
  // Nothing to say on success: the point of the test is that a real OS
  // notification appears, and it just did. Saying "sent" as well would be a
  // second, weaker copy of the thing being demonstrated.
  if (!shown) paneError.value = t('settings.display.notifyOnCompleteTestFailed')
}
</script>

<template>
  <section class="settings-section">
    <p v-if="paneError" class="settings-save-error" data-testid="display-settings-error">{{ paneError }}</p>
    <KpSectionTitle>{{ t('settings.display.sectionAppearance') }}</KpSectionTitle>
    <SettingRow :label="t('settings.display.theme')" :hint="t('settings.display.themeHint')">
      <NSelect :value="brightness" :options="themeOptions" size="small" :consistent-menu-width="false" class="input-sm" @update:value="handleThemeChange" />
    </SettingRow>
    <SettingRow :label="t('settings.display.streaming')" :hint="t('settings.display.streamingHint')">
      <NSwitch :value="settingsStore.display.streaming" @update:value="v => save({ streaming: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.compact')" :hint="t('settings.display.compactHint')">
      <NSwitch :value="settingsStore.display.compact" @update:value="v => save({ compact: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.chatInputHeight')" :hint="t('settings.display.chatInputHeightHint')">
      <NInputNumber
        :value="chatInputHeight"
        :min="CHAT_INPUT_HEIGHT_MIN"
        :max="CHAT_INPUT_HEIGHT_MAX"
        :step="4"
        size="small"
        class="input-xs"
        @update:value="handleChatInputHeightChange"
      />
    </SettingRow>

    <KpSectionTitle class="settings-section__title">{{ t('settings.display.sectionConversation') }}</KpSectionTitle>
    <SettingRow :label="t('settings.display.autoPlaySpeech')" :hint="t('settings.display.autoPlaySpeechHint')">
      <NSwitch :value="autoPlaySpeech" @update:value="handleAutoPlaySpeechChange" />
    </SettingRow>
    <SettingRow :label="t('settings.display.toolTrace')" :hint="t('settings.display.toolTraceHint')">
      <NSwitch :value="toolTraceVisible" @update:value="setToolTraceVisible" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showReasoning')" :hint="t('settings.display.showReasoningHint')">
      <NSwitch :value="settingsStore.display.show_reasoning" @update:value="v => save({ show_reasoning: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showCost')" :hint="t('settings.display.showCostHint')">
      <NSwitch :value="settingsStore.display.show_cost" @update:value="v => save({ show_cost: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.inlineDiffs')" :hint="t('settings.display.inlineDiffsHint')">
      <NSwitch :value="settingsStore.display.inline_diffs" @update:value="v => save({ inline_diffs: v })" />
    </SettingRow>

    <KpSectionTitle class="settings-section__title">{{ t('settings.display.sectionNotifications') }}</KpSectionTitle>
    <SettingRow :label="t('settings.display.bellOnComplete')" :hint="t('settings.display.bellOnCompleteHint')">
      <NSwitch :value="settingsStore.display.bell_on_complete" @update:value="v => save({ bell_on_complete: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.notifyOnComplete')" :hint="`${t('settings.display.notifyOnCompleteHint')} ${t('settings.display.notifyOnCompleteMacHint')}`">
      <div class="notify-controls">
        <NSwitch :value="settingsStore.display.notify_on_complete" @update:value="handleNotifyOnCompleteChange" />
        <NButton size="tiny" secondary @click="testCompletionNotification">
          {{ t('settings.display.notifyOnCompleteTestButton') }}
        </NButton>
      </div>
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

.settings-section__title {
  margin-top: 36px;
}

.notify-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
</style>
