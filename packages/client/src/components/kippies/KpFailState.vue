<script setup lang="ts">
/**
 * Full-page "couldn't load this" state.
 *
 * This used to be a red circle with a white exclamation mark, which treats
 * "didn't load" as "danger". Red has exactly one job in this system: something
 * needs your confirmation, or something is destructive. A service being
 * unreachable needs neither — the only thing you can do is press again — so
 * **there is no red on this page at all.**
 *
 * The illustration is the mascot, slowly shaking its head, blinking, with its
 * spark turning. It is already the product's character, and on an empty page it
 * reads as "this page is blank right now" far better than a warning badge would.
 * `mode="halt"` is what makes it shake; the spark spins continuously because this
 * is the only moving thing on the page — that is the "still trying" signal, and
 * all of the feedback stays on this page with nothing popping up elsewhere.
 *
 * Spacing: 8 between title and body, not 6 — §6.2's spacing base is 4 and 6 is
 * not on the ladder. Title and body sit together at 8 because they are one
 * thing; the gap only opens to 20 at the button.
 */
import KpBtn from './KpBtn.vue'
import KpMascotFace from './KpMascotFace.vue'
import { useAction } from './useAction'

const props = defineProps<{
  title: string
  body?: string
  retryLabel: string
  /** Shown if the retry itself fails. */
  retryFailLabel?: string
  onRetry?: () => Promise<unknown>
}>()

const [state, run] = useAction()

function handleRetry() {
  run({
    // Success means this page is gone and the content takes its place — that IS
    // the receipt, so there is no `ok` state to sit in.
    noOk: true,
    run: () => props.onRetry?.() ?? Promise.resolve(),
  })
}
</script>

<template>
  <div class="kp-fail">
    <div class="kp-fail__art">
      <KpMascotFace :size="94" mode="halt" />
    </div>
    <div class="t-h5 kp-fail__title">{{ title }}</div>
    <div v-if="body" class="t-sub-multi kp-fail__body">{{ body }}</div>
    <div class="kp-fail__action">
      <!--
        `line`, not `dark`: reloading is "try that again", not this page's
        primary action.
      -->
      <KpBtn
        kind="line"
        size="m"
        icon="line_reload"
        :state="state"
        :fail-label="retryFailLabel"
        @click="handleRetry"
      >
        {{ retryLabel }}
      </KpBtn>
    </div>
  </div>
</template>

<style scoped lang="scss">
.kp-fail {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 72px 24px;
  text-align: center;
}

// No opacity fade here — the mascot is the illustration, not filler, and dimming
// it would mute the spark that carries "still trying". (The paper sheet this
// replaced was faded at 0.5 because it *was* filler.)
.kp-fail__art {
  margin-bottom: 8px;
}

.kp-fail__title {
  color: var(--fg-primary);
  margin-top: 8px;
}

.kp-fail__body {
  max-width: 340px;
  margin-top: 8px;
}

.kp-fail__action {
  margin-top: 20px;
}
</style>
