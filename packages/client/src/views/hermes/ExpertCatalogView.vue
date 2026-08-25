<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { NDrawer, NDrawerContent } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import KpIcon from '@/components/kippies/KpIcon.vue'
import MarketTabs from '@/components/hermes/market/MarketTabs.vue'
import KpPage from '@/components/kippies/KpPage.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import {
  fetchExperts,
  formatExpertReleaseVersion,
  formatExpertUpdatedFull,
  isAiHubExpert,
  isExpertRecentlyUpdated,
  type ExpertInfo,
} from '@/api/hermes/experts'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ExpertDetailPanel from '@/components/hermes/expert/ExpertDetailPanel.vue'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const router = useRouter()

const experts = ref<ExpertInfo[]>([])
const loading = ref(false)
const errored = ref(false)
const searchQuery = ref('')
// Category filter (prototype's MARKET_CATS SegChip row). Derived from the real
// experts so it always matches what's on screen; `__all__` shows everything.
const ALL_CATEGORY = '__all__'
const selectedCategory = ref(ALL_CATEGORY)
const categories = computed(() => {
  const set = new Set<string>()
  for (const e of experts.value) if (e.category) set.add(e.category)
  return [ALL_CATEGORY, ...set]
})

// New-badge expiry must track wall-clock, not just render time
const nowTick = ref(Date.now())
let nowTimer: number | undefined
onMounted(() => {
  nowTimer = window.setInterval(() => { nowTick.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (nowTimer !== undefined) window.clearInterval(nowTimer)
})
// Keep AI Hub entry, relocated here from the removed expert/skills/connectors
// tab bar — the prototype reaches those three from the nav rail instead.
const KEEP_AIHUB_URL = 'https://ark.example.com/aidock-cms/admin/skills'

const selected = ref<ExpertInfo | null>(null)
const showDetail = ref(false)
const brokenAvatarIds = ref<Set<string>>(new Set())

const activeProfileName = computed(() => profilesStore.activeProfileName || '')

const filteredExperts = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  let sorted = [...experts.value].sort((a, b) => Number(!!b.featured) - Number(!!a.featured))
  if (selectedCategory.value !== ALL_CATEGORY) {
    sorted = sorted.filter((e) => e.category === selectedCategory.value)
  }
  if (!q) return sorted
  return sorted.filter((e) => {
    const haystack = [
      e.name,
      e.title,
      e.tagline,
      e.category,
      ...(e.display_tags ?? []),
      ...(e.skills ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
})

function initialOf(e: ExpertInfo): string {
  const src = (e.name || e.title || e.id || '?').trim()
  return src ? Array.from(src)[0] : '?'
}

function isActive(e: ExpertInfo): boolean {
  return chatStore.activeExpertId === e.id
}

function hasAvatar(e: ExpertInfo): boolean {
  return !!e.avatar && !brokenAvatarIds.value.has(e.id)
}

function markAvatarBroken(e: ExpertInfo) {
  const next = new Set(brokenAvatarIds.value)
  next.add(e.id)
  brokenAvatarIds.value = next
}

async function loadExperts() {
  loading.value = true
  errored.value = false
  try {
    const data = await fetchExperts(activeProfileName.value || undefined)
    experts.value = data.experts
    brokenAvatarIds.value = new Set()
  } catch {
    experts.value = []
    errored.value = true
  } finally {
    loading.value = false
  }
}

function openDetail(expert: ExpertInfo) {
  selected.value = expert
  showDetail.value = true
}

async function startExpertChat(expert: ExpertInfo) {
  const session = chatStore.newChatWithExpert(expert)
  showDetail.value = false
  await router.push({
    name: 'hermes.session',
    params: { sessionId: session.id },
    query: session.profile ? { profile: session.profile } : undefined,
  })
}

onMounted(() => {
  void loadExperts()
})

watch(activeProfileName, () => {
  void loadExperts()
})
</script>

<template>
  <KpPage wide class="expert-catalog-view" :title="t('market.title')">
    <template #right>
      <label class="catalog-search">
        <KpIcon name="line_search" :size="14" />
        <input
          v-model="searchQuery"
          class="catalog-search__input"
          type="text"
          :placeholder="t('expert.catalog.searchPlaceholder')"
        />
      </label>
      <a
        class="keephub-link"
        :href="KEEP_AIHUB_URL"
        target="_blank"
        rel="noopener noreferrer"
      >{{ t('skills.keepHubLink') }}</a>
    </template>

    <MarketTabs active="expert" />
    <!-- The section's own line, below the strip: the h1 names the market, this
         names the section you are looking at. -->
    <p class="t-sub-multi market-sub">{{ t('expert.catalog.subtitle') }}</p>

    <!-- Category filter (prototype MARKET_CATS SegChip row). -->
    <div v-if="categories.length > 1" class="catalog-cats">
      <button
        v-for="cat in categories"
        :key="cat"
        type="button"
        class="catalog-cat"
        :class="{ active: selectedCategory === cat }"
        @click="selectedCategory = cat"
      >
        {{ cat === ALL_CATEGORY ? t('expert.catalog.allCategories') : cat }}
      </button>
    </div>

    <KpSectionTitle>{{ t('expert.catalog.allExperts') }}</KpSectionTitle>

    <div class="catalog-body">
      <div v-if="loading" class="catalog-state">{{ t('expert.catalog.loading') }}</div>
      <div v-else-if="errored" class="catalog-state">{{ t('expert.catalog.error') }}</div>
      <KpEmptyState
        v-else-if="filteredExperts.length === 0"
        :title="searchQuery.trim() ? t('expert.catalog.noResults') : t('expert.catalog.empty')"
      />

      <div v-else class="catalog-grid">
        <button
          v-for="expert in filteredExperts"
          :key="expert.id"
          class="expert-card"
          :class="{ active: isActive(expert), 'has-new': isExpertRecentlyUpdated(expert, nowTick) }"
          type="button"
          @click="openDetail(expert)"
        >
          <span v-if="isExpertRecentlyUpdated(expert, nowTick)" class="card-new-badge">{{ t('expert.catalog.newBadge') }}</span>
          <!-- Prototype .cardact: a dark quick-action that surfaces on hover so
               you can summon the expert without opening the detail drawer. -->
          <span
            class="card-corner"
            role="button"
            tabindex="0"
            @click.stop="startExpertChat(expert)"
            @keydown.enter.stop="startExpertChat(expert)"
          >{{ t('expert.catalog.summon') }}</span>
          <div class="card-header">
            <div class="card-avatar" :class="{ 'has-image': hasAvatar(expert) }">
              <img
                v-if="hasAvatar(expert)"
                :src="expert.avatar"
                :alt="expert.title || expert.name"
                @error="markAvatarBroken(expert)"
              />
              <span v-else class="avatar-initial">{{ initialOf(expert) }}</span>
            </div>
            <div class="card-identity">
              <div class="card-title-row">
                <h3 class="card-title">{{ expert.title || expert.name }}</h3>
                <span v-if="isActive(expert)" class="card-active-badge">{{ t('expert.catalog.activeBadge') }}</span>
              </div>
              <div class="card-meta-row">
                <span v-if="expert.category" class="card-category">{{ expert.category }}</span>
                <span v-if="isAiHubExpert(expert)" class="card-source-badge">{{ t('expert.catalog.aihubBadge') }}</span>
                <span
                  v-if="formatExpertReleaseVersion(expert)"
                  class="card-version"
                  :title="formatExpertReleaseVersion(expert)"
                >
                  {{ formatExpertReleaseVersion(expert) }}
                </span>
                <span v-else class="card-version-placeholder" aria-hidden="true">v0.0.0</span>
                <span v-if="formatExpertUpdatedFull(expert)" class="card-updated">
                  {{ t('expert.catalog.updatedAt', { date: formatExpertUpdatedFull(expert) }) }}
                </span>
                <span v-if="(expert.use_count ?? 0) > 0" class="card-usage">
                  {{ t('expert.catalog.usedCount', { count: expert.use_count }) }}
                </span>
              </div>
            </div>
          </div>
          <p v-if="expert.tagline" class="card-tagline">{{ expert.tagline }}</p>
          <div v-if="expert.display_tags?.length" class="card-tags">
            <span v-for="tag in expert.display_tags" :key="tag" class="card-tag">{{ tag }}</span>
          </div>
        </button>
      </div>
    </div>

    <NDrawer v-model:show="showDetail" :width="380" placement="right">
      <NDrawerContent :native-scrollbar="false" closable>
        <ExpertDetailPanel
          v-if="selected"
          :expert="selected"
          :active="isActive(selected)"
          @close="showDetail = false"
          @activate="startExpertChat"
        />
      </NDrawerContent>
    </NDrawer>
  </KpPage>
</template>

<style scoped lang="scss">
.expert-catalog-view {
  height: 100%;
  min-height: 0;
}

// Keep AI Hub entry, now sitting in the page header next to the search pill.
.keephub-link {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 36px;
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--keep-green);
  text-decoration: none;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
}

// Keep search pill.
.catalog-search {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  width: min(320px, 100%);
  border-radius: var(--r-pill);
  background: var(--gray-f7);
  color: var(--fg-aux);
}

.catalog-search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--fg-title);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);

  &::placeholder {
    color: var(--fg-aux);
  }
}

