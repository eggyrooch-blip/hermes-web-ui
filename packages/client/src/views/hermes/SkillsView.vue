<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { NDrawer, NDrawerContent } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import KpIcon from '@/components/kippies/KpIcon.vue'
import MarketTabs from '@/components/hermes/market/MarketTabs.vue'
import KpPage from '@/components/kippies/KpPage.vue'
import KpListSkeleton from '@/components/kippies/KpListSkeleton.vue'
import KpFailState from '@/components/kippies/KpFailState.vue'
import SkillMarketGrid from '@/components/hermes/skills/SkillMarketGrid.vue'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillImportModal from '@/components/hermes/skills/SkillImportModal.vue'
import SkillExternalDirsModal from '@/components/hermes/skills/SkillExternalDirsModal.vue'
import PendingWriteApprovals from '@/components/hermes/skills/PendingWriteApprovals.vue'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { fetchSkills, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'
import { fetchPendingWrites } from '@/api/hermes/write-gate'
import { isStoredSuperAdmin } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { prefillComposer } from '@/composables/useComposerPrefill'

const { t, locale } = useI18n()
const router = useRouter()
const profilesStore = useProfilesStore()
const props = withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})
const categories = ref<SkillCategory[]>([])
const archived = ref<SkillInfo[]>([])
const loading = ref(false)
// The load used to swallow its error into console.error, so a failed fetch was
// indistinguishable from "you have no skills" — an empty grid with no way back.
const loadFailed = ref(false)
const selectedCategory = ref('')
const selectedSkill = ref('')
const searchQuery = ref('')
const recommendations = ref('')
/** Post-import instruction: the gateway has to reload for it to take effect. */
const importedNotice = ref('')
const showImportModal = ref(false)
const showExternalDirsModal = ref(false)
const showWriteApprovalDrawer = ref(false)
const showSkillDetail = ref(false)
const pendingWriteCount = ref(0)
const writeApprovalSupported = ref(true)
const isSuperAdmin = computed(() => isStoredSuperAdmin())
const showHostSkillActions = computed(() => isSuperAdmin.value)
const activeProfileName = computed(() => profilesStore.activeProfileName || '')
let recommendationsRequestSeq = 0
let profileWatchReady = false

// 创建技能 split menu (prototype CreateSkillMenu): one dark pill in the head,
// every acquisition/管理 entry lives in the popover instead of the header row.
const createMenuOpen = ref(false)
const createMenuRef = ref<HTMLElement>()

function handleWindowPointerDown(e: MouseEvent) {
  if (!createMenuOpen.value) return
  if (createMenuRef.value && !createMenuRef.value.contains(e.target as Node)) {
    createMenuOpen.value = false
  }
}

onMounted(() => window.addEventListener('mousedown', handleWindowPointerDown))
onBeforeUnmount(() => window.removeEventListener('mousedown', handleWindowPointerDown))

function pickCreateMenu(action: 'import' | 'writeApprovals' | 'externalDirs') {
  createMenuOpen.value = false
  if (action === 'import') showImportModal.value = true
  else if (action === 'writeApprovals') showWriteApprovalDrawer.value = true
  else showExternalDirsModal.value = true
}

const recommendationsPath = computed(() => {
  return String(locale.value).startsWith('zh')
    ? '/skill-recommendations.zh.md'
    : '/skill-recommendations.en.md'
})

const selectedSkillData = computed(() => {
  if (!selectedCategory.value || !selectedSkill.value) return null
  if (selectedCategory.value === '.archive') {
    return archived.value.find(s => s.name === selectedSkill.value) ?? null
  }
  const cat = categories.value.find(c => c.name === selectedCategory.value)
  return cat?.skills.find(s => s.name === selectedSkill.value) ?? null
})

onMounted(() => {
  void Promise.all([
    loadSkills(),
    loadPendingWriteCount(),
  ]).finally(() => {
    profileWatchReady = true
  })
  loadRecommendations()
})

