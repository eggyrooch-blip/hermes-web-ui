<script setup lang="ts">
import { computed, defineAsyncComponent, h, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { NAlert, NButton, NIcon, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { fetchFilePreviewBlob, getFileDownloadUrl } from '@/api/hermes/files'
import { fetchWorkspaceRunChangeFile } from '@/api/hermes/sessions'
import { previewMimeMatches } from '@/utils/hermes/file-preview'
import type { BinaryPreviewKind } from '@/utils/hermes/file-preview'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'

// The four office renderers pull in pdfjs / docx-preview / the pptx renderer /
// read-excel-file. Loading them lazily keeps every one of those out of the
// initial bundle — a session that never opens a report never pays for them.
const PdfFilePreview = defineAsyncComponent(() => import('./PdfFilePreview.vue'))
const DocxFilePreview = defineAsyncComponent(() => import('./DocxFilePreview.vue'))
const PptxFilePreview = defineAsyncComponent(() => import('./PptxFilePreview.vue'))
const SpreadsheetFilePreview = defineAsyncComponent(() => import('./SpreadsheetFilePreview.vue'))

const BINARY_PREVIEW_TYPES = new Set<string>(['pdf', 'docx', 'presentation', 'spreadsheet'])

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
withDefaults(defineProps<{ showClose?: boolean }>(), { showClose: true })
const activePane = ref<'file' | 'diff'>('file')
const diffPatch = ref('')
const diffLoading = ref(false)
const diffError = ref('')
const diffTruncated = ref(false)
const loadedDiffKey = ref('')
let diffRequestId = 0

// HTML artifacts default to the rendered (iframe) view; the toggle lets the
// user flip to the raw highlighted source. Reset to rendered whenever the
// previewed file changes so a new artifact never inherits the prior mode.
const htmlShowSource = ref(false)
const previewContextKey = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile) return ''
  const diff = previewFile.diff
  return diff
    ? `${previewFile.path}\u0000${diff.sessionId}\u0000${diff.changeId}\u0000${diff.fileId}`
    : previewFile.path
})
watch(
  previewContextKey,
  () => {
    diffRequestId += 1
    htmlShowSource.value = false
    // A changed office file opens on the rendered document, not on its patch:
    // the diff of a binary part is unreadable, and the whole point of clicking
    // the card is to see the report.
    const previewed = filesStore.previewFile
    activePane.value = previewed?.diff && !(previewed.type && BINARY_PREVIEW_TYPES.has(previewed.type))
      ? 'diff'
      : 'file'
    diffPatch.value = ''
    diffLoading.value = false
    diffError.value = ''
    diffTruncated.value = false
    loadedDiffKey.value = ''
  },
  { immediate: true, flush: 'sync' },
)

watch(
  [activePane, previewContextKey],
  async () => {
    const requestId = ++diffRequestId
    const diff = filesStore.previewFile?.diff
    const key = previewContextKey.value
    if (activePane.value !== 'diff' || !diff || !key || loadedDiffKey.value === key) return

    diffLoading.value = true
    diffError.value = ''
    try {
      const detail = await fetchWorkspaceRunChangeFile(diff.sessionId, diff.changeId, diff.fileId, diff.profile)
      if (!detail) throw new Error(t('chat.workspaceDiffLoadFailed'))
      if (requestId !== diffRequestId) return
      diffPatch.value = detail.patch || ''
      diffTruncated.value = !!detail.truncated
      loadedDiffKey.value = key
    } catch (err) {
      if (requestId !== diffRequestId) return
      diffError.value = err instanceof Error && err.message
        ? err.message
        : t('chat.workspaceDiffLoadFailed')
    } finally {
      if (requestId === diffRequestId) diffLoading.value = false
    }
  },
  { immediate: true },
)

const binaryKind = computed<BinaryPreviewKind | null>(() => {
  const type = filesStore.previewFile?.type
  return type && BINARY_PREVIEW_TYPES.has(type) ? type as BinaryPreviewKind : null
})

const previewBuffer = shallowRef<ArrayBuffer | null>(null)
const binaryLoading = ref(false)
const binaryError = ref('')
let binaryController: AbortController | null = null
let binaryGeneration = 0

function resetBinaryPreview(): void {
  binaryController?.abort()
  binaryController = null
  previewBuffer.value = null
  binaryError.value = ''
  binaryLoading.value = false
}

async function loadBinaryPreview(): Promise<void> {
  const generation = ++binaryGeneration
  resetBinaryPreview()
  const file = filesStore.previewFile
  const kind = binaryKind.value
  if (!file || !kind) return
  binaryController = new AbortController()
  binaryLoading.value = true
  try {
    const blob = await fetchFilePreviewBlob(file.path, binaryController.signal)
    if (generation !== binaryGeneration) return
    // The renderers parse whatever bytes they get, so a response that does not
    // carry the MIME type we dispatched on never reaches them.
    if (!previewMimeMatches(kind, blob.type)) throw new Error(t('files.previewMimeMismatch'))
    const buffer = await blob.arrayBuffer()
    if (generation !== binaryGeneration) return
    previewBuffer.value = buffer
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError' || generation !== binaryGeneration) return
    binaryError.value = err instanceof Error && err.message ? err.message : t('files.previewFailed')
  } finally {
    if (generation === binaryGeneration) binaryLoading.value = false
  }
}

