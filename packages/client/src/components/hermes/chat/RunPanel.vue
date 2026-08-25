<script setup lang="ts">
/**
 * The run screen's right rail: 进度 / 产物 / 上下文.
 *
 * Three questions about the task in one column — how far along is it, what did
 * it produce, and what is it working from. It replaces the markdown-heading
 * outline that used to live here: the outline answered "what does the answer
 * say", which the transcript itself already shows.
 *
 * Every number here comes from the transcript, not from a plan the server
 * hands down: the steps are the tool calls this run actually made, the
 * artifacts are the MEDIA: paths the assistant wrote, and the sources are the
 * files you attached. Where the prototype has controls we have nothing to
 * persist into (per-source checkboxes, export-all), the row is read-only
 * rather than a switch that forgets.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore, type Message } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { downloadFile, getDownloadUrl } from '@/api/hermes/download'
import { useFilesStore, isHtmlFile } from '@/stores/hermes/files'
import { SUPPORT_PREVIEW_FILE_TYPES } from './mermaidRenderer'
import KpIcon from '@/components/kippies/KpIcon.vue'
import RunPanelSection from './RunPanelSection.vue'

const props = defineProps<{
  messages: Message[]
  running?: boolean
  aborted?: boolean
  /**
   * Artifacts to list. Defaults to the live session's, which is what the run
   * screen wants; the history view passes the session it is showing, since the
   * store's active session is a different one (or none).
   */
  artifacts?: { name: string; path: string }[]
}>()

const emit = defineEmits<{ navigate: [messageId: string] }>()

const { t } = useI18n()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

interface Step {
  messageId: string
  label: string
  state: 'done' | 'running' | 'error'
}

// A step is a tool call. That is the only thing in a Hermes run with a name, an
// outcome and an order — reasoning is continuous, and assistant turns are not
// "steps" so much as one long answer.
const steps = computed<Step[]>(() =>
  props.messages
    .filter(message => !!message.toolName)
    .map(message => ({
      messageId: String(message.id),
      label: message.toolPreview?.trim() || message.toolName || '',
      state:
        message.toolStatus === 'error'
          ? ('error' as const)
          : message.toolStatus === 'running'
            ? ('running' as const)
            : ('done' as const),
    })),
)

const doneCount = computed(() => steps.value.filter(step => step.state === 'done').length)

const stepCountLabel = computed(() => {
  if (!steps.value.length) return null
  if (props.aborted) return t('chat.runPanel.interrupted')
  return `${doneCount.value}/${steps.value.length}`
})

// The line under the rail: what it is doing now, where it stopped, or that it
// is finished.
const currentStepLabel = computed(() => {
  if (!steps.value.length) return ''
  const running = steps.value.find(step => step.state === 'running')
  if (running) return running.label
  const failed = steps.value.find(step => step.state === 'error')
  if (failed) return t('chat.runPanel.stoppedAt', { step: failed.label })
  if (props.running) return t('chat.runPanel.thinking')
  return t('chat.runPanel.allDone')
})

// The last message carrying reasoning — "查看推理过程" jumps to it.
const reasoningMessageId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const message = props.messages[i]
    if (message.reasoning) return String(message.id)
  }
  return null
})

const artifacts = computed(() => props.artifacts ?? chatStore.sessionArtifacts)

function artifactIcon(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return 'full_data'
  if (ext === 'pptx' || ext === 'ppt') return 'line_screen'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return 'line_photo'
  if (ext === 'html' || ext === 'htm') return 'line_link'
  return 'line_content'
}

// Mirrors what clicking the message file card does (MarkdownRenderer's
// `.markdown-file-card` handler): HTML artifacts open in the embedded browser
// with a real preview URL, other previewable files open in the file panel, and
// anything we cannot render falls back to a download rather than doing nothing.
// The card carries extra branches this panel cannot hit (workspace diffs,
// non-workspace images, the text-preview modal) — artifacts are always
// workspace paths, so these three cases cover them.
async function openArtifact(artifact: { name: string; path: string }): Promise<void> {
  const name = artifact.name || decodeURIComponent(artifact.path.split('/').pop() || '')
  const ext = (name.split('.').pop() || '').toLowerCase()

  if (!SUPPORT_PREVIEW_FILE_TYPES.includes(ext)) {
    await downloadFile(artifact.path, name)
    return
  }
  if (isHtmlFile(name)) {
    useFilesStore().requestBrowserArtifact(name, artifact.path)
    return
  }
  await useFilesStore().previewByDisplayPath(artifact.path, name)
}

