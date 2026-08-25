<script setup lang="ts">
import type { SourceRef } from '@/api/hermes/chat'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const props = defineProps<{ refs: SourceRef[], sessionId: string }>()
const { t } = useI18n()

async function open(ref: SourceRef) {
  if (ref.type === 'workspace' && ref.open_path) {
    await useFilesStore().previewByDisplayPath(ref.open_path, ref.open_path.split('/').pop())
    return
  }
  const target = ref.type === 'web' ? ref.uri : ref.open_path
  if (!target) return
  const url = ref.type === 'lark_doc'
    ? `${target}?session_id=${encodeURIComponent(props.sessionId)}`
    : target
  window.open(url, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <section v-if="refs.length" class="source-refs" :aria-label="t('chat.sources.title')">
    <span class="source-title">{{ t('chat.sources.title') }}</span>
    <div class="source-list">
      <button v-for="ref in refs" :key="ref.id" type="button" class="source-chip" @click="open(ref)">
        <span aria-hidden="true">{{ ref.type === 'web' ? '↗' : ref.type === 'workspace' ? '▧' : '◫' }}</span>
        <span>{{ ref.label }}</span>
        <small>{{ t(`chat.sources.${ref.type}`) }}</small>
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.source-refs { margin-top: 8px; }
.source-title { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 600; color: var(--text-color-3); }
.source-list { display: flex; flex-wrap: wrap; gap: 6px; }
.source-chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 5px 8px;
  border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-color);
  color: var(--text-color-2); cursor: pointer; text-align: left;
}
.source-chip span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-chip small { color: var(--text-color-3); }
.source-chip:hover { border-color: var(--primary-color); color: var(--primary-color); }
@media (max-width: 390px) { .source-chip { width: 100%; } }
</style>
