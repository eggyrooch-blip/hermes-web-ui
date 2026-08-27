<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFeedbackStore } from '@/stores/hermes/feedback'
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
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v10H3V10h4Zm4 10H8V9l4-7 2 1v5h5a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2h-6Z" /></svg>
      </button>
      <button
        type="button"
        data-feedback-rating="down"
        :aria-label="t('chat.feedback.notHelpful')"
        :aria-pressed="feedback?.rating === 'down'"
        :disabled="saving"
        @click="choose('down')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v10H3V4h4Zm4 0h6a2 2 0 0 1 2 2l2 8a2 2 0 0 1-2 2h-5v5l-2 1-4-7V4h3Z" /></svg>
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
.feedback-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  color: var(--text-color-3);
}

.feedback-buttons,
.feedback-reasons,
.feedback-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

button {
  min-height: 28px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.feedback-buttons button {
  display: inline-grid;
  width: 30px;
  place-items: center;
  padding: 4px;
}

.feedback-buttons svg {
  width: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

button:hover,
button[aria-pressed="true"] {
  border-color: rgba(var(--accent-primary-rgb), 0.35);
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: var(--accent-primary);
}

button:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.feedback-reasons button,
.feedback-retry {
  padding: 3px 8px;
  border-color: var(--border-color);
  font-size: 12px;
}

.feedback-error {
  color: var(--error-color, #d03050);
  font-size: 12px;
}

@media (max-width: 480px) {
  .feedback-control,
  .feedback-reasons {
    max-width: 100%;
  }
}
</style>
