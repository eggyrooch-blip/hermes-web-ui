<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExpertInfo } from '@/api/hermes/experts'

const { t } = useI18n()
const props = defineProps<{
  expert: ExpertInfo
  /** Whether this expert is the currently-active overlay in the composer. */
  active?: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'activate', expert: ExpertInfo): void
  (e: 'deactivate'): void
}>()

const displayTitle = computed(() => props.expert.title || props.expert.name)
const avatarBroken = ref(false)
const hasAvatar = computed(() => !!props.expert.avatar && !avatarBroken.value)
const initial = computed(() => {
  const src = (props.expert.name || props.expert.title || props.expert.id || '?').trim()
  return src ? Array.from(src)[0] : '?'
})
const skills = computed(() => props.expert.skills ?? [])
const approvalRequired = computed(() => props.expert.governance?.approval_required ?? [])
const envDefault = computed(() => props.expert.governance?.env_default || '')

watch(() => props.expert.id, () => {
  avatarBroken.value = false
})
</script>

<template>
  <aside class="expert-detail-panel" role="dialog" :aria-label="displayTitle">
    <header class="detail-header">
      <div class="detail-avatar" :class="{ 'has-image': hasAvatar }">
        <img v-if="hasAvatar" :src="expert.avatar" :alt="displayTitle" @error="avatarBroken = true" />
        <span v-else class="avatar-initial">{{ initial }}</span>
      </div>
      <div class="detail-headings">
        <h2 class="detail-title">{{ displayTitle }}</h2>
        <div class="detail-meta">
          <span v-if="expert.category" class="detail-category">{{ expert.category }}</span>
          <span v-if="active" class="detail-active">{{ t('expert.catalog.activeBadge') }}</span>
        </div>
        <p v-if="expert.tagline" class="detail-tagline">{{ expert.tagline }}</p>
      </div>
      <button class="detail-close" type="button" :aria-label="t('expert.detail.close')" @click="emit('close')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>

    <div v-if="expert.display_tags?.length" class="detail-tags">
      <span v-for="tag in expert.display_tags" :key="tag" class="detail-tag">{{ tag }}</span>
    </div>

    <section class="detail-section">
      <h3 class="section-title">{{ t('expert.detail.capabilities') }}</h3>
      <ul v-if="skills.length" class="capability-list">
        <li v-for="skill in skills" :key="skill" class="capability-item">{{ skill }}</li>
      </ul>
      <p v-else class="section-empty">{{ t('expert.detail.noCapabilities') }}</p>
    </section>

    <section class="detail-section">
      <h3 class="section-title">{{ t('expert.detail.governance') }}</h3>
      <p class="governance-note">{{ t('expert.detail.governanceNote') }}</p>
      <p v-if="envDefault" class="governance-line">
        {{ t('expert.detail.envDefault') }}: <code>{{ envDefault }}</code>
      </p>
      <div v-if="approvalRequired.length" class="governance-approval">
        <p class="governance-line">{{ t('expert.detail.approvalRequired') }}:</p>
        <ul class="approval-list">
          <li v-for="op in approvalRequired" :key="op"><code>{{ op }}</code></li>
        </ul>
      </div>
    </section>

    <footer class="detail-actions">
      <button
        v-if="!active"
        class="action-primary"
        type="button"
        @click="emit('activate', expert)"
      >
        {{ t('expert.detail.activate') }}
      </button>
      <button
        v-else
        class="action-secondary"
        type="button"
        @click="emit('deactivate')"
      >
        {{ t('expert.detail.deactivate') }}
      </button>
    </footer>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.expert-detail-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: $bg-primary;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid $border-color;
}

.detail-avatar {
  flex: 0 0 auto;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-card;
  color: $text-primary;
  border: 1px solid $border-color;
  font-size: 24px;
  font-weight: 600;
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.detail-headings {
  flex: 1 1 auto;
  min-width: 0;
}

.detail-title {
  margin: 0;
  font-size: 20px;
  line-height: 26px;
  color: $text-primary;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.detail-tagline {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: $text-secondary;
}

.detail-category,
.detail-active {
  line-height: 18px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
}

.detail-category {
  border: 1px solid $border-color;
  color: $text-secondary;
}

.detail-active {
  background: $accent-primary;
  color: var(--text-on-accent);
}

.detail-close {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;

  &:hover {
    color: $text-primary;
    background: $bg-card;
  }
}

.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.detail-tag {
  font-size: 11px;
  line-height: 16px;
  padding: 2px 8px;
  border-radius: 999px;
  background: $bg-card;
  color: $text-secondary;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
}

.section-empty {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

.capability-list,
.approval-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.capability-item {
  font-size: 12px;
  color: $text-secondary;
}

.governance-note {
  margin: 0;
  font-size: 12px;
  color: $text-secondary;
}

.governance-line {
  margin: 0;
  font-size: 12px;
  color: $text-secondary;

  code {
    font-size: 11px;
    background: $bg-card;
    padding: 1px 5px;
    border-radius: 4px;
  }
}

.approval-list code {
  font-size: 11px;
  background: $bg-card;
  padding: 1px 5px;
  border-radius: 4px;
}

.detail-actions {
  margin-top: auto;
  display: flex;
  gap: 8px;
}

.action-primary,
.action-secondary {
  flex: 1 1 auto;
  height: 36px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid $border-color;
  transition:
    background-color $transition-fast,
    color $transition-fast;
}

.action-primary {
  border-color: transparent;
  background: $accent-primary;
  color: #fff;

  &:hover {
    opacity: 0.9;
  }
}

.action-secondary {
  background: transparent;
  color: $text-secondary;

  &:hover {
    color: $text-primary;
    background: $bg-card;
  }
}
</style>