// Sources = what you handed it. Deduped by name, first-seen order.
const sources = computed(() => {
  const out: { name: string; url: string }[] = []
  const seen = new Set<string>()
  for (const message of props.messages) {
    for (const attachment of message.attachments || []) {
      if (seen.has(attachment.name)) continue
      seen.add(attachment.name)
      out.push({ name: attachment.name, url: attachment.url })
    }
  }
  return out
})

// Capabilities = the distinct tools this run reached for.
const capabilities = computed(() => {
  const out: string[] = []
  for (const step of steps.value) {
    const message = props.messages.find(item => String(item.id) === step.messageId)
    const name = message?.toolName
    if (name && !out.includes(name)) out.push(name)
  }
  return out
})

const memoryOn = computed(() => !!settingsStore.memory.memory_enabled)

const contextCount = computed(
  () => sources.value.length + capabilities.value.length + (memoryOn.value ? 1 : 0),
)
</script>

<template>
  <aside class="run-panel">
    <RunPanelSection first :title="t('chat.runPanel.progress')" :count="stepCountLabel">
      <div v-if="steps.length" class="run-rail">
        <template v-for="(step, index) in steps" :key="step.messageId">
          <span
            v-if="index"
            class="run-rail__link"
            :class="{ 'is-done': steps[index - 1].state === 'done' }"
          />
          <span
            class="run-rail__dot"
            :class="[`is-${step.state}`, { pulse: step.state === 'running' }]"
            :title="step.label"
          >
            <KpIcon v-if="step.state === 'done'" name="line_check" :size="11" color="var(--action-press)" />
            <KpIcon v-else-if="step.state === 'error'" name="line_close" :size="10" color="var(--danger)" />
            <span v-else class="run-rail__pip" />
          </span>
        </template>
      </div>
      <template v-if="steps.length">
        <div class="t-sub run-progress__now">{{ currentStepLabel }}</div>
        <div class="t-meta run-progress__count">
          {{ t('chat.runPanel.stepCount', { done: doneCount, total: steps.length }) }}
        </div>
        <button
          v-if="reasoningMessageId"
          type="button"
          class="ab run-progress__reason"
          @click="emit('navigate', reasoningMessageId)"
        >
          {{ t('chat.runPanel.openReasoning') }}
          <KpIcon name="line_arrow_right" :size="12" />
        </button>
      </template>
      <div v-else class="t-meta run-empty">{{ t('chat.runPanel.noSteps') }}</div>
    </RunPanelSection>

    <RunPanelSection :title="t('chat.runPanel.outputs')" :count="artifacts.length ? String(artifacts.length) : null">
      <!--
        The row opens, the ⬇ downloads — the same split the message file card
        already has. This whole row used to be one `<a download>`, so clicking
        the name downloaded the file and the icon was inert decoration.
      -->
      <div v-if="artifacts.length" class="run-rows">
        <div v-for="artifact in artifacts" :key="artifact.path" class="run-row">
          <button
            type="button"
            class="run-row__open"
            :title="artifact.path"
            @click="openArtifact(artifact)"
          >
            <span class="run-row__tile">
              <KpIcon :name="artifactIcon(artifact.name)" :size="15" />
            </span>
            <span class="t-sub run-row__name">{{ artifact.name }}</span>
          </button>
          <a
            class="run-row__action"
            :href="getDownloadUrl(artifact.path, artifact.name)"
            :download="artifact.name"
            :title="t('download.downloadFile')"
            :aria-label="t('download.downloadFile')"
          >
            <KpIcon name="line_download" :size="14" />
          </a>
        </div>
      </div>
      <div v-else class="t-meta run-empty">
        {{ running ? t('chat.runPanel.outputsPending') : t('chat.runPanel.outputsNone') }}
      </div>
    </RunPanelSection>

    <RunPanelSection
      :title="t('chat.runPanel.context')"
      :count="contextCount ? t('chat.runPanel.contextCount', { count: contextCount }) : null"
    >
      <div class="t-meta run-lead">{{ t('chat.runPanel.sourcesLead') }}</div>
      <div v-if="sources.length" class="run-rows run-rows--tight">
        <a
          v-for="source in sources"
          :key="source.name"
          class="run-row run-row--compact"
          :href="source.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          <KpIcon name="line_link" :size="14" class="run-row__leading" />
          <span class="t-sub run-row__name">{{ source.name }}</span>
        </a>
      </div>
      <div v-else class="t-meta run-empty run-empty--tight">{{ t('chat.runPanel.sourcesNone') }}</div>

      <div class="t-meta run-lead">{{ t('chat.runPanel.memoryLead') }}</div>
      <div class="t-sub run-note">
        {{ memoryOn ? t('chat.runPanel.memoryOn') : t('chat.runPanel.memoryOff') }}
      </div>

      <div class="t-meta run-lead">{{ t('chat.runPanel.capabilities') }}</div>
      <div v-if="capabilities.length" class="run-caps">
        <span v-for="name in capabilities" :key="name" class="t-meta run-cap">{{ name }}</span>
      </div>
      <div v-else class="t-meta run-empty run-empty--tight">{{ t('chat.runPanel.capabilitiesNone') }}</div>
    </RunPanelSection>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-panel {
  width: 320px;
  flex: 0 0 320px;
  height: 100%;
  overflow: auto;
  padding: 8px 20px 32px;
  background: var(--bg);
  border-left: 0.5px solid var(--divider);

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(320px, 86vw);
    z-index: 8;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
  }
}

