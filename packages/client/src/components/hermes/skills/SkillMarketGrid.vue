<script setup lang="ts">
/**
 * The skills screen body from the prototype's SkillsScreen (plugin tab):
 * 精选技能 sampler → 市场/内置/已安装 seg-chips → per-tab card walls.
 *
 * Local mapping of the prototype's marketplace semantics — every skill on
 * disk is already usable, so "installed vs not" becomes "enabled vs off":
 * - 市场 = every skill, browsing anatomy (badge + source + arrow, corner
 *   quick-action). No management controls here.
 * - 内置 = `builtin`-source skills — toggle only, never uninstalled (the
 *   prototype's rule; deleting shipped skills is a trap anyway).
 * - 已安装 = everything the user added (local / KeepAiHub / external) —
 *   toggle plus 卸载 (delete).
 */
import { computed, ref } from 'vue'
import { useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpAppIcon from '@/components/kippies/KpAppIcon.vue'
import KpToggle from '@/components/kippies/KpToggle.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'
import KpSegChip from '@/components/kippies/KpSegChip.vue'
import KpGhostBtn from '@/components/kippies/KpGhostBtn.vue'
import KpCornerBtn from '@/components/kippies/KpCornerBtn.vue'
import { deleteSkillApi, toggleSkill, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'

// Same display-source merge as always: `hub` and `keephub` are two backend
// sources but one idea to the user. The raw value is never mutated.
function displaySource(source?: string | null): string {
  const s = source || 'local'
  return s === 'hub' || s === 'keephub' ? 'keepaihub' : s
}

const props = defineProps<{
  categories: SkillCategory[]
  archived: SkillInfo[]
  searchQuery: string
}>()

const emit = defineEmits<{
  select: [category: string, skill: string]
  deleted: [category: string, skill: string]
  use: [category: string, skill: string]
}>()

const { t } = useI18n()
/** Toggle and delete failures. Successes show on the cards themselves. */
const paneError = ref('')
const dialog = useDialog()

const ALL_CATEGORY = '__all__'
const activeCategory = ref(ALL_CATEGORY)
type SkillTab = 'market' | 'builtin' | 'installed'
const skillTab = ref<SkillTab>('market')
const togglingSkills = ref<Set<string>>(new Set())

type Row = { category: string; skill: SkillInfo }

const allRows = computed<Row[]>(() => {
  const rows: Row[] = []
  for (const category of props.categories) {
    for (const skill of category.skills || []) rows.push({ category: category.name, skill })
  }
  for (const skill of props.archived || []) rows.push({ category: '.archive', skill })
  return rows
})

function isArchived(row: Row) {
  return row.category === '.archive'
}

function matchesSearch(row: Row) {
  const q = props.searchQuery.trim().toLowerCase()
  if (!q) return true
  return `${row.skill.name} ${row.skill.description || ''}`.toLowerCase().includes(q)
}

// 精选技能 (prototype): a rotating three-card window over the wall, 换一批
// steps the window. Deterministic like the prototype's (seed + k) % length —
// a random shuffle would reorder on every unrelated re-render.
const FEATURED_COUNT = 3
const featuredSeed = ref(3)
const featuredRows = computed<Row[]>(() => {
  const pool = allRows.value.filter(row => !isArchived(row))
  if (pool.length === 0) return []
  const count = Math.min(FEATURED_COUNT, pool.length)
  return Array.from({ length: count }, (_, k) => pool[(featuredSeed.value + k) % pool.length])
})

const builtinRows = computed(() =>
  allRows.value.filter(row => !isArchived(row) && displaySource(row.skill.source) === 'builtin'),
)
const installedRows = computed(() =>
  allRows.value.filter(row => !isArchived(row) && displaySource(row.skill.source) !== 'builtin'),
)
// The 内置 count follows the prototype: how many built-ins are ON.
const builtinOnCount = computed(() => builtinRows.value.filter(row => row.skill.enabled !== false).length)

const categoryChips = computed(() => {
  const names = props.categories.filter(c => (c.skills || []).length > 0).map(c => c.name)
  return [ALL_CATEGORY, ...names]
})

const marketRows = computed(() =>
  allRows.value.filter(row => {
    if (activeCategory.value !== ALL_CATEGORY && row.category !== activeCategory.value) return false
    return matchesSearch(row)
  }),
)
// The prototype only searches the market list; filtering the management tabs
// too is invisible there but obviously right, so the query applies everywhere.
const builtinVisible = computed(() => builtinRows.value.filter(matchesSearch))
const installedVisible = computed(() => installedRows.value.filter(matchesSearch))

const marketGroupTitle = computed(() =>
  activeCategory.value === ALL_CATEGORY ? t('skills.allSkills') : activeCategory.value,
)

function skillKey(row: Row) {
  return `${row.category}/${row.skill.name}`
}

// Prototype cards carry per-skill brand colours; the closest stable local
// equivalent is a name-hashed pick from the three accent hues.
const MARK_HUES = ['var(--hue-purple)', 'var(--hue-blue)', 'var(--hue-cyan)']
function hueOf(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return MARK_HUES[h % MARK_HUES.length]
}
function markOf(name: string): string {
  return (name.trim()[0] || '?').toUpperCase()
}

function isOn(row: Row) {
  return !isArchived(row) && row.skill.enabled !== false
}

function badgeText(row: Row) {
  if (isArchived(row)) return t('skills.archived')
  return row.skill.enabled !== false ? t('skills.stateEnabled') : t('skills.stateDisabled')
}

function sourceLabel(row: Row) {
  return t(`skills.source.${displaySource(row.skill.source)}`)
}

async function handleToggle(row: Row, enabled: boolean) {
  const key = skillKey(row)
  if (togglingSkills.value.has(key)) return
  togglingSkills.value.add(key)
  const previous = row.skill.enabled
  row.skill.enabled = enabled
  try {
    await toggleSkill(row.skill.name, enabled)
  } catch {
    row.skill.enabled = previous
    paneError.value = t('skills.toggleFailed')
  } finally {
    togglingSkills.value.delete(key)
  }
}

function handleDelete(row: Row) {
  dialog.warning({
    title: t('skills.deleteTitle'),
    content: t('skills.deleteConfirm', { name: row.skill.name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await deleteSkillApi(row.category, row.skill.name)
        emit('deleted', row.category, row.skill.name)
      } catch {
        paneError.value = t('skills.deleteFailed')
      }
    },
  })
}
</script>

<template>
  <div class="skill-market">
    <p v-if="paneError" class="pane-notice" data-testid="skill-grid-error">{{ paneError }}</p>
    <!-- 精选技能: rotating 3-card sampler, description-only cards plus the
         quick corner action. Management stays on the walls below. -->
    <section v-if="featuredRows.length > 0" class="skill-market__featured">
      <KpSectionTitle>
        {{ t('skills.featured') }}
        <template #action>
          <KpGhostBtn @click="featuredSeed += FEATURED_COUNT">
            {{ t('skills.shuffle') }}
          </KpGhostBtn>
        </template>
      </KpSectionTitle>
      <div class="skill-market__featured-grid">
        <article
          v-for="(row, k) in featuredRows"
          :key="skillKey(row) + k"
          class="skill-card catrow"
          role="button"
          tabindex="0"
          @click="emit('select', row.category, row.skill.name)"
          @keydown.enter.prevent="emit('select', row.category, row.skill.name)"
        >
          <div class="skill-card__head">
            <KpAppIcon :mark="markOf(row.skill.name)" :color="hueOf(row.skill.name)" />
            <span class="skill-card__name" :title="row.skill.name">{{ row.skill.name }}</span>
            <KpCornerBtn
              v-if="isOn(row)"
              class="skill-card__corner"
              icon="line_comment"
              :title="t('skills.useSkill')"
              @click="emit('use', row.category, row.skill.name)"
            />
            <KpCornerBtn
              v-else
              class="skill-card__corner"
              icon="line_add"
              :title="t('skills.enableSkill')"
              @click="handleToggle(row, true)"
            />
          </div>
          <p class="skill-card__desc">{{ row.skill.description || t('skills.noDescription') }}</p>
        </article>
      </div>
    </section>

    <!-- 市场 / 内置 N / 已安装 N — the prototype's three-stall split. -->
    <div class="skill-market__tabs">
      <KpSegChip
        type="button"
        :on="skillTab === 'market'"
        data-testid="skills-tab-market"
        @click="skillTab = 'market'"
      >
        {{ t('skills.tabMarket') }}
      </KpSegChip>
      <KpSegChip
        type="button"
        :on="skillTab === 'builtin'"
        :count="builtinOnCount"
        data-testid="skills-tab-builtin"
        @click="skillTab = 'builtin'"
      >
        {{ t('skills.tabBuiltin') }}
      </KpSegChip>
      <KpSegChip
        type="button"
        :on="skillTab === 'installed'"
        :count="installedRows.length"
        data-testid="skills-tab-installed"
        @click="skillTab = 'installed'"
      >
        {{ t('skills.tabInstalled') }}
      </KpSegChip>
    </div>

    <div v-if="skillTab === 'market'" :key="'market'" class="tabfade">
      <div v-if="categoryChips.length > 1" class="skill-market__cats">
        <KpSegChip
          v-for="cat in categoryChips"
          :key="cat"
          type="button"
          :on="activeCategory === cat"
          @click="activeCategory = cat"
        >
          {{ cat === ALL_CATEGORY ? t('skills.allCategories') : cat }}
        </KpSegChip>
      </div>

      <div v-if="marketRows.length === 0" class="skill-market__none t-sub">{{ t('skills.noMatch') }}</div>
      <div v-else class="skill-market__group">
        <KpSectionTitle>{{ marketGroupTitle }}</KpSectionTitle>
        <div class="skill-market__grid">
          <article
            v-for="row in marketRows"
            :key="skillKey(row)"
            class="skill-card catrow"
            role="button"
            tabindex="0"
            :data-skill="row.skill.name"
            @click="emit('select', row.category, row.skill.name)"
            @keydown.enter.prevent="emit('select', row.category, row.skill.name)"
            @keydown.space.prevent="emit('select', row.category, row.skill.name)"
          >
            <div class="skill-card__head">
              <KpAppIcon :mark="markOf(row.skill.name)" :color="hueOf(row.skill.name)" />
              <span class="skill-card__name" :title="row.skill.name">{{ row.skill.name }}</span>
              <KpCornerBtn
                v-if="isOn(row)"
                class="skill-card__corner"
                icon="line_comment"
                :title="t('skills.useSkill')"
                @click="emit('use', row.category, row.skill.name)"
              />
              <KpCornerBtn
                v-else-if="!isArchived(row)"
                class="skill-card__corner"
                icon="line_add"
                :title="t('skills.enableSkill')"
                @click="handleToggle(row, true)"
              />
            </div>

            <p class="skill-card__desc">{{ row.skill.description || t('skills.noDescription') }}</p>

            <div class="skill-card__foot">
              <span class="skill-badge" :class="{ 'is-purple': isOn(row) }">{{ badgeText(row) }}</span>
              <span class="skill-card__divider" />
              <KpIcon name="full_star_ai" :size="14" class="skill-card__star" />
              <span class="skill-card__meta">{{ sourceLabel(row) }}</span>
              <span v-if="row.skill.modified" class="skill-card__modified">{{ t('skills.modified') }}</span>
              <KpIcon name="line_arrow_right" :size="11" class="skill-card__arrow" />
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else-if="skillTab === 'builtin'" :key="'builtin'" class="tabfade">
      <div v-if="builtinVisible.length === 0" class="skill-market__none t-sub">{{ t('skills.noMatch') }}</div>
      <div v-else class="skill-market__group">
        <KpSectionTitle :note="t('skills.builtinGroupNote')">{{ t('skills.builtinGroupTitle') }}</KpSectionTitle>
        <div class="skill-market__grid">
          <article
            v-for="row in builtinVisible"
            :key="skillKey(row)"
            class="skill-card catrow"
            role="button"
            tabindex="0"
            :data-skill="row.skill.name"
            @click="emit('select', row.category, row.skill.name)"
            @keydown.enter.prevent="emit('select', row.category, row.skill.name)"
          >
            <div class="skill-card__head">
              <KpAppIcon :mark="markOf(row.skill.name)" :color="hueOf(row.skill.name)" />
              <span class="skill-card__name" :title="row.skill.name">{{ row.skill.name }}</span>
            </div>

            <p class="skill-card__desc">{{ row.skill.description || t('skills.noDescription') }}</p>

            <div class="skill-card__foot" @click.stop>
              <span class="skill-badge" :class="{ 'is-purple': isOn(row) }">{{ badgeText(row) }}</span>
              <span class="skill-card__spacer" />
              <KpToggle
                :on="row.skill.enabled !== false"
                :disabled="togglingSkills.has(skillKey(row))"
                @update:on="(v: boolean) => handleToggle(row, v)"
              />
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else :key="'installed'" class="tabfade">
      <KpEmptyState
        v-if="installedVisible.length === 0"
        :title="t('skills.installedEmptyTitle')"
        :body="t('skills.installedEmptySub')"
      />
      <div v-else class="skill-market__group">
        <KpSectionTitle :note="t('skills.installedGroupNote')">{{ t('skills.installedGroupTitle') }}</KpSectionTitle>
        <div class="skill-market__grid">
          <article
            v-for="row in installedVisible"
            :key="skillKey(row)"
            class="skill-card catrow"
            role="button"
            tabindex="0"
            :data-skill="row.skill.name"
            @click="emit('select', row.category, row.skill.name)"
            @keydown.enter.prevent="emit('select', row.category, row.skill.name)"
          >
            <div class="skill-card__head">
              <KpAppIcon :mark="markOf(row.skill.name)" :color="hueOf(row.skill.name)" />
              <span class="skill-card__name" :title="row.skill.name">{{ row.skill.name }}</span>
              <KpCornerBtn
                v-if="isOn(row)"
                class="skill-card__corner"
                icon="line_comment"
                :title="t('skills.useSkill')"
                @click="emit('use', row.category, row.skill.name)"
              />
            </div>

            <p class="skill-card__desc">{{ row.skill.description || t('skills.noDescription') }}</p>

            <div class="skill-card__foot" @click.stop>
              <span class="skill-badge" :class="{ 'is-purple': isOn(row) }">{{ badgeText(row) }}</span>
              <span class="skill-card__divider" />
              <KpIcon name="full_star_ai" :size="14" class="skill-card__star" />
              <span class="skill-card__meta">{{ sourceLabel(row) }}</span>
              <span v-if="row.skill.modified" class="skill-card__modified">{{ t('skills.modified') }}</span>
              <KpIcon name="line_arrow_right" :size="11" class="skill-card__arrow" />
              <span class="skill-card__spacer" />
              <KpToggle
                :on="row.skill.enabled !== false"
                :disabled="togglingSkills.has(skillKey(row))"
                @update:on="(v: boolean) => handleToggle(row, v)"
              />
              <KpGhostBtn @click.stop="handleDelete(row)">
                {{ t('skills.uninstall') }}
              </KpGhostBtn>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.pane-notice {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.skill-market__featured-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
  margin: 16px 0 36px;
}



.skill-market__tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
}

.skill-market__cats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 28px;
}

