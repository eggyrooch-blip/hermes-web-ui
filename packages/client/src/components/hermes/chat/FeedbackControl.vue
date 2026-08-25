<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFeedbackStore } from '@/stores/hermes/feedback'
import KpIcon from '@/components/kippies/KpIcon.vue'
import type { FeedbackRating, FeedbackReason } from '@/api/hermes/feedback'

const props = defineProps<{ sessionId: string; runId: string }>()
const { t } = useI18n()
const store = useFeedbackStore()
const choosingReason = ref(false)
const retryAction = ref<null | { rating: FeedbackRating; reason: FeedbackReason | null } | 'remove'>(null)
const feedback = computed(() => store.get(props.sessionId, props.runId))
const saving = computed(() => store.isSaving(props.sessionId, props.runId))
const error = computed(() => store.errorFor(props.sessionId, props.runId))
const reasons: FeedbackReason[] = ['inaccurate', 'unresolved', 'unclear_source', 'slow', 'other']

async function save(rating: FeedbackRating, reason: FeedbackReason | null) {
  retryAction.value = { rating, reason }
  try {
    await store.set(props.sessionId, props.runId, rating, reason)
    choosingReason.value = false
    retryAction.value = null
  } catch {
    // The store keeps the prior state and exposes the retryable error.
  }
}

async function remove() {
  retryAction.value = 'remove'
  try {
    await store.remove(props.sessionId, props.runId)
    choosingReason.value = false
    retryAction.value = null
  } catch {
    // The store keeps the prior state and exposes the retryable error.
  }
}

function choose(rating: FeedbackRating) {
  if (saving.value) return
  if (feedback.value?.rating === rating) {
    void remove()
  } else if (rating === 'up') {
    void save('up', null)
  } else {
    choosingReason.value = true
  }
}

function retry() {
  if (retryAction.value === 'remove') void remove()
  else if (retryAction.value) void save(retryAction.value.rating, retryAction.value.reason)
}
</script>

<template>
  <div class="feedback-control">
    <div class="feedback-buttons">
      <button
        type="button"
        data-feedback-rating="up"
        :aria-label="t('chat.feedback.helpful')"
        :aria-pressed="feedback?.rating === 'up'"
        :disabled="saving"
        @click="choose('up')"
      >
        <KpIcon name="line_praise" :size="16" />
      </button>
      <button
        type="button"
        data-feedback-rating="down"
        :aria-label="t('chat.feedback.notHelpful')"
        :aria-pressed="feedback?.rating === 'down'"
        :disabled="saving"
        @click="choose('down')"
      >
        <KpIcon name="line_praise" :size="16" class="is-flip" />
      </button>
    </div>
    <div v-if="choosingReason" class="feedback-reasons" :aria-label="t('chat.feedback.reasons')">
      <button
        v-for="reason in reasons"
        :key="reason"
        type="button"
        :data-feedback-reason="reason"
        :disabled="saving"
        @click="save('down', reason)"
      >
        {{ t(`chat.feedback.${reason === 'unclear_source' ? 'unclearSource' : reason}`) }}
      </button>
    </div>
    <div v-if="error" class="feedback-error" role="alert">
      <span>{{ t('chat.feedback.saveFailed') }}</span>
      <button type="button" class="feedback-retry" :disabled="saving" @click="retry">
        {{ t('chat.feedback.retry') }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* Renders INSIDE MessageItem's .message-meta action row, so the two rating
   buttons must be indistinguishable from the row's other KpIcon buttons
   (28px circle, --fg-aux, no ground). The reason picker and the retry notice
   are the only parts that need room of their own — they float below the row
   instead of widening it, which would push 复制/分享 out of line. */
.feedback-control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
}

.feedback-buttons {
  display: flex;
  align-items: center;
  gap: 2px;
}

.feedback-buttons button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 9999px;
  background: transparent;
  color: var(--fg-aux);
  cursor: pointer;
  transition: opacity var(--motion-base) var(--ease-std);

  &:active {
    opacity: 0.6;
  }
}

.feedback-buttons .is-flip {
  transform: rotate(180deg);
}

/* The only state that reads back after a reload — keep it unmistakable. */
.feedback-buttons button[aria-pressed="true"] {
  color: var(--keep-green);
}

.feedback-buttons button:focus-visible {
  outline: 2px solid var(--keep-green);
  outline-offset: 2px;
}

.feedback-buttons button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.feedback-reasons,
.feedback-error {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  max-width: min(420px, 70vw);
  padding: 6px;
  border: 1px solid var(--divider);
  border-radius: var(--r-ctl);
  background: var(--bg-card);
  box-shadow: var(--shadow-toast);
}

.feedback-reasons button,
.feedback-retry {
  padding: 3px 8px;
  border: 1px solid var(--divider);
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-primary);
  cursor: pointer;
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);

  &:hover {
    border-color: var(--keep-green);
    color: var(--keep-green);
  }

  &:disabled {
    cursor: wait;
    opacity: 0.55;
  }
}

.feedback-error {
  color: var(--danger);
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
}
</style>
