<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'

const props = defineProps<{
  sessionId: string
  expertId: string
  expertLabel?: string
  initialName: string
  initialPrompt: string
  initialSkills: string[]
}>()

const { t } = useI18n()
const idempotencyKey = ref<string | null>(null)

async function open() {
  await nextTick()
  idempotencyKey.value = crypto.randomUUID()
}

function close() {
  idempotencyKey.value = null
}
</script>

<template>
  <NButton
    quaternary
    size="tiny"
    class="schedule-button"
    :title="props.expertLabel"
    :aria-label="t('chat.scheduleExecution')"
    @click="open"
  >
    {{ t('chat.scheduleExecution') }}
  </NButton>
  <JobFormModal
    v-if="idempotencyKey"
    :job-id="null"
    :initial-name="initialName"
    :initial-prompt="initialPrompt"
    :initial-skills="initialSkills"
    :source-session-id="sessionId"
    :expert-id="expertId"
    :idempotency-key="idempotencyKey"
    @close="close"
    @saved="close"
  />
</template>
