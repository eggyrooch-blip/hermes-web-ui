<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty, NInput, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  archiveCoworkProject,
  getCoworkProject,
  listCoworkProjectSessions,
  listCoworkProjects,
  updateCoworkProject,
  type CoworkProject,
  type CoworkProjectSession,
} from '@/api/hermes/cowork'
import { fetchHermesSession, type SessionDetail } from '@/api/hermes/sessions'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { collectSessionArtifacts } from '@/utils/hermes/session-artifacts'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()
const loading = ref(false)
const saving = ref(false)
const projects = ref<CoworkProject[]>([])
const project = ref<CoworkProject | null>(null)
const search = ref('')
const name = ref('')
const description = ref('')
const instructions = ref('')
const primaryFolder = ref('')
const projectTasks = ref<Array<CoworkProjectSession & { session: SessionDetail | null }>>([])
const startingTask = ref(false)
let loadSequence = 0
const SESSION_DETAILS_LIMIT = 50
const SESSION_DETAILS_CONCURRENCY = 4

const projectId = computed(() => typeof route.params.projectId === 'string' ? route.params.projectId : '')
const visibleProjects = computed(() => projects.value.filter(item => (
  !search.value.trim() || `${item.name} ${item.description}`.toLowerCase().includes(search.value.trim().toLowerCase())
)))
const projectArtifacts = computed(() => {
  const seen = new Set<string>()
  return projectTasks.value.flatMap(task => collectSessionArtifacts(task.session?.messages || []).flatMap(artifact => {
    if (seen.has(artifact.path)) return []
    seen.add(artifact.path)
    return [{ ...artifact, sessionId: task.session_id, taskTitle: task.session?.title || task.session_id }]
  }))
})

async function loadProjects() {
  projects.value = await listCoworkProjects()
  if (!projectId.value && projects.value[0]) {
    await router.replace({ name: 'hermes.coworkProject', params: { projectId: projects.value[0].id }, query: { profile: route.query.profile } })
  }
}

async function loadProject(id: string) {
  const request = ++loadSequence
  if (!id) { project.value = null; projectTasks.value = []; return }
  loading.value = true
  try {
    const [detail, taskBindings] = await Promise.all([
      getCoworkProject(id),
      listCoworkProjectSessions(id),
    ])
    if (request !== loadSequence) return
    project.value = detail
    projectTasks.value = taskBindings.map(task => ({ ...task, session: null }))
    name.value = detail.name
    description.value = detail.description
    instructions.value = detail.instructions
    primaryFolder.value = detail.primary_folder || ''
    void (async () => {
      const hydrated = taskBindings.map(task => ({ ...task, session: null as SessionDetail | null }))
      const limited = taskBindings.slice(0, SESSION_DETAILS_LIMIT)
      for (let index = 0; index < limited.length; index += SESSION_DETAILS_CONCURRENCY) {
        const batch = await Promise.all(limited.slice(index, index + SESSION_DETAILS_CONCURRENCY).map(async task => {
          try {
            return { ...task, session: await fetchHermesSession(task.session_id, profilesStore.activeProfileName) }
          } catch {
            return { ...task, session: null }
          }
        }))
        if (request !== loadSequence) return
        hydrated.splice(index, batch.length, ...batch)
        projectTasks.value = [...hydrated]
      }
    })()
  } catch {
    if (request !== loadSequence) return
    project.value = null
    projectTasks.value = []
    message.error(t('cowork.loadFailed'))
  } finally {
    if (request === loadSequence) loading.value = false
  }
}

