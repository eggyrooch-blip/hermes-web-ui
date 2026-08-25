<script setup lang="ts">
/**
 * Suggested openers for a blank task.
 *
 * Category pills are outlined, not filled: they are a filter, not the primary
 * action. Clicking the active one again clears the filter and returns to the
 * full set. Picking a card drops its text straight into the composer rather
 * than sending it — the user still gets to edit before committing.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import KpIcon from './KpIcon.vue'

const { t } = useI18n()

defineEmits<{ pick: [string] }>()

type Cat = 'doc' | 'data' | 'deck' | 'research' | 'design' | 'daily'

const CATS: { key: Cat; icon: string }[] = [
  { key: 'doc', icon: 'line_content' },
  { key: 'data', icon: 'line_chart' },
  { key: 'deck', icon: 'line_screen' },
  { key: 'research', icon: 'line_search' },
  { key: 'design', icon: 'line_photo_template' },
  { key: 'daily', icon: 'line_timer' },
]

// Three per category, matching the prototype's set.
const STARTERS: { cat: Cat; key: string }[] = [
  { cat: 'doc', key: 'docSummary' },
  { cat: 'data', key: 'dataCompare' },
  { cat: 'deck', key: 'deckMonthly' },
  { cat: 'research', key: 'researchPeers' },
  { cat: 'design', key: 'designEmail' },
  { cat: 'daily', key: 'dailyTriage' },
  { cat: 'doc', key: 'docContract' },
  { cat: 'data', key: 'dataReconcile' },
  { cat: 'deck', key: 'deckOnboarding' },
]

const active = ref<Cat | null>(null)

const visible = computed(() =>
  (active.value ? STARTERS.filter(s => s.cat === active.value) : STARTERS).slice(0, 3),
)

function toggle(cat: Cat) {
  active.value = active.value === cat ? null : cat
}

function iconFor(cat: Cat) {
  return CATS.find(c => c.key === cat)?.icon ?? 'line_content'
}
</script>

<template>
  <div class="kp-starter">
    <div class="kp-starter__cats">
      <button
        v-for="c in CATS"
        :key="c.key"
        class="ab kp-starter__cat"
        :class="{ 'is-on': active === c.key }"
        @click="toggle(c.key)"
      >
        <KpIcon :name="c.icon" :size="20" :color="active === c.key ? undefined : 'var(--fg-aux)'" />
        {{ t(`home.cat.${c.key}`) }}
      </button>
    </div>

    <div class="kp-starter__heading">{{ t('home.suggested') }}</div>

    <div class="startergrid">
      <button
        v-for="s in visible"
        :key="s.key"
        class="ab kp-starter__card"
        @click="$emit('pick', t(`home.starter.${s.key}`))"
      >
        <span class="kp-starter__cardhead">
          <KpIcon :name="iconFor(s.cat)" :size="14" class="kp-starter__cardicon" />
          <span class="kp-starter__cardtitle">{{ t(`home.cat.${s.cat}`) }}</span>
        </span>
        <span class="kp-starter__cardtext">{{ t(`home.starter.${s.key}`) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kp-starter {
  margin-top: 40px;
}

.kp-starter__cats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-bottom: 40px;
}

.kp-starter__cat {
  // §9.1 M step: 36 tall, 14px Medium, 20 side padding (the icon side takes
  // the standard 4 back, so 16 left / 20 right), 20px glyph (font size x 1.5)
  // and a 2px icon gap (§6.2). Outlined at rest — it's a filter, not the
  // action; ink fill with a white glyph when selected.
  height: 36px;
  padding: 0 20px 0 16px;
  border: 0;
  border-radius: var(--r-pill);
  cursor: pointer;
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  color: var(--fg-primary);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  transition: background var(--motion-base) var(--ease-std);

  :deep(.kp-icon-font) {
    color: var(--fg-aux);
  }

  &.is-on {
    background: var(--gray-33);
    box-shadow: none;
    color: var(--white);

    :deep(.kp-icon-font) {
      color: var(--white);
    }
  }
}

.kp-starter__heading {
  font: var(--w-semibold) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
  margin-bottom: 16px;
  text-align: left;
}

// Three columns, dropping to two at 820 (below that each column is under
// 200px) and one at 600.
.startergrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: $breakpoint-starter-2) {
  .startergrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: $breakpoint-starter-1) {
  .startergrid {
    grid-template-columns: 1fr;
  }
}

.kp-starter__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border: 0;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--divider);
  cursor: pointer;
  text-align: left;
  transition: background var(--motion-base) var(--ease-std);

  &:hover {
    background: var(--gray-fa);
  }
}

.kp-starter__cardhead {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.kp-starter__cardicon {
  color: var(--fg-disabled);
}

// The starter text is the content; the category is a label on it. So the
// category is the quiet one and the sentence carries the weight — de-emphasis
// goes through color, not weight (Keep DS keeps to 400/500/600).
.kp-starter__cardtitle {
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);
}

.kp-starter__cardtext {
  font: var(--w-regular) var(--t-14) / var(--lh-read) var(--font-cn);
  color: var(--fg-primary);
}
</style>