// Section line under the tab strip: same measure as KpPage's own sub.
.market-sub {
  margin-bottom: 24px;
  max-width: 560px;
}

// Category SegChip row (prototype MARKET_CATS filter).
.catalog-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 24px;
}

.catalog-cat {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--gray-f7);
  }

  &.active {
    background: var(--gray-f2);
    color: var(--fg-title);
  }
}

.catalog-body {
  margin-top: 20px;
}

// Prototype .cardact: dark quick-action, revealed on card hover / focus.
.card-corner {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--action);
  color: var(--action-fg);
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base) var(--ease-std);
}

.expert-card:hover .card-corner,
.card-corner:focus-visible {
  opacity: 1;
}

.catalog-state {
  padding: 40px 16px;
  text-align: center;
  color: var(--fg-aux);
  font: var(--w-regular) var(--t-13) / 1.5 var(--font-cn);
}

.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

// ItemCard geometry: flat, 1px hairline inset ring (unchanged on hover — only
// the background tints), no drop shadow.
.expert-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 170px;
  padding: 20px;
  text-align: left;
  border: 0;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  cursor: pointer;
  transition: background var(--motion-base) var(--ease-std);

  &:hover,
  &:focus-visible {
    background: var(--gray-fa);
    outline: none;
  }

  &.active {
    box-shadow: inset 0 0 0 1.5px var(--action);
  }
}