async function loadSkills() {
  loading.value = true
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    const data = await fetchSkills(activeProfileName.value || undefined)
    categories.value = data.categories
    archived.value = data.archived
    loadFailed.value = false
  } catch (err: any) {
    console.error('Failed to load skills:', err)
    // Only claim failure on a cold first load. A refresh that fails while data
    // is already on screen must not replace it with the failure page — the
    // content you were reading is still valid.
    loadFailed.value = categories.value.length === 0
  } finally {
    loading.value = false
  }
}

async function loadRecommendations() {
  if (!isSuperAdmin.value) {
    recommendations.value = ''
    return
  }
  const requestSeq = ++recommendationsRequestSeq
  try {
    const response = await fetch(recommendationsPath.value)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (/^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text)) {
      throw new Error('Skill recommendations file was not found')
    }
    if (requestSeq === recommendationsRequestSeq) {
      recommendations.value = text
    }
  } catch (err) {
    if (requestSeq === recommendationsRequestSeq) {
      recommendations.value = ''
    }
    console.error('Failed to load skill recommendations:', err)
  }
}

watch(recommendationsPath, loadRecommendations)

watch(activeProfileName, async (profile, previous) => {
  if (!profileWatchReady || !profile || profile === previous) return
  selectedCategory.value = ''
  selectedSkill.value = ''
  await Promise.all([
    loadSkills(),
    loadPendingWriteCount(),
  ])
})

async function loadPendingWriteCount() {
  try {
    const data = await fetchPendingWrites()
    writeApprovalSupported.value = data.supported !== false
    pendingWriteCount.value = writeApprovalSupported.value ? data.records?.length || 0 : 0
  } catch (err) {
    console.error('Failed to load pending write approvals:', err)
  }
}

function handleSelect(category: string, skill: string) {
  selectedCategory.value = category
  selectedSkill.value = skill
  showSkillDetail.value = true
}

// 用它开一个任务: open a fresh task with the skill's slash command staged.
// `new: '1'` is the same fresh-draft signal the agents hub uses (ChatView
// consumes it); the prefill watcher only fires while ChatInput is mounted,
// and in surface mode it is not — navigate first, then stage the text.
async function handleUse(_category: string, skill: string) {
  await router.push({ name: 'hermes.chat', query: { new: '1' } })
  await nextTick()
  prefillComposer(`/${skill} `)
}

function handleSkillDeleted(category: string, skillName: string) {
  if (selectedCategory.value === category && selectedSkill.value === skillName) {
    selectedCategory.value = ''
    selectedSkill.value = ''
    showSkillDetail.value = false
  }
  loadSkills()
}

function handleImported(name: string) {
  showImportModal.value = false
  // The reload hint is an INSTRUCTION, not a receipt — the skill will not take
  // effect until the gateway reloads. The dialog that produced it is closing, so
  // it lives here, resident, until dismissed.
  importedNotice.value = name
    ? `${t('skills.importSuccess')}: ${name} — ${t('skills.reloadHint')}`
    : `${t('skills.importSuccess')} — ${t('skills.reloadHint')}`
  loadSkills()
}

function handleExternalDirsSaved() {
  showExternalDirsModal.value = false
  loadSkills()
}

function handlePinToggled(name: string, pinned: boolean) {
  // Update local state so the pin icon updates immediately
  if (selectedCategory.value === '.archive') {
    const skill = archived.value.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  } else {
    const cat = categories.value.find(c => c.name === selectedCategory.value)
    const skill = cat?.skills.find(s => s.name === name)
    if (skill) skill.pinned = pinned
  }
}
</script>

