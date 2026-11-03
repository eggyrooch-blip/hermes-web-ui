<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchExpertWorkRecord,
  type ExpertWorkRecord,
  type MaintainerWorkRecord,
  type UserWorkRecord,
} from '@/api/hermes/experts'

const props = defineProps<{ expertId: string }>()
const { t } = useI18n()
const loading = ref(false)
const failed = ref(false)
const record = ref<ExpertWorkRecord | null>(null)
let loadEpoch = 0

watch(() => props.expertId, async (expertId) => {
  const epoch = ++loadEpoch
  loading.value = true
  failed.value = false
  record.value = null
  const [user, maintainer] = await Promise.allSettled([
    fetchExpertWorkRecord(expertId),
    fetchExpertWorkRecord(expertId, 'maintainer'),
  ])
  if (epoch !== loadEpoch) return
  record.value = maintainer.status === 'fulfilled'
    ? maintainer.value
    : user.status === 'fulfilled' ? user.value : null
  failed.value = record.value === null
  loading.value = false
}, { immediate: true })

function asUser(value: ExpertWorkRecord): UserWorkRecord {
  return value as UserWorkRecord
}

function asMaintainer(value: ExpertWorkRecord): MaintainerWorkRecord {
  return value as MaintainerWorkRecord
}
</script>

<template>
  <section class="work-record" data-work-record>
    <h3 class="work-title">
      {{ record?.mode === 'maintainer' ? t('expert.workRecord.maintainerTitle') : t('expert.workRecord.title') }}
    </h3>
    <p v-if="loading" class="work-state">{{ t('expert.workRecord.loading') }}</p>
    <p v-else-if="failed || !record" class="work-state">{{ t('expert.workRecord.error') }}</p>

    <div v-else-if="record.mode === 'user'" class="work-grid">
      <section class="work-card" data-work-sessions>
        <h4>{{ t('expert.workRecord.sessions') }}</h4>
        <p v-if="asUser(record).partitions.sessions.status === 'unavailable'" class="work-state">{{ t('expert.workRecord.unavailable') }}</p>
        <p v-else-if="!asUser(record).partitions.sessions.items.length" class="work-state" data-empty>{{ t('expert.workRecord.empty') }}</p>
        <ul v-else>
          <li v-for="item in asUser(record).partitions.sessions.items" :key="item.id">
            <span>{{ item.title || t('expert.workRecord.untitled') }}</span>
            <small>{{ t(`expert.workRecord.${item.status}`) }}</small>
          </li>
        </ul>
      </section>

      <section class="work-card" data-work-jobs>
        <h4>{{ t('expert.workRecord.jobs') }}</h4>
        <p v-if="asUser(record).partitions.jobs.status === 'unavailable'" class="work-state">{{ t('expert.workRecord.unavailable') }}</p>
        <p v-else-if="!asUser(record).partitions.jobs.items.length" class="work-state" data-empty>{{ t('expert.workRecord.empty') }}</p>
        <ul v-else>
          <li v-for="item in asUser(record).partitions.jobs.items" :key="item.id">
            <span>{{ item.name }}</span><small>{{ item.status || item.schedule }}</small>
          </li>
        </ul>
      </section>

      <section class="work-card" data-work-feedback>
        <h4>{{ t('expert.workRecord.feedback') }}</h4>
        <p v-if="asUser(record).partitions.feedback.status === 'unavailable'" class="work-state">{{ t('expert.workRecord.unavailable') }}</p>
        <p v-else-if="!asUser(record).partitions.feedback.items.length" class="work-state" data-empty>{{ t('expert.workRecord.empty') }}</p>
        <ul v-else>
          <li v-for="item in asUser(record).partitions.feedback.items" :key="`${item.session_id}:${item.run_id}`">
            <span>{{ t(item.rating === 'up' ? 'expert.workRecord.positive' : 'expert.workRecord.negative') }}</span>
            <small v-if="item.reason">{{ item.reason }}</small>
          </li>
        </ul>
      </section>
    </div>

    <div v-else class="work-grid maintainer-grid">
      <section class="work-card" data-work-sessions>
        <h4>{{ t('expert.workRecord.sessions') }}</h4>
        <p v-if="asMaintainer(record).partitions.sessions.status === 'unavailable'" class="work-state">{{ t('expert.workRecord.unavailable') }}</p>
        <template v-else>
          <strong>{{ t('expert.workRecord.sessionCount', { count: asMaintainer(record).partitions.sessions.count || 0 }) }}</strong>
          <small>{{ t('expert.workRecord.sessionStatus', { active: asMaintainer(record).partitions.sessions.active || 0, completed: asMaintainer(record).partitions.sessions.completed || 0 }) }}</small>
        </template>
      </section>
      <section class="work-card" data-work-jobs>
        <h4>{{ t('expert.workRecord.jobs') }}</h4>
        <p v-if="asMaintainer(record).partitions.jobs.status === 'unavailable'" class="work-state">{{ t('expert.workRecord.unavailable') }}</p>
        <strong v-else>{{ t('expert.workRecord.jobCount', { count: asMaintainer(record).partitions.jobs.count || 0 }) }}</strong>
      </section>
      <section class="work-card" data-work-feedback>
        <h4>{{ t('expert.workRecord.feedback') }}</h4>
        <p v-if="asMaintainer(record).partitions.feedback.status === 'unavailable'" class="work-state">{{ t('expert.workRecord.unavailable') }}</p>
        <template v-else>
          <strong>{{ t('expert.workRecord.feedbackCount', { count: asMaintainer(record).partitions.feedback.count || 0 }) }}</strong>
          <small>{{ t('expert.workRecord.positiveRate', { rate: Math.round((asMaintainer(record).partitions.feedback.positive_rate || 0) * 100) }) }}</small>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.work-record {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.work-title,
.work-card h4 {
  margin: 0;
  color: $text-primary;
}

.work-title { font-size: 13px; }
.work-card h4 { font-size: 12px; }

.work-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.work-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: $bg-card;
}

.work-card ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.work-card li,
.work-card template {
  min-width: 0;
}

.work-card span,
.work-card strong,
.work-card small {
  display: block;
  overflow-wrap: anywhere;
}

.work-card span,
.work-card strong { font-size: 12px; color: $text-primary; }
.work-card small { margin-top: 2px; font-size: 11px; color: $text-muted; }
.work-state { margin: 8px 0 0; font-size: 12px; color: $text-muted; }

@media (max-width: 480px) {
  .work-grid { grid-template-columns: 1fr; }
}
</style>