.card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

// People → circle avatars.
.card-avatar {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: var(--r-pill);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--gray-f2);
  color: var(--fg-title);
  font: var(--w-medium) var(--t-16) / var(--lh-1) var(--font-cn);
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.card-identity {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-title-row,
.card-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.card-title {
  margin: 0;
  min-width: 0;
  max-width: 100%;
  font: var(--w-medium) var(--t-16) / 1.4 var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-active-badge {
  font: var(--w-medium) var(--t-10) / 1.35 var(--font-cn);
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--action);
  color: var(--action-fg);
}

.card-source-badge {
  font: var(--w-regular) var(--t-10) / 1.35 var(--font-cn);
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--hue-purple-bg);
  color: var(--hue-purple);
}

.card-version,
.card-version-placeholder {
  box-sizing: border-box;
  width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font: var(--w-regular) var(--t-10) / 1.35 var(--font-data);
  padding: 1px 8px;
  border-radius: var(--r-pill);
}

/* keep the version slot's space so Updated aligns across cards (sunke 2026-07-30) */
.card-version-placeholder {
  visibility: hidden;
  box-shadow: inset 0 0 0 0.5px transparent;
}

.card-updated,
.card-usage {
  font: var(--w-regular) var(--t-10) / 1.35 var(--font-cn);
  color: var(--fg-aux);
}

.card-version {
  box-shadow: inset 0 0 0 0.5px var(--divider);
  color: var(--fg-secondary);
}

/* keep the long-title row clear of the absolute top-right pill */
.expert-card.has-new .card-title-row {
  padding-right: 48px;
}

.card-new-badge {
  position: absolute;
  top: 16px;
  right: 16px;
  font: var(--w-semibold) var(--t-10) / 1.35 var(--font-cn);
  padding: 2px 10px;
  border-radius: var(--r-pill);
  background: var(--keep-green-bg);
  color: var(--action-press);
}

.card-category {
  font: var(--w-regular) var(--t-10) / 1.35 var(--font-cn);
  padding: 1px 8px;
  border-radius: var(--r-pill);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  color: var(--fg-secondary);
}

.card-tagline {
  margin: 0;
  flex: 1;
  min-height: 40px;
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  color: var(--fg-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
}

.card-tag {
  // Prototype tag chip: 28-high, 13/28, --gray-f2 surface.
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  font: var(--w-regular) var(--t-13) / 28px var(--font-cn);
  border-radius: var(--r-ctl);
  background: var(--gray-f2);
  color: var(--fg-secondary);
}
</style>
