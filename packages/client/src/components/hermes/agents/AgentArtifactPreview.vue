<script setup lang="ts">
/**
 * Artifact reader for the agent-detail 产物 tab.
 *
 * Anatomy is the prototype's LibraryScreen DocView (athand-manage.jsx ~2390):
 * a 52px header carrying `产物 › 文件名` plus the icon affordances, then the
 * document body. HTML artifacts get the prototype's mock-browser chrome
 * (traffic lights + a `file://` pill) around the rendered page.
 *
 * Deviation from the prototype, deliberately: the prototype's HTML row opens a
 * blob URL in a real tab, which would execute the artifact's scripts with a
 * normal origin. This renders through the same locked-down iframe FilePreview
 * uses — `srcdoc` + `sandbox="allow-same-origin"`, never `allow-scripts` — and
 * offers 渲染/源码 instead. Preview must not be a way to run a file.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpIconBtn from '@/components/kippies/KpIconBtn.vue'
import KpGhostBtn from '@/components/kippies/KpGhostBtn.vue'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { getFileDownloadUrl, type FileEntry } from '@/api/hermes/files'

export type ArtifactKind = 'image' | 'markdown' | 'html' | 'text' | 'binary'

const props = defineProps<{
  entry: FileEntry
  kind: ArtifactKind
  content: string
  profile: string
  loading?: boolean
  error?: string
  downloading?: boolean
}>()

const emit = defineEmits<{ close: []; download: [] }>()

const { t } = useI18n()

// Rendered by default; a new artifact never inherits the previous source mode.
const showSource = ref(false)
watch(() => props.entry.path, () => { showSource.value = false })

const imageUrl = computed(() =>
  props.kind === 'image' ? getFileDownloadUrl(props.entry.path, props.entry.name, props.profile) : '',
)
</script>

<template>
  <div class="artifact-doc" data-testid="agent-artifact-preview">
    <div class="artifact-doc__head">
      <span class="artifact-doc__crumb">{{ t('agentDetail.tabs.artifacts') }}</span>
      <KpIcon name="line_arrow_right" :size="12" class="artifact-doc__crumb-sep" />
      <span class="artifact-doc__name">{{ entry.name }}</span>
      <KpIconBtn
        v-if="kind === 'html'"
        name="line_link"
        :size="16"
        :active="showSource"
        :title="showSource ? t('files.previewRender') : t('files.previewSource')"
        data-testid="agent-artifact-source-toggle"
        @click="showSource = !showSource"
      />
      <KpIconBtn
        name="line_download"
        :size="16"
        :title="t('files.download')"
        data-testid="agent-artifact-download"
        @click="emit('download')"
      />
      <KpIconBtn
        name="line_close"
        :size="16"
        :title="t('files.closePreview')"
        data-testid="agent-artifact-close"
        @click="emit('close')"
      />
    </div>

    <div v-if="loading" class="artifact-doc__note">{{ t('files.loading') }}</div>
    <div v-else-if="error" class="artifact-doc__note">{{ error }}</div>

    <!-- Prototype's browser shell: the artifact is a page, so it is shown
         inside something that looks like the thing that would open it. -->
    <div v-else-if="kind === 'html' && !showSource" class="artifact-browser">
      <div class="artifact-browser__bar">
        <span class="artifact-browser__dots">
          <i style="background: #ec6a5e" />
          <i style="background: #f5bf4f" />
          <i style="background: #61c554" />
        </span>
        <span class="artifact-browser__url">
          <KpIcon name="line_lock" :size="11" />
          <span class="t-meta">file://workspace/{{ entry.path }}</span>
        </span>
      </div>
      <iframe
        :srcdoc="content"
        class="artifact-browser__frame"
        sandbox="allow-same-origin"
        referrerpolicy="no-referrer"
        :title="entry.path"
      />
    </div>

    <div v-else-if="kind === 'image'" class="artifact-doc__body is-image">
      <img :src="imageUrl" :alt="entry.name" />
    </div>

    <div v-else-if="kind === 'markdown'" class="artifact-doc__body">
      <MarkdownRenderer :content="content" />
    </div>

    <div v-else-if="kind === 'text' || kind === 'html'" class="artifact-doc__body">
      <pre class="artifact-doc__source">{{ content }}</pre>
    </div>

    <!-- Binaries (docx / xlsx / pdf …): the honest answer is "download it",
         with the button right there rather than a dead end. -->
    <div v-else class="artifact-doc__body is-binary">
      <div class="artifact-doc__note">{{ t('agentDetail.artifacts.previewUnsupported') }}</div>
      <KpGhostBtn :disabled="downloading" @click="emit('download')">
        {{ t('files.download') }}
      </KpGhostBtn>
    </div>
  </div>
</template>

<style scoped lang="scss">
.artifact-doc {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

// Prototype DocView header: 52 tall, hairline under, name takes the slack.
.artifact-doc__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  flex: 0 0 auto;
  border-bottom: 0.5px solid var(--divider);
}

.artifact-doc__crumb {
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
}

.artifact-doc__crumb-sep {
  color: var(--fg-disabled);
}

.artifact-doc__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
}

.artifact-doc__note {
  padding: 24px 0;
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  color: var(--fg-aux);
}

.artifact-doc__body {
  padding: 24px 0 8px;
  min-width: 0;

  &.is-image img {
    max-width: 100%;
    border-radius: var(--r-card);
  }

  &.is-binary {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
}

.artifact-doc__source {
  margin: 0;
  padding: 16px;
  border-radius: var(--r-card);
  background: var(--surface-1);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-mono);
  color: var(--fg-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 520px;
  overflow: auto;
}

.artifact-browser {
  margin-top: 20px;
  border-radius: var(--r-card);
  overflow: hidden;
  box-shadow: inset 0 0 0 0.5px var(--divider);
  background: var(--surface-2);
}

.artifact-browser__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 12px;
  background: var(--bg);
  border-bottom: 0.5px solid var(--divider);
}

.artifact-browser__dots {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;

  i {
    width: 11px;
    height: 11px;
    border-radius: var(--r-pill);
  }
}

.artifact-browser__url {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--surface-2);
  color: var(--fg-disabled);

  .t-meta {
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.artifact-browser__frame {
  display: block;
  width: 100%;
  height: 520px;
  border: 0;
  background: #fff;
}
</style>
