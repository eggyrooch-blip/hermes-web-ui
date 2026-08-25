<script setup lang="ts">
/**
 * 我的任务 — prototype anatomy: task rows (name + when + state tag) that
 * open the run, a 28px breather, then 我创建的自动化 rows that open the
 * automation page. States map: running session → 进行中, ended → 已完成;
 * job.enabled → 已启用 / 已暂停.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin } from 'naive-ui'
import { useRouter } from 'vue-router'
import { fetchSessions, type SessionSummary } from '@/api/hermes/sessions'
import { useJobsStore } from '@/stores/hermes/jobs'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'

const { t } = useI18n()
const router = useRouter()
const jobsStore = useJobsStore()

const loadingSessions = ref(false)
const sessions = ref<SessionSummary[]>([])

onMounted(async () => {
  loadingSessions.value = true
  try {
    sessions.value = (await fetchSessions(undefined, 10)).filter(s => !s.is_archived)
  } catch {
    sessions.value = []
  } finally {
    loadingSessions.value = false
  }
  void jobsStore.fetchJobs()
})

function sessionWhen(s: SessionSummary): string {
  const ts = s.last_active ?? s.started_at
  if (!ts) return ''
  const d = new Date(ts * (ts > 1e12 ? 1 : 1000))
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

function sessionState(s: SessionSummary): string {
  return s.ended_at == null ? t('settings.myTasks.stateRunning') : t('settings.myTasks.stateDone')
}

function openSession(s: SessionSummary) {
  void router.push({ name: 'hermes.session', params: { sessionId: s.id } })
}

function openJobs() {
  void router.push({ name: 'hermes.jobs' })
}

const jobs = computed(() => jobsStore.jobs)

function jobState(enabled: boolean): string {
  return enabled ? t('settings.myTasks.enabled') : t('settings.myTasks.paused')
}
</script>

<template>
  <section class="my-tasks-settings">
    <KpSectionTitle>{{ t('settings.tabs.tasks') }}</KpSectionTitle>
    <NSpin :show="loadingSessions">
      <KpEmptyState v-if="sessions.length === 0 && !loadingSessions" :title="t('settings.myTasks.empty')" />
      <div v-else class="task-rows">
        <div v-for="s in sessions" :key="s.id" class="task-row catrow" @click="openSession(s)">
          <div class="task-row__body">
            <div class="task-row__name">{{ s.title || s.preview || s.id }}</div>
            <div class="task-row__meta">{{ sessionWhen(s) }}</div>
          </div>
          <span class="task-row__tag">{{ sessionState(s) }}</span>
        </div>
      </div>
    </NSpin>

    <div class="task-spacer" />

    <KpSectionTitle>{{ t('settings.myTasks.automationTitle') }}</KpSectionTitle>
    <KpEmptyState v-if="jobs.length === 0" :title="t('settings.myTasks.automationEmpty')" />
    <div v-else class="task-rows">
      <div v-for="job in jobs" :key="job.id" class="task-row catrow" @click="openJobs">
        <div class="task-row__body">
          <div class="task-row__name">{{ job.name }}</div>
          <div class="task-row__meta">{{ job.schedule_display }}</div>
        </div>
        <span class="task-row__tag">{{ jobState(job.enabled) }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.task-rows {
  display: flex;
  flex-direction: column;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  margin: 0 -12px;
  border-radius: var(--r-ctl);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);
}

.task-row__body {
  flex: 1;
  min-width: 0;
}

.task-row__name {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-row__meta {
  margin-top: 2px;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
}

.task-row__tag {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--gray-f2);
  font: var(--w-medium) var(--t-12) / 22px var(--font-cn);
  color: var(--fg-secondary);
}

// Prototype puts a fixed 28px breather between the two lists.
.task-spacer {
  height: 28px;
}
</style>
