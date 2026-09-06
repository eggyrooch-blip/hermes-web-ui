<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NModal, NPopover, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { createCoworkProject, getCoworkProject, listCoworkProjects, type CoworkProject } from '@/api/hermes/cowork'

const props = withDefaults(defineProps<{
  modelValue: CoworkProject | null
  frozen?: boolean
}>(), { frozen: false })
const emit = defineEmits<{ 'update:modelValue': [CoworkProject | null] }>()
const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const projects = ref<CoworkProject[]>([])
const selectedDetail = ref<CoworkProject | null>(props.modelValue)
const loading = ref(false)
const loadError = ref(false)
const open = ref(false)
const showCreate = ref(false)
const creating = ref(false)
const name = ref('')
const search = ref('')
const projectButton = ref<InstanceType<typeof NButton> | null>(null)
const searchInput = ref<InstanceType<typeof NInput> | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let loadSequence = 0
let suppressSearchWatch = false

const visibleProjects = computed(() => projects.value
  .filter(project => project.status === 'active')
  .slice(0, search.value.trim() ? 50 : 5))
const selectedProject = computed(() => (
  selectedDetail.value?.id === props.modelValue?.id ? selectedDetail.value : props.modelValue
))

async function loadProjects(query = '') {
  const mine = ++loadSequence
  loading.value = true
  loadError.value = false
  try {
    const result = await listCoworkProjects(query.slice(0, 100))
    if (mine === loadSequence) projects.value = result
  } catch {
    if (mine === loadSequence) {
      loadError.value = true
      message.error(t('cowork.loadFailed'))
    }
  } finally {
    if (mine === loadSequence) loading.value = false
  }
}