async function saveProject() {
  if (!project.value) return
  saving.value = true
  try {
    project.value = await updateCoworkProject(project.value.id, {
      name: name.value,
      description: description.value,
      instructions: instructions.value,
      primary_folder: primaryFolder.value || null,
    })
    await loadProjects()
    message.success(t('common.saved'))
  } catch {
    message.error(t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function archiveProject() {
  if (!project.value) return
  try {
    await archiveCoworkProject(project.value.id)
    project.value = null
    await router.replace({ name: 'hermes.coworkProject', query: { profile: route.query.profile } })
    await loadProjects()
  } catch {
    message.error(t('common.saveFailed'))
  }
}

async function startTask() {
  if (!project.value || startingTask.value) return
  startingTask.value = true
  try {
    const session = chatStore.newChat({
      profile: profilesStore.activeProfileName || 'default',
      source: 'cli',
      agent: 'hermes',
    })
    chatStore.setSessionProject(session.id, project.value)
    await router.push({
      name: 'hermes.session',
      params: { sessionId: session.id },
      query: { profile: session.profile },
    })
  } finally {
    startingTask.value = false
  }
}

function openTask(sessionId: string) {
  void router.push({
    name: 'hermes.session',
    params: { sessionId },
    query: { profile: profilesStore.activeProfileName || 'default' },
  })
}

function formatCreatedAt(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value < 1_000_000_000_000 ? value * 1000 : value))
}

onMounted(async () => {
  try { await loadProjects() } catch { message.error(t('cowork.loadFailed')) }
})
watch(projectId, id => void loadProject(id), { immediate: true })
</script>

<template>
  <div class="projects-view">
    <aside class="project-list">
      <div class="project-list__header">
        <h2>{{ t('cowork.projects') }}</h2>
        <NInput v-model:value="search" size="small" clearable :placeholder="t('cowork.searchProjects')" />
      </div>
      <button
        v-for="item in visibleProjects"
        :key="item.id"
        type="button"
        class="project-row"
        :class="{ active: item.id === projectId }"
        @click="router.push({ name: 'hermes.coworkProject', params: { projectId: item.id }, query: { profile: route.query.profile } })"
      >
        <span class="project-row__icon" :style="{ background: item.color || '#5b67f1' }">{{ item.icon || 'P' }}</span>
        <span><strong>{{ item.name }}</strong><small>{{ item.primary_folder || t('cowork.noFolder') }}</small></span>
      </button>
      <NEmpty v-if="!visibleProjects.length" size="small" :description="t('cowork.noProjects')" />
    </aside>

    <main class="project-detail">
      <NSpin :show="loading">
        <template v-if="project">
          <header class="project-detail__header">
            <div><span class="eyebrow">{{ t('cowork.project') }}</span><h1>{{ project.name }}</h1></div>
            <div class="header-actions">
              <NButton :loading="startingTask" :disabled="startingTask" @click="startTask">{{ t('cowork.newTask') }}</NButton>
              <NButton type="primary" :loading="saving" @click="saveProject">{{ t('common.save') }}</NButton>
            </div>
          </header>
          <div class="project-fields">
            <label><span>{{ t('cowork.projectName') }}</span><NInput v-model:value="name" :maxlength="80" /></label>
            <label><span>{{ t('cowork.folder') }}</span><NInput v-model:value="primaryFolder" :maxlength="512" :placeholder="t('cowork.folderPlaceholder')" /></label>
            <label><span>{{ t('cowork.description') }}</span><NInput v-model:value="description" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" /></label>
            <label><span>{{ t('cowork.instructions') }}</span><NInput v-model:value="instructions" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" /></label>
          </div>
          <div class="project-sections">
            <section class="project-section">
              <h2>{{ t('cowork.sources') }}</h2>
              <div v-if="project.primary_folder" class="project-source">📁 <span>{{ project.primary_folder }}</span></div>
              <NEmpty v-else size="small" :description="t('cowork.noSources')" />
            </section>
            <section class="project-section">
              <h2>{{ t('cowork.tasks') }}</h2>
              <div v-if="projectTasks.length" class="project-stack">
                <button v-for="task in projectTasks" :key="task.session_id" type="button" class="project-card project-task" @click="openTask(task.session_id)">
                  <strong>{{ task.session?.title || task.session_id }}</strong>
                  <small>{{ formatCreatedAt(task.created_at) }}</small>
                </button>
              </div>
              <NEmpty v-else size="small" :description="t('cowork.noTasks')" />
            </section>
            <section class="project-section">
              <h2>{{ t('cowork.sourceType.artifact') }}</h2>
              <div v-if="projectArtifacts.length" class="project-stack">
                <button v-for="artifact in projectArtifacts" :key="artifact.path" type="button" class="project-card project-artifact" @click="openTask(artifact.sessionId)">
                  <strong>{{ artifact.name }}</strong>
                  <small>{{ artifact.taskTitle }}</small>
                </button>
              </div>
              <NEmpty v-else size="small" :description="t('cowork.noArtifacts')" />
            </section>
          </div>
          <NButton type="error" secondary @click="archiveProject">{{ t('cowork.archiveProject') }}</NButton>
        </template>
        <NEmpty v-else :description="t('cowork.noProjects')" />
      </NSpin>
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.projects-view { height: 100%; display: grid; grid-template-columns: 280px minmax(0, 1fr); background: $bg-primary; color: $text-primary; }
.project-list { border-right: 1px solid $border-color; padding: 20px 12px; overflow: auto; }
.project-list__header { display: grid; gap: 12px; padding: 0 8px 14px; }
.project-list__header h2, .project-detail h1 { margin: 0; }
.project-row { width: 100%; display: flex; gap: 10px; align-items: center; border: 0; border-radius: 10px; padding: 10px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.project-row:hover, .project-row.active { background: $bg-card; }
.project-row__icon { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; color: white; flex: 0 0 auto; }
.project-row span:last-child { min-width: 0; display: grid; gap: 2px; }
.project-row small { color: $text-muted; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-detail { min-width: 0; overflow: auto; padding: 32px clamp(20px, 5vw, 72px); }
.project-detail__header, .header-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.project-detail__header { margin-bottom: 24px; }
.eyebrow { color: $text-muted; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.project-fields { display: grid; gap: 18px; margin-bottom: 24px; }
.project-fields label { display: grid; gap: 8px; font-weight: 600; }
.project-sections { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
.project-section { min-width: 0; padding: 16px; border: 1px solid $border-color; border-radius: 12px; background: $bg-card; }
.project-section h2 { margin: 0 0 12px; font-size: 15px; }
.project-stack { display: grid; gap: 8px; }
.project-card { display: grid; gap: 3px; width: 100%; padding: 9px 10px; border: 0; border-radius: 8px; background: $bg-secondary; color: inherit; text-align: left; cursor: pointer; }
.project-card:hover { color: $accent-primary; }
.project-card strong, .project-card small, .project-source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-card small { color: $text-muted; }
.project-source { display: flex; min-width: 0; gap: 6px; color: $text-secondary; }
@media (max-width: 760px) {
  .projects-view { grid-template-columns: 1fr; overflow: auto; }
  .project-list { border-right: 0; border-bottom: 1px solid $border-color; max-height: 240px; }
  .project-detail { overflow: visible; padding: 20px 14px; }
  .project-detail__header { align-items: flex-start; }
  .project-sections { grid-template-columns: 1fr; }
}
</style>