// Progress rail: dots joined by hairlines, the joint darkening once the step
// before it has landed.
.run-rail {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}

.run-rail__link {
  flex: 1;
  height: 1px;
  background: var(--divider);

  &.is-done {
    background: var(--gray-cc);
  }
}

.run-rail__dot {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  border-radius: var(--r-pill);
  display: grid;
  place-items: center;
  box-shadow: inset 0 0 0 1px var(--gray-cc);

  &.is-done {
    background: var(--keep-green-bg);
    box-shadow: inset 0 0 0 1px var(--keep-green);
  }

  &.is-running {
    box-shadow: inset 0 0 0 1px var(--keep-green);
  }

  &.is-error {
    box-shadow: inset 0 0 0 1px var(--danger);
  }
}

.run-rail__pip {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--keep-green);
}

.run-progress__now {
  color: var(--fg-primary);
}

.run-progress__count {
  margin-top: 4px;
}

.run-progress__reason {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
}

.run-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.run-rows--tight {
  margin-bottom: 16px;
}

.run-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  margin: 0 -10px;
  border-radius: var(--r-ctl);
  color: inherit;
  cursor: pointer;

  &:hover {
    background: var(--surface-1);
  }
}

.run-row--compact {
  padding: 6px 10px;
}

.run-row__tile {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  display: grid;
  place-items: center;
  color: var(--fg-aux);
}

.run-row__leading {
  flex: 0 0 auto;
  color: var(--fg-aux);
}

.run-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// The open target fills the row so the whole name area is clickable; the row
// keeps owning the padding and hover so the split is invisible.
.run-row__open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.run-row__action {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--r-ctl);
  color: var(--fg-aux);

  &:hover {
    background: var(--surface-2);
    color: var(--fg-secondary);
  }
}

.run-lead {
  color: var(--fg-disabled);
  margin-bottom: 6px;
}

.run-note {
  margin-bottom: 16px;
}

.run-caps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.run-cap {
  padding: 2px 8px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--fg-secondary);
}

.run-empty {
  color: var(--fg-disabled);
}

.run-empty--tight {
  margin-bottom: 16px;
}
</style>
