<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { NInput, NDrawer, NDrawerContent } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchExperts, type ExpertInfo } from '@/api/hermes/experts'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ExpertDetailPanel from '@/components/hermes/expert/ExpertDetailPanel.vue'

const { t } = useI18n()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()

const experts = ref<ExpertInfo[]>([])
const loading = ref(false)
const errored = ref(false)
const searchQuery = ref('')
const selected = ref<ExpertInfo | null>(null)
const showDetail = ref(false)

const activeProfileName = computed(() => profilesStore.activeProfileName || '')

const filteredExperts = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const sorted = [...experts.value].sort((a, b) => Number(!!b.featured) - Number(!!a.featured))
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

async function loadExperts() {
  loading.value = true
  errored.value = false
  try {
    const data = await fetchExperts(activeProfileName.value || undefined)
    experts.value = data.experts
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

function activateExpert(expert: ExpertInfo) {
  chatStore.setActiveExpert(expert.id)
  showDetail.value = false
}

function deactivateExpert() {
  chatStore.setActiveExpert(null)
}

onMounted(() => {
  void loadExperts()
})

watch(activeProfileName, () => {
  void loadExperts()
})
</script>

<template>
  <div class="expert-catalog-view">
    <div class="catalog-toolbar">
      <NInput
        v-model:value="searchQuery"
        class="catalog-search"
        :placeholder="t('expert.catalog.searchPlaceholder')"
        clearable
        size="small"
      />
    </div>

    <div class="catalog-body">
      <div v-if="loading" class="catalog-state">{{ t('expert.catalog.loading') }}</div>
      <div v-else-if="errored" class="catalog-state">{{ t('expert.catalog.error') }}</div>
      <div v-else-if="filteredExperts.length === 0" class="catalog-state">
        {{ searchQuery.trim() ? t('expert.catalog.noResults') : t('expert.catalog.empty') }}
      </div>

      <div v-else class="catalog-grid">
        <button
          v-for="expert in filteredExperts"
          :key="expert.id"
          class="expert-card"
          :class="{ active: isActive(expert) }"
          type="button"
          @click="openDetail(expert)"
        >
          <div class="card-top">
            <div class="card-avatar" :class="{ 'has-image': !!expert.avatar }">
              <img v-if="expert.avatar" :src="expert.avatar" :alt="expert.title || expert.name" />
              <span v-else class="avatar-initial">{{ initialOf(expert) }}</span>
            </div>
            <span v-if="isActive(expert)" class="card-active-badge">{{ t('expert.catalog.activeBadge') }}</span>
          </div>
          <h3 class="card-title">{{ expert.title || expert.name }}</h3>
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
          @activate="activateExpert"
          @deactivate="deactivateExpert"
        />
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.expert-catalog-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.catalog-toolbar {
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
}

.catalog-search {
  max-width: 320px;
}

.catalog-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.catalog-state {
  padding: 40px 16px;
  text-align: center;
  color: $text-muted;
  font-size: 13px;
}

.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.expert-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  text-align: left;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  cursor: pointer;
  transition:
    border-color $transition-fast,
    box-shadow $transition-fast,
    transform $transition-fast;

  &:hover {
    border-color: $accent-muted;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    transform: translateY(-1px);
  }

  &.active {
    border-color: $accent-primary;
    box-shadow: 0 0 0 1px $accent-primary;
  }
}

.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
  color: $text-primary;
  font-size: 18px;
  font-weight: 600;
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.card-active-badge {
  font-size: 11px;
  line-height: 16px;
  padding: 1px 8px;
  border-radius: 999px;
  background: $accent-primary;
  color: #fff;
}

.card-title {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  color: $text-primary;
}

.card-tagline {
  margin: 0;
  font-size: 12px;
  line-height: 17px;
  color: $text-secondary;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.card-tag {
  font-size: 11px;
  line-height: 16px;
  padding: 1px 8px;
  border-radius: 999px;
  background: $bg-primary;
  color: $text-muted;
}
</style>
