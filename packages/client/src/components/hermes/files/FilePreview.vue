<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { getFileDownloadUrl } from '@/api/hermes/files'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

// HTML artifacts default to the rendered (iframe) view; the toggle lets the
// user flip to the raw highlighted source. Reset to rendered whenever the
// previewed file changes so a new artifact never inherits the prior mode.
const htmlShowSource = ref(false)
watch(
  () => filesStore.previewFile?.path,
  () => { htmlShowSource.value = false },
)

function getImageUrl(): string {
  if (!filesStore.previewFile) return ''
  return getFileDownloadUrl(filesStore.previewFile.path)
}

// Render via srcdoc (the already-loaded file content), NOT an iframe src to
// /api/hermes/download: that endpoint sends X-Frame-Options: DENY + CSP
// frame-ancestors 'none' + Content-Disposition: attachment, so the browser
// refuses to frame it (blank iframe). srcdoc sidesteps all three, never makes
// a second HTTP fetch, and combined with sandbox="" the document gets a unique
// opaque origin with scripts disabled — strictly safer than a URL load.
const htmlContent = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile || previewFile.type !== 'html') return ''
  return previewFile.content || ''
})

const highlightedPreview = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile || previewFile.type !== 'text') return ''
  return renderHighlightedCodeBlock(previewFile.content || '', previewFile.language, t('common.copy'), {
    maxHighlightLength: 200_000,
  })
})

const highlightedHtmlSource = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile || previewFile.type !== 'html') return ''
  return renderHighlightedCodeBlock(previewFile.content || '', previewFile.language, t('common.copy'), {
    maxHighlightLength: 200_000,
  })
})

async function handlePreviewClick(event: MouseEvent) {
  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult) {
    message.success(t('common.copied'))
  } else if (copyResult === false) {
    message.error(t('chat.copyFailed'))
  }
}

const CloseIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', width: '14', height: '14', fill: 'currentColor' },
    [h('path', { d: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' })],
  )
</script>

<template>
  <div class="file-preview" v-if="filesStore.previewFile">
    <div class="preview-header">
      <span class="preview-filename">{{ filesStore.previewFile.path }}</span>
      <div class="preview-actions">
        <NButton
          v-if="filesStore.previewFile.type === 'html'"
          size="small"
          quaternary
          @click="htmlShowSource = !htmlShowSource"
        >
          {{ htmlShowSource ? t('files.previewRender') : t('files.previewSource') }}
        </NButton>
        <NButton size="small" quaternary @click="filesStore.closePreview()">
          <template #icon>
            <NIcon><CloseIcon /></NIcon>
          </template>
          {{ t('files.closePreview') }}
        </NButton>
      </div>
    </div>
    <div class="preview-content">
      <img
        v-if="filesStore.previewFile.type === 'image'"
        :src="getImageUrl()"
        class="preview-image"
        :alt="filesStore.previewFile.path"
      />
      <div v-else-if="filesStore.previewFile.type === 'markdown'" class="preview-markdown">
        <MarkdownRenderer :content="filesStore.previewFile.content || ''" />
      </div>
      <div
        v-else-if="filesStore.previewFile.type === 'text'"
        class="preview-code"
        v-html="highlightedPreview"
        @click="handlePreviewClick"
      />
      <!--
        HTML artifact rendered via srcdoc in a sandbox WITHOUT allow-scripts, so
        a malicious <script> in the artifact never executes (XSS-safe). We use
        sandbox="allow-same-origin" rather than sandbox="" deliberately: a srcdoc
        document inherits the parent page's CSP (default-src 'self'), and an empty
        sandbox gives it an OPAQUE origin that fails the 'self' check — the inline
        styles get blocked and the report renders blank. allow-same-origin makes
        the srcdoc origin match 'self' so styles render, while the absence of
        allow-scripts still blocks all script execution. NEVER add allow-scripts
        here — allow-scripts + allow-same-origin together would let the artifact
        remove its own sandbox. Content (htmlContent) is the already-loaded file,
        not an iframe src, because the download endpoint blocks framing
        (X-Frame-Options: DENY / CSP frame-ancestors 'none').
      -->
      <iframe
        v-else-if="filesStore.previewFile.type === 'html' && !htmlShowSource"
        :srcdoc="htmlContent"
        class="preview-html-frame"
        sandbox="allow-same-origin"
        referrerpolicy="no-referrer"
        :title="filesStore.previewFile.path"
      />
      <div
        v-else-if="filesStore.previewFile.type === 'html' && htmlShowSource"
        class="preview-code"
        v-html="highlightedHtmlSource"
        @click="handlePreviewClick"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.preview-filename {
  font-size: 13px;
  color: $text-secondary;
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.preview-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-markdown {
  max-width: 800px;
  width: 100%;
}

.preview-code {
  width: 100%;

  :deep(.hljs-code-block) {
    margin: 0;
  }
}

.preview-html-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