<template>
  <KpPage wide class="skills-view" :class="{ 'is-embedded': props.embedded }">
    <p v-if="importedNotice" class="skills-notice" data-testid="skills-import-notice">
      <span class="skills-notice__text">{{ importedNotice }}</span>
      <button
        type="button"
        class="skills-notice__close"
        :title="t('common.close')"
        @click="importedNotice = ''"
      >&times;</button>
    </p>
    <!-- Prototype page head: title block left, search pill + the single dark
         创建技能 split menu right. Nothing else lives in the header row. -->
    <header class="skills-head">
      <div class="skills-head__titles">
        <h1 class="t-h1">{{ t('market.title') }}</h1>
      </div>
      <div class="skills-head__actions">
        <label class="skills-search">
          <KpIcon name="line_search" :size="14" />
          <input
            v-model="searchQuery"
            class="skills-search__input"
            type="text"
            :placeholder="t('skills.searchPlaceholder')"
          />
        </label>
        <div ref="createMenuRef" class="create-skill">
          <button type="button" class="ab create-skill-btn" @click="createMenuOpen = !createMenuOpen">
            <KpIcon name="full_add" :size="15" />
            {{ t('skills.create') }}
            <span class="create-skill-btn__rule" />
            <KpIcon
              name="line_arrow_right"
              :size="12"
              class="create-skill-btn__caret"
              :class="{ 'is-open': createMenuOpen }"
            />
          </button>
          <div v-if="createMenuOpen" class="create-skill-menu">
            <button type="button" class="create-skill-menu__row" @click="pickCreateMenu('import')">
              <KpIcon name="line_menu" :size="15" class="create-skill-menu__icon" />
              <span class="t-sub">{{ t('skills.importTitle') }}</span>
            </button>
            <a
              class="create-skill-menu__row keephub-link"
              href="https://ark.example.com/aidock-cms/admin/skills"
              target="_blank"
              rel="noopener noreferrer"
              @click="createMenuOpen = false"
            >
              <KpIcon name="full_arrow_up" :size="15" class="create-skill-menu__icon" />
              <span class="t-sub">{{ t('skills.keepHubLink') }}</span>
            </a>
            <template v-if="writeApprovalSupported || showHostSkillActions">
              <div class="create-skill-menu__divider" />
              <button
                v-if="writeApprovalSupported"
                type="button"
                class="create-skill-menu__row"
                @click="pickCreateMenu('writeApprovals')"
              >
                <KpIcon name="line_check_circle" :size="15" class="create-skill-menu__icon" />
                <span class="t-sub">{{ t('skills.writeApprovalButton', { count: pendingWriteCount }) }}</span>
              </button>
              <button
                v-if="showHostSkillActions"
                type="button"
                class="create-skill-menu__row"
                @click="pickCreateMenu('externalDirs')"
              >
                <KpIcon name="line_data_sources" :size="15" class="create-skill-menu__icon" />
                <span class="t-sub">{{ t('skills.externalDirs.manage') }}</span>
              </button>
            </template>
          </div>
        </div>
      </div>
    </header>

    <MarketTabs active="skills" />
    <!-- The section's own line, below the strip: the h1 names the market, this
         names the section you are looking at. -->
    <p class="t-sub-multi market-sub">{{ t('skills.subtitle') }}</p>

    <SkillImportModal v-if="showImportModal" @close="showImportModal = false" @saved="handleImported" />
    <SkillExternalDirsModal v-if="showHostSkillActions && showExternalDirsModal"
      @close="showExternalDirsModal = false" @saved="handleExternalDirsSaved" />
    <NDrawer
      v-model:show="showWriteApprovalDrawer"
      width="min(960px, calc(100vw - 32px))"
      placement="right"
      class="write-approval-drawer"
    >
      <NDrawerContent :title="t('skills.writeApprovalTitle')" closable>
        <PendingWriteApprovals
          v-if="showWriteApprovalDrawer"
          @count-change="(count) => pendingWriteCount = count"
        />
      </NDrawerContent>
    </NDrawer>

    <!-- Skeleton, not the word "loading": the card wall's shape is already
         known, so it can be drawn before the data lands. -->
    <KpListSkeleton
      v-if="loading && categories.length === 0"
      variant="card"
      grid
      :rows="6"
    />
    <KpFailState
      v-else-if="loadFailed"
      :title="t('common.loadFailedTitle')"
      :body="t('common.loadFailedBody')"
      :retry-label="t('common.reload')"
      :retry-fail-label="t('common.stillUnreachable')"
      :on-retry="loadSkills"
    />
    <template v-else>
      <SkillMarketGrid
        :categories="categories"
        :archived="archived"
        :search-query="searchQuery"
        @select="handleSelect"
        @deleted="handleSkillDeleted"
        @use="handleUse"
      />

      <!-- The community recommendation list keeps its place under the wall. -->
      <section v-if="recommendations" class="skills-recommendations">
        <MarkdownRenderer :content="recommendations" />
      </section>
    </template>

    <NDrawer
      v-model:show="showSkillDetail"
      width="min(880px, calc(100vw - 32px))"
      placement="right"
    >
      <NDrawerContent :native-scrollbar="false" closable>
        <SkillDetail
          v-if="selectedCategory && selectedSkill"
          :category="selectedCategory"
          :skill="selectedSkill"
          :skill-name="selectedSkillData?.name || selectedSkill"
          :patch-count="selectedSkillData?.patchCount"
          :use-count="selectedSkillData?.useCount"
          :view-count="selectedSkillData?.viewCount"
          :pinned="selectedSkillData?.pinned"
          :editable="selectedSkillData?.editable"
          @pin-toggled="handlePinToggled"
        />
      </NDrawerContent>
    </NDrawer>
  </KpPage>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.skills-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.skills-notice__text {
  flex: 1;
  min-width: 0;
}

