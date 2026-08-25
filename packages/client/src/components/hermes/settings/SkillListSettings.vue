<script setup lang="ts">
/**
 * 我的创建 / 我的安装 — prototype ListPage anatomy: catrow rows with a
 * t-sub-medium name, a t-meta line, and a neutral tag pill on the right.
 * Rows navigate to the skills surface where the full detail lives.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin } from 'naive-ui'
import { useRouter } from 'vue-router'
import { fetchSkills, type SkillInfo } from '@/api/hermes/skills'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'

const props = defineProps<{ kind: 'created' | 'installed' }>()

const { t } = useI18n()
const router = useRouter()

const loading = ref(false)
const skills = ref<SkillInfo[]>([])

onMounted(async () => {
  loading.value = true
  try {
    const data = await fetchSkills()
    skills.value = data.categories.flatMap(category => category.skills)
  } catch {
    skills.value = []
  } finally {
    loading.value = false
  }
})

const items = computed(() => {
  if (props.kind === 'created') {
    // Things the user brought in themselves: local installs + external dirs.
    return skills.value.filter(s => s.source === 'local' || s.source === 'external')
  }
  // 我的安装: everything available to this profile, built-ins included —
  // mirrors the prototype where system built-ins list under 我的安装.
  return skills.value.filter(s => s.enabled !== false)
})

function sourceLabel(skill: SkillInfo): string {
  const source = skill.source ?? 'builtin'
  const key = source === 'hub' || source === 'keephub' ? 'keepaihub' : source
  return t(`skills.source.${key}`)
}

function openSkills() {
  void router.push({ name: 'hermes.skills' })
}

const title = computed(() =>
  props.kind === 'created' ? t('settings.tabs.created') : t('settings.tabs.installed'))
const emptyCopy = computed(() =>
  props.kind === 'created'
    ? t('settings.library.createdEmpty')
    : t('settings.library.installedEmpty'))
</script>

<template>
  <section class="skill-list-settings">
    <KpSectionTitle>{{ title }}</KpSectionTitle>
    <NSpin :show="loading">
      <KpEmptyState v-if="items.length === 0 && !loading" :title="emptyCopy" />
      <div v-else class="skill-rows">
        <div
          v-for="skill in items"
          :key="skill.name"
          class="skill-row catrow"
          @click="openSkills"
        >
          <div class="skill-row__body">
            <div class="skill-row__name">{{ skill.name }}</div>
            <div class="skill-row__meta">{{ t('settings.library.skillTag') }} · {{ sourceLabel(skill) }}</div>
          </div>
          <span class="skill-row__tag">{{ t('settings.library.skillTag') }}</span>
        </div>
      </div>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
.skill-rows {
  display: flex;
  flex-direction: column;
}

// Prototype Row: hover tint bleeds 12px past the content edge.
.skill-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  margin: 0 -12px;
  border-radius: var(--r-ctl);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);
}

.skill-row__body {
  flex: 1;
  min-width: 0;
}

.skill-row__name {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
}

.skill-row__meta {
  margin-top: 2px;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
}

// Prototype list tag: 22px neutral pill on surface-3.
.skill-row__tag {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--gray-f2);
  font: var(--w-medium) var(--t-12) / 22px var(--font-cn);
  color: var(--fg-secondary);
}
</style>