// A renderer that fails mid-parse (corrupt archive, unsupported construct)
// must land in the same place a failed fetch does: an error plus a download,
// never a blank pane.
function handleRendererError(error: Error): void {
  binaryError.value = error.message || t('files.previewFailed')
}

function binaryDownloadUrl(): string {
  const file = filesStore.previewFile
  return file ? getFileDownloadUrl(file.path) : ''
}

watch([binaryKind, previewContextKey], () => { void loadBinaryPreview() }, { immediate: true })
onBeforeUnmount(() => {
  binaryGeneration += 1
  resetBinaryPreview()
})

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

const highlightedDiff = computed(() => {
  if (!diffPatch.value) return ''
  return renderHighlightedCodeBlock(diffPatch.value, 'diff', t('common.copy'), {
    formatDiffFoldLabel: (hiddenCount) => t('chat.unchangedLines', { count: hiddenCount }),
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
        <div v-if="filesStore.previewFile.diff" class="preview-pane-toggle">
          <NButton
            size="small"
            quaternary
            :type="activePane === 'file' ? 'primary' : 'default'"
            @click="activePane = 'file'"
          >
            {{ t('files.previewFileTab') }}
          </NButton>
          <NButton
            size="small"
            quaternary
            :type="activePane === 'diff' ? 'primary' : 'default'"
            @click="activePane = 'diff'"
          >
            {{ t('files.previewDiffTab') }}
          </NButton>
        </div>
        <NButton
          v-if="filesStore.previewFile.type === 'html' && activePane === 'file'"
          size="small"
          quaternary
          @click="htmlShowSource = !htmlShowSource"
        >
          {{ htmlShowSource ? t('files.previewRender') : t('files.previewSource') }}
        </NButton>
        <NButton v-if="showClose" size="small" quaternary @click="filesStore.closePreview()">
          <template #icon>
            <NIcon><CloseIcon /></NIcon>
          </template>
          {{ t('files.closePreview') }}
        </NButton>
      </div>
    </div>
    <div class="preview-content">
      <div v-if="activePane === 'diff' && filesStore.previewFile.diff" class="preview-diff">
        <div v-if="diffLoading" class="preview-diff-state">{{ t('common.loading') }}</div>
        <div v-else-if="diffError" class="preview-diff-state error">{{ diffError }}</div>
        <template v-else>
          <div v-if="diffTruncated" class="preview-diff-truncated">{{ t('files.diffPatchTruncated') }}</div>
          <div
            v-if="diffPatch"
            class="preview-code preview-diff-patch"
            v-html="highlightedDiff"
            @click="handlePreviewClick"
          />
          <div v-else-if="!diffTruncated" class="preview-diff-state">{{ t('files.diffPatchEmpty') }}</div>
        </template>
      </div>
      <template v-else>
        <div v-if="filesStore.previewFile.contentError" class="preview-diff-state error">
          {{ t('files.previewContentUnavailable') }}
        </div>
        <img
          v-else-if="filesStore.previewFile.type === 'image'"
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
        <template v-else-if="binaryKind">
          <NAlert v-if="binaryError" type="error" class="preview-binary-error">
            <template #header>{{ t('files.previewFailed') }}</template>
            <div class="preview-binary-error-message">{{ binaryError }}</div>
            <div class="preview-binary-error-action">
              <NButton size="small" tag="a" :href="binaryDownloadUrl()" download>
                {{ t('files.downloadInstead') }}
              </NButton>
            </div>
          </NAlert>
          <NSpin v-else-if="binaryLoading || !previewBuffer" :description="t('files.previewLoading')" />
          <PdfFilePreview
            v-else-if="binaryKind === 'pdf'"
            :data="previewBuffer"
            @error="handleRendererError"
          />
          <DocxFilePreview
            v-else-if="binaryKind === 'docx'"
            :data="previewBuffer"
            @error="handleRendererError"
          />
          <PptxFilePreview
            v-else-if="binaryKind === 'presentation'"
            :data="previewBuffer"
            @error="handleRendererError"
          />
          <SpreadsheetFilePreview
            v-else-if="binaryKind === 'spreadsheet'"
            :data="previewBuffer"
            @error="handleRendererError"
          />
        </template>
      </template>
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

.preview-pane-toggle {
  display: flex;
  align-items: center;
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

.preview-diff {
  width: 100%;
}

.preview-diff-state {
  color: $text-muted;
  font-size: 13px;

  &.error {
    color: $error;
  }
}

.preview-diff-truncated {
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  color: $text-secondary;
  background: rgba(var(--accent-primary-rgb), 0.06);
  font-size: 12px;
}

.preview-binary-error {
  width: min(680px, 100%);
  align-self: flex-start;
}

.preview-binary-error-message {
  overflow-wrap: anywhere;
}

.preview-binary-error-action {
  margin-top: 12px;
}

.preview-html-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
