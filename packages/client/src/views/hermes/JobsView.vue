<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import JobsPanel from '@/components/hermes/jobs/JobsPanel.vue'
import JobRunHistory from '@/components/hermes/jobs/JobRunHistory.vue'
import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'
import KpPage from '@/components/kippies/KpPage.vue'
import KpBtn from '@/components/kippies/KpBtn.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpSegChip from '@/components/kippies/KpSegChip.vue'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
})
const jobsStore = useJobsStore()
const profilesStore = useProfilesStore()
const showModal = ref(false)
const editingJob = ref<string | null>(null)
const selectedJobId = ref<string | null>(null)
const sortBy = ref<'time' | 'name'>('name')
const sortAsc = ref(true)
const filter = ref<'all' | 'enabled'>('all')
const showSortMenu = ref(false)
const activeProfileName = computed(() => profilesStore.activeProfileName || 'default')
let profileWatchReady = false

const allCount = computed(() => jobsStore.jobs.length)
const enabledCount = computed(() => jobsStore.jobs.filter(job => job.enabled).length)

const jobNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const job of jobsStore.jobs) {
    const id = job.job_id || job.id
    map[id] = job.name
  }
  return map
})

async function ensureProfileSelection() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
}

async function reloadJobsForProfile() {
  selectedJobId.value = null
  jobsStore.jobs = []
  await ensureProfileSelection()
  await jobsStore.fetchJobs()
}

onMounted(async () => {
  await reloadJobsForProfile()
  profileWatchReady = true
})

watch(() => profilesStore.activeProfileName, async (profile, previous) => {
  if (!profileWatchReady || !profile || profile === previous) return
  await reloadJobsForProfile()
})

function openCreateModal() {
  editingJob.value = null
  showModal.value = true
}

function openEditModal(jobId: string) {
  editingJob.value = jobId
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
  editingJob.value = null
}

async function handleSave() {
  await jobsStore.fetchJobs()
  handleModalClose()
}

function handleSelectJob(jobId: string | null) {
  selectedJobId.value = selectedJobId.value === jobId ? null : jobId
}

function toggleSort(field: 'time' | 'name') {
  if (sortBy.value === field) {
    sortAsc.value = !sortAsc.value
  } else {
    sortBy.value = field
    sortAsc.value = true
  }
}

function arrowIcon(field: 'time' | 'name'): string {
  if (sortBy.value !== field) return '↕'
  return sortAsc.value ? '↑' : '↓'
}
</script>

<template>
  <!-- One frame for both entry points. The prototype shows the same full page
       whether you reach it from the nav rail or open it standalone, so the
       embedded surface must not shrink to a compact header. -->
  <KpPage
    wide
    :class="{ 'is-embedded': props.embedded }"
    :title="t('jobs.title')"
    :sub="t('jobs.subtitle')"
  >
    <template #right>
      <KpBtn
        kind="dark"
        icon="full_add"
        icon-end="full_arrow_down"
        data-testid="jobs-create"
        @click="openCreateModal"
      >
        {{ t('jobs.createJob') }}
      </KpBtn>
    </template>

    <div class="jobs-body">
      <div class="jobs-filter">
        <KpSegChip type="button" :on="filter === 'all'" :count="allCount" @click="filter = 'all'">
          {{ t('jobs.filterAll') }}
        </KpSegChip>
        <KpSegChip type="button" :on="filter === 'enabled'" :count="enabledCount" @click="filter = 'enabled'">
          {{ t('jobs.filterEnabled') }}
        </KpSegChip>
        <div class="jobs-filter__spacer" />
        <div class="jobs-filter__sort">
          <button
            type="button"
            class="filter-icon"
            :class="{ 'is-active': showSortMenu }"
            :title="t('jobs.sortBy')"
            @click="showSortMenu = !showSortMenu"
          >
            <KpIcon name="line_screening" :size="15" />
          </button>
          <template v-if="showSortMenu">
            <div class="sort-backdrop" @click="showSortMenu = false" />
            <div class="sort-menu">
              <button type="button" class="sort-menu__item" @click="toggleSort('name')">
                <span>{{ t('jobs.sortByName') }}</span>
                <span class="sort-menu__arrow">{{ arrowIcon('name') }}</span>
              </button>
              <button type="button" class="sort-menu__item" @click="toggleSort('time')">
                <span>{{ t('jobs.sortByTime') }}</span>
                <span class="sort-menu__arrow">{{ arrowIcon('time') }}</span>
              </button>
            </div>
          </template>
        </div>
      </div>

      <JobsPanel
        :selected-job-id="selectedJobId"
        :sort-by="sortBy"
        :sort-asc="sortAsc"
        :filter="filter"
        @edit="openEditModal"
        @select="handleSelectJob"
      />

      <div class="jobs-history">
        <JobRunHistory
          :selected-job-id="selectedJobId"
          :job-name-map="jobNameMap"
          :profile-key="activeProfileName"
        />
      </div>
    </div>
  </KpPage>

  <JobFormModal
    v-if="showModal"
    :job-id="editingJob"
    @close="handleModalClose"
    @saved="handleSave"
  />
</template>

<style scoped lang="scss">
// Standalone body sits inside KpPage's centred column.
.jobs-body {
  display: flex;
  flex-direction: column;
}

.jobs-history {
  margin-top: 28px;
}

// Filter row — prototype AutoScreen: gap 4, margin-bottom 4.
.jobs-filter {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.jobs-filter__spacer {
  flex: 1;
}

.jobs-filter__sort {
  position: relative;
}

.filter-icon {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--r-ctl);
  background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--divider);
  color: var(--fg-secondary);
  display: grid;
  place-items: center;
  cursor: pointer;

  &.is-active {
    color: var(--fg-primary);
  }
}

.sort-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.sort-menu {
  position: absolute;
  top: 38px;
  right: 0;
  z-index: 41;
  min-width: 160px;
  padding: 4px;
  background: var(--bg);
  border-radius: var(--r-card-l);
  box-shadow: inset 0 0 0 0.5px var(--divider), var(--shadow-notification);
}

.sort-menu__item {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-card-s);
  background: transparent;
  color: var(--fg-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;

  &:hover {
    background: var(--gray-fa);
  }
}

.sort-menu__arrow {
  color: var(--fg-aux);
  font-family: var(--font-data);
}

// Embedded (chat sidebar surface): compact, no big title.
.kp-page.is-embedded {
  height: 100%;
  min-height: 0;
}
</style>
