<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton } from 'naive-ui'
import { getFilePreviewUrl } from '@/api/hermes/files'
import { decodeDisplayPathSegments } from '@/stores/hermes/files'

interface ArtifactEntry {
  name: string
  url: string
}

// Embedded browser for chat-produced artifacts. The iframe points at the real
// /api/hermes/preview URL (NOT srcdoc); the server serves it inline + framable
// under `Content-Security-Policy: frame-ancestors 'self'`. The iframe is
// sandboxed to `allow-same-origin` only — NO allow-scripts — so a malicious
// artifact cannot run scripts against the app origin.

const history = ref<ArtifactEntry[]>([])
const cursor = ref(-1)

const current = computed<ArtifactEntry | null>(() => history.value[cursor.value] ?? null)
const previewUrl = computed<string>(() => current.value?.url ?? '')
const canGoBack = computed<boolean>(() => cursor.value > 0)
const canGoForward = computed<boolean>(() => cursor.value < history.value.length - 1)

async function resolveArtifactUrl(name: string, displayPath: string): Promise<string> {
  // The display path segments are encodeURIComponent-encoded; decode before
  // handing to getFilePreviewUrl (which re-encodes via URLSearchParams).
  // Two server planes root the files API differently (mirrors files store
  // previewByDisplayPath): chat-plane (Feishu) roots at the workspace, so the
  // workspace-relative form works; admin plane roots at the profile home, so it
  // needs the `workspace/` prefix. Try the chat-plane form, fall back to the
  // admin form if it 404s — so the embedded browser works on either plane.
  const rel = decodeDisplayPathSegments(displayPath.replace(/^\/workspace\//, ''))
  const chatPlaneUrl = getFilePreviewUrl(rel, name)
  try {
    const res = await fetch(chatPlaneUrl, { method: 'HEAD' })
    if (res.ok) return chatPlaneUrl
  } catch {
    /* fall through to the admin form */
  }
  const adminRel = decodeDisplayPathSegments('workspace/' + rel.replace(/^workspace\//, ''))
  return getFilePreviewUrl(adminRel, name)
}

async function load(artifact: { name: string, path: string }): Promise<void> {
  const url = await resolveArtifactUrl(artifact.name, artifact.path)
  // Navigating to a new artifact truncates any forward history.
  if (cursor.value < history.value.length - 1) {
    history.value = history.value.slice(0, cursor.value + 1)
  }
  const last = history.value[history.value.length - 1]
  if (last && last.url === url) {
    cursor.value = history.value.length - 1
    return
  }
  history.value.push({ name: artifact.name, url })
  cursor.value = history.value.length - 1
}

function goBack(): void {
  if (canGoBack.value) cursor.value -= 1
}

function goForward(): void {
  if (canGoForward.value) cursor.value += 1
}

defineExpose({ load })
</script>

<template>
  <div class="artifact-browser">
    <div class="artifact-browser-bar">
      <NButton
        size="tiny"
        quaternary
        :disabled="!canGoBack"
        aria-label="back"
        @click="goBack"
      >
        ‹
      </NButton>
      <NButton
        size="tiny"
        quaternary
        :disabled="!canGoForward"
        aria-label="forward"
        @click="goForward"
      >
        ›
      </NButton>
      <input
        class="artifact-browser-address"
        type="text"
        readonly
        :value="previewUrl"
        :title="previewUrl"
      >
    </div>
    <div class="artifact-browser-viewport">
      <iframe
        v-if="previewUrl"
        class="artifact-browser-frame"
        :src="previewUrl"
        sandbox="allow-same-origin"
        referrerpolicy="no-referrer"
      />
      <div
        v-else
        class="artifact-browser-empty"
      >
        在概览中选择一个产出物，或点击聊天里的 HTML 文件卡片
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.artifact-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.artifact-browser-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.artifact-browser-address {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-color-2, inherit);
  background: var(--code-bg, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  outline: none;
}

.artifact-browser-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
}

.artifact-browser-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

.artifact-browser-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--text-color-3, rgba(127, 127, 127, 0.7));
}
</style>
