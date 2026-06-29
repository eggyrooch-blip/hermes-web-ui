<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { NDropdown } from 'naive-ui'
import FilesPanel from './FilesPanel.vue'
import ArtifactBrowser from './ArtifactBrowser.vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useFilesStore } from '@/stores/hermes/files'

type DetailMode = 'overview' | 'files' | 'browser' | 'changes'

interface SessionArtifact {
  name: string
  path: string
}

const chatStore = useChatStore()
const filesStore = useFilesStore()

// Default to the workspace files view to preserve the prior single-tab default.
const mode = ref<DetailMode>('files')
const artifactBrowserRef = ref<InstanceType<typeof ArtifactBrowser> | null>(null)

const MODE_LABELS: Record<DetailMode, string> = {
  overview: '概览',
  files: '工作空间文件',
  browser: '浏览器',
  changes: '变更',
}

const modeOptions = (Object.keys(MODE_LABELS) as DetailMode[]).map(key => ({
  key,
  label: MODE_LABELS[key],
}))

const currentModeLabel = computed<string>(() => MODE_LABELS[mode.value])
const artifacts = computed<SessionArtifact[]>(() => chatStore.sessionArtifacts)

function selectMode(key: string): void {
  mode.value = key as DetailMode
}

function openArtifact(artifact: SessionArtifact): void {
  mode.value = 'browser'
  // ArtifactBrowser is always mounted (v-show), so its ref is available.
  artifactBrowserRef.value?.load(artifact)
}

// Consume a pending chat HTML-artifact request: switch to browser mode, load it,
// and clear it so a later unrelated remount of this panel doesn't re-open it.
function consumeBrowserArtifact(): void {
  const artifact = filesStore.browserArtifactRequest
  if (!artifact) return
  filesStore.browserArtifactRequest = null
  openArtifact(artifact)
}

// File-tree preview requests (code/image/markdown) land on the files view.
watch(() => filesStore.previewPanelRequestedAt, () => {
  mode.value = 'files'
})

// Chat HTML-artifact clicks open the embedded browser with that artifact.
watch(() => filesStore.browserArtifactRequestedAt, () => {
  consumeBrowserArtifact()
})

// This panel mounts behind `v-if="showToolPanel"`, so a browser-artifact request
// that ALSO opened the panel fires its signal before this component mounts — the
// watch above would miss it. Handle any pending request on mount too.
onMounted(() => {
  nextTick(() => consumeBrowserArtifact())
})
</script>

<template>
  <div class="detail-panel">
    <div class="detail-panel-header">
      <NDropdown
        trigger="click"
        :options="modeOptions"
        @select="selectMode"
      >
        <button
          class="detail-mode-trigger"
          type="button"
        >
          <span>{{ currentModeLabel }}</span>
          <span class="detail-mode-caret">▾</span>
        </button>
      </NDropdown>
    </div>

    <div class="detail-panel-body">
      <!-- 概览 -->
      <div
        v-show="mode === 'overview'"
        class="detail-overview"
      >
        <template v-if="artifacts.length > 0">
          <button
            v-for="artifact in artifacts"
            :key="artifact.path"
            class="detail-artifact-card"
            type="button"
            :title="artifact.path"
            @click="openArtifact(artifact)"
          >
            <svg
              class="detail-artifact-icon"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 2l4 4h-4z"
              />
            </svg>
            <span class="detail-artifact-name">{{ artifact.name }}</span>
          </button>
        </template>
        <div
          v-else
          class="detail-empty"
        >
          暂无产出物
        </div>
      </div>

      <!-- 工作空间文件 -->
      <FilesPanel v-show="mode === 'files'" />

      <!-- 浏览器 -->
      <ArtifactBrowser
        v-show="mode === 'browser'"
        ref="artifactBrowserRef"
      />

      <!-- 变更 -->
      <div
        v-show="mode === 'changes'"
        class="detail-changes-placeholder"
      >
        变更预览敬请期待 (暂无数据源)
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.detail-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.detail-panel-header {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.detail-mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-color-1, inherit);
  background: transparent;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  cursor: pointer;

  &:hover {
    background: var(--hover-color, rgba(127, 127, 127, 0.12));
  }
}

.detail-mode-caret {
  font-size: 10px;
  opacity: 0.7;
}

.detail-panel-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail-panel-body > * {
  flex: 1;
  min-height: 0;
}

.detail-overview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  overflow-y: auto;
}

.detail-artifact-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  color: var(--text-color-1, inherit);
  background: var(--card-color, rgba(127, 127, 127, 0.06));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  cursor: pointer;

  &:hover {
    background: var(--hover-color, rgba(127, 127, 127, 0.14));
  }
}

.detail-artifact-icon {
  flex-shrink: 0;
  opacity: 0.75;
}

.detail-artifact-name {
  overflow: hidden;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.detail-empty,
.detail-changes-placeholder {
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