.skills-notice__close {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}


.skills-view {
  height: calc(100 * var(--vh));

  &.is-embedded {
    height: 100%;
    min-height: 0;
  }
}

// Prototype market-shell head: flex-start row, gap 16, 24px underhang (the
// same head geometry KpPage uses; this one is hand-rolled because the actions
// slot needs a split menu).
.skills-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}

.skills-head__titles {
  flex: 1;
  min-width: 0;
}

// Section line under the tab strip: same measure as KpPage's own sub.
.market-sub {
  margin-bottom: 24px;
  max-width: 560px;
}

.skills-head__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

// Keep search pill — 220×36 like the prototype's plugin-tab search.
.skills-search {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  width: 220px;
  border-radius: var(--r-pill);
  background: var(--gray-f7);
  color: var(--fg-aux);
}

.skills-search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);

  &::placeholder {
    color: var(--fg-aux);
  }
}

.create-skill {
  position: relative;
}

// Prototype CreateSkillMenu trigger: 34px ink pill with an inner rule
// before the caret.
.create-skill-btn {
  height: 34px;
  padding: 0 12px 0 16px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--gray-33);
  color: #fff;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  white-space: nowrap;
}

.create-skill-btn__rule {
  width: 1px;
  align-self: stretch;
  background: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
}

.create-skill-btn__caret {
  transform: rotate(90deg);
  transition: transform var(--motion-fast) var(--ease-std);

  &.is-open {
    transform: rotate(-90deg);
  }
}

.create-skill-menu {
  position: absolute;
  right: 0;
  top: 40px;
  min-width: 176px;
  background: var(--bg);
  border-radius: 12px;
  padding: 6px;
  box-shadow: var(--shadow-notification);
  z-index: 30;
}

.create-skill-menu__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-primary);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--gray-f2);
  }
}

.create-skill-menu__icon {
  color: var(--fg-aux);
}

.create-skill-menu__divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--divider);
}

.skills-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 72px 0;
  font-size: 13px;
  color: $text-muted;
}

.skills-recommendations {
  margin-top: 48px;
  padding-top: 32px;
  border-top: 0.5px solid var(--divider);

  :deep(.markdown-body) {
    font-size: 14px;
    line-height: 1.7;
  }
}

@media (max-width: $breakpoint-mobile) {
  .skills-head {
    flex-direction: column;
  }

  .skills-search {
    width: 160px;
  }
}
</style>