watch(search, value => {
  if (suppressSearchWatch) return
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadProjects(value), 200)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

async function setOpen(value: boolean) {
  open.value = value
  if (value) {
    clearTimeout(searchTimer)
    suppressSearchWatch = true
    search.value = ''
    await nextTick()
    suppressSearchWatch = false
    await Promise.all([
      loadProjects(),
      props.modelValue
        ? getCoworkProject(props.modelValue.id).then(project => { selectedDetail.value = project }).catch(() => {})
        : Promise.resolve(),
    ])
    await nextTick()
    searchInput.value?.focus()
  } else {
    await nextTick()
    ;(projectButton.value?.$el as HTMLElement | undefined)?.focus()
  }
}

watch(() => props.frozen, frozen => {
  if (frozen) open.value = false
})
watch(() => props.modelValue, project => { selectedDetail.value = project })

async function chooseProject(project: CoworkProject | null) {
  emit('update:modelValue', project)
  await setOpen(false)
}

async function createProject() {
  const projectName = name.value.trim()
  if (!projectName || creating.value) return
  creating.value = true
  try {
    const project = await createCoworkProject({ name: projectName })
    projects.value.unshift(project)
    name.value = ''
    showCreate.value = false
    emit('update:modelValue', project)
  } catch {
    message.error(t('cowork.createFailed'))
  } finally {
    creating.value = false
  }
}

function createProjectFromKeyboard(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  void createProject()
}

function moveOptionFocus(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const menu = event.currentTarget as HTMLElement
  const options = [...menu.querySelectorAll<HTMLElement>('[role="option"]')]
  if (!options.length) return
  event.preventDefault()
  const current = options.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? options.length - 1
      : event.key === 'ArrowUp' ? Math.max(0, current < 0 ? options.length - 1 : current - 1)
        : Math.min(options.length - 1, current + 1)
  options[next]?.focus()
}

defineExpose({ chooseProject, setOpen, open, loadProjects, loadError, createProject, createProjectFromKeyboard, name })
</script>

<template>
  <div class="cowork-picker" data-cowork-project-picker :data-selected-project-id="modelValue?.id || ''">
    <NPopover :show="open" trigger="manual" placement="bottom-start" @clickoutside="setOpen(false)">
      <template #trigger>
        <NButton ref="projectButton" size="small" :aria-expanded="open" aria-haspopup="listbox" @click="setOpen(!open)">
          {{ modelValue ? `${t('cowork.project')} · ${modelValue.name}` : t('cowork.chooseProject') }}
        </NButton>
      </template>
      <div class="cowork-menu" @keydown.esc.stop="setOpen(false)" @keydown="moveOptionFocus">
        <div v-if="selectedProject" class="cowork-context">
          <div class="cowork-context__title">
            <span class="project-dot" :style="{ background: selectedProject.color || '#5b67f1' }">{{ selectedProject.icon || 'P' }}</span>
            <strong>{{ selectedProject.name }}</strong>
          </div>
          <p>{{ selectedProject.description || t('cowork.projectContextHint') }}</p>
          <div v-if="selectedProject.instructions" class="cowork-context__instructions">
            <span>{{ t('cowork.instructions') }}</span>
            <p>{{ selectedProject.instructions }}</p>
          </div>
          <NButton text size="small" @click="setOpen(false); router.push({ name: 'hermes.coworkProject', params: { projectId: selectedProject.id }, query: { profile: router.currentRoute.value.query.profile } })">
            {{ t('cowork.openProject') }}
          </NButton>
        </div>
        <NInput ref="searchInput" v-model:value="search" size="small" clearable :maxlength="100" :placeholder="t('cowork.searchProjects')" />
        <span class="cowork-menu__section">{{ t(search.trim() ? 'cowork.searchResults' : 'cowork.recentProjects') }}</span>
        <div role="listbox" :aria-label="t('cowork.projects')">
          <button
            v-for="project in visibleProjects"
            :key="project.id"
            type="button"
            role="option"
            :data-project-id="project.id"
            :aria-selected="modelValue?.id === project.id"
            class="cowork-menu__row"
            @click="chooseProject(project)"
          >
            <span class="project-dot" :style="{ background: project.color || '#5b67f1' }">{{ project.icon || 'P' }}</span>
            {{ project.name }}
          </button>
          <button v-if="modelValue" type="button" role="option" :aria-selected="false" class="cowork-menu__row" @click="chooseProject(null)">{{ t('cowork.clearProject') }}</button>
        </div>
        <span v-if="loadError" class="cowork-menu__empty">{{ t('cowork.unavailable') }} <button type="button" class="cowork-menu__retry" @click="loadProjects(search)">{{ t('cowork.retry') }}</button></span>
        <span v-else-if="!loading && !visibleProjects.length" class="cowork-menu__empty">{{ t('cowork.noProjects') }}</span>
        <button type="button" class="cowork-menu__row cowork-menu__action" @click="setOpen(false); showCreate = true">＋ {{ t('cowork.createProject') }}</button>
        <button type="button" class="cowork-menu__row cowork-menu__action" @click="setOpen(false); router.push({ name: 'hermes.coworkProject', query: { profile: router.currentRoute.value.query.profile } })">{{ t('cowork.viewAllProjects') }}</button>
      </div>
    </NPopover>
    <span v-if="frozen" class="cowork-picker__hint">{{ t('cowork.fixedForTask') }}</span>

    <NModal v-model:show="showCreate" preset="card" :title="t('cowork.createProject')" class="cowork-create-modal">
      <NInput v-model:value="name" :maxlength="60" :disabled="creating" :placeholder="t('cowork.projectName')" @keydown.enter="createProjectFromKeyboard" />
      <template #footer>
        <div class="cowork-create-actions">
          <NButton @click="showCreate = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" :disabled="creating || !name.trim()" @click="createProject">{{ t('common.create') }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.cowork-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; }
.cowork-picker__hint, .cowork-menu__empty { color: $text-muted; font-size: 12px; }
.cowork-menu { width: min(320px, 82vw); display: grid; gap: 6px; padding: 4px; }
.cowork-context { display: grid; gap: 7px; margin-bottom: 4px; padding: 10px; border-radius: 9px; background: $bg-card; }
.cowork-context__title { display: flex; align-items: center; gap: 8px; }
.cowork-context p { margin: 0; color: $text-secondary; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.cowork-context__instructions { display: grid; gap: 3px; padding-top: 7px; border-top: 1px solid $border-color; }
.cowork-context__instructions > span { color: $text-muted; font-size: 11px; font-weight: 600; }
.cowork-menu__section { padding: 6px 8px 2px; color: $text-muted; font-size: 11px; font-weight: 600; text-transform: uppercase; }
.cowork-menu__row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: 8px; background: transparent; color: $text-primary; text-align: left; cursor: pointer; }
.cowork-menu__row:hover, .cowork-menu__row[aria-selected="true"] { background: $bg-card; }
.cowork-menu__action { border-top: 1px solid $border-color; border-radius: 0; }
.cowork-menu__empty { padding: 10px 8px; }
.cowork-menu__retry { border: 0; background: transparent; color: $accent-primary; cursor: pointer; }
.project-dot { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; color: white; }
.cowork-create-modal { width: min(520px, 92vw); }
.cowork-create-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
