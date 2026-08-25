<script setup lang="ts">
/**
 * Sidebar bottom: the offline row.
 *
 * Losing the network does NOT drop a banner. A banner is the cheap way to do it,
 * but it does not fit this interface's grammar — nothing here grows out of a
 * screen edge to notify you; every state lives on the control it belongs to. The
 * sidebar is the one thing always present, so it is the natural home for a global
 * state — **and it is not a popup.**
 *
 * ⚠️ When online, the whole row is ABSENT — not greyed out, not a placeholder.
 * Working network is the default state, and reserving a row for the default state
 * permanently costs a row.
 *
 * The trailing dot follows the rule the sidebar already uses for tasks:
 *   running        green  + pulse   "it is moving"
 *   needs you      red    no pulse  "it is parked, waiting for you"
 *   reconnecting   red    + pulse   ← you should know, and it is working on it
 * That last one is derived from the existing grammar, not a new invention.
 */
import { useI18n } from 'vue-i18n'
import KpIcon from './KpIcon.vue'
import { useNet } from '@/composables/useNet'
import { useLabelFade } from './useLabelFade'

const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const { t } = useI18n()
const { online, reason } = useNet()
const labelStyle = useLabelFade(() => props.collapsed)

// Two different failures, two different sentences: the browser has no network at
// all, versus the network is fine but our gateway is not answering. Saying
// "offline" for the second one sends people to check their WiFi for nothing.
const label = () =>
  reason.value === 'gateway' ? t('net.gatewayUnreachable') : t('net.offlineReconnecting')
</script>

<template>
  <div
    v-if="!online"
    class="row fadein kp-offline"
    :class="{ 'is-collapsed': collapsed }"
    :title="label()"
  >
    <span class="kp-offline__ico">
      <KpIcon name="line_wifi_level1" :size="18" color="var(--danger)" />
    </span>
    <span :style="labelStyle" class="kp-offline__label">{{ label() }}</span>
    <span v-if="!collapsed" class="pulse kp-offline__dot" />
  </div>
</template>

<style scoped lang="scss">
.kp-offline {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: 36px;
  margin: 0 0 2px;
  padding: 0 12px;
  border-radius: var(--r-ctl);
  overflow: hidden;

  &.is-collapsed {
    width: 32px;
    height: 32px;
    justify-content: center;
    gap: 0;
    margin: 0 auto 2px;
    padding: 0;
  }
}

.kp-offline__ico {
  width: 18px;
  flex: 0 0 18px;
  display: grid;
  place-items: center;
}

.kp-offline__label {
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
}

.kp-offline__dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: var(--r-pill);
  background: var(--danger);
}
</style>