.skill-market__none {
  padding: 48px 0;
  text-align: center;
}

// CatalogGroup: title rule then the shared auto-fill grid.
.skill-market__group {
  margin-bottom: 28px;
}

.skill-market__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
  margin-top: 16px;
}

// ItemCard geometry: flat, hairline inset ring, hover tints the surface.
.skill-card {
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  cursor: pointer;
  transition: background var(--motion-base) var(--ease-std);

  &:hover {
    background: var(--gray-fa);
  }
}

.skill-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.skill-card__name {
  flex: 1;
  min-width: 0;
  font: var(--w-medium) var(--t-16) / 1.6 var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Prototype CornerBtn: 30px circle, hairline ring, 14px glyph, no shadow.

.skill-card__desc {
  flex: 1;
  margin: 0 0 16px;
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  color: var(--fg-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-card__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  row-gap: 8px;
  flex-wrap: wrap;
  cursor: default;
}

// Prototype AgentBadge: 22px pill, purple tint when live, gray otherwise.
.skill-badge {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--gray-f2);
  color: var(--fg-secondary);
  font: var(--w-medium) var(--t-12) / 22px var(--font-cn);
  white-space: nowrap;
}

.skill-badge.is-purple {
  background: var(--hue-purple-bg);
  color: var(--hue-purple);
}

.skill-card__divider {
  width: 1px;
  height: 14px;
  background: var(--divider);
  flex: none;
}

.skill-card__star {
  color: var(--hue-blue);
}

.skill-card__meta {
  min-width: 0;
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-card__modified {
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
  white-space: nowrap;
}

.skill-card__arrow {
  color: var(--fg-disabled);
}

.skill-card__spacer {
  flex: 1;
}
</style>
