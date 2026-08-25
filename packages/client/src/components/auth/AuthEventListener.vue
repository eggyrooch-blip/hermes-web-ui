<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { setSignedOutReason } from '@/composables/useSignedOutReason'

const { t } = useI18n()

let lastNoticeAt = 0

function onAuthNotice(event: Event) {
  const detail = (event as CustomEvent<{ kind?: string }>).detail || {}
  const now = Date.now()
  if (now - lastNoticeAt < 1200) return
  lastNoticeAt = now

  // This component has no surface of its own, and the app is about to redirect
  // to the login page. A toast raised here is destroyed by that navigation — or
  // worse, survives just long enough to be missed. So the reason is parked and
  // the login page states it, which is also where the user can act on it.
  setSignedOutReason(
    detail.kind === 'forbidden' ? t('login.accessDenied') : t('login.sessionExpired'),
  )
}

onMounted(() => {
  window.addEventListener('hermes-auth-notice', onAuthNotice)
})

onUnmounted(() => {
  window.removeEventListener('hermes-auth-notice', onAuthNotice)
})
</script>

<template>
  <span style="display: none" aria-hidden="true" />
</template>
