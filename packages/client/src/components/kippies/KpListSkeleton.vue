<script setup lang="ts">
/**
 * First-paint skeleton for a list page.
 *
 * The skeleton MUST take the same shape as the real container on that page.
 * Row-shaped pages (market, automation, library) use `.catrow`; the agents page
 * uses the `.itemcard` grid — putting row skeletons under a card page makes the
 * layout re-flow the instant data lands, which is worse than no skeleton.
 *
 *   row    KpCatalogRow geometry — 40px avatar, two text lines, trailing action
 *   card   KpItemCard geometry — padding 20, head row, two description lines
 *   table  the fixed-height rule row (56 tall, padding 0 12); a card skeleton
 *          dropped in here sits 14px short
 *
 * The bar widths cycle through fixed tables rather than random values so the
 * skeleton is stable across re-renders (a re-shuffling skeleton reads as
 * content arriving and then changing).
 */
import { computed } from 'vue'
import KpSkelBar from './KpSkelBar.vue'

const props = withDefaults(
  defineProps<{
    rows?: number
    avatar?: boolean
    action?: boolean
    variant?: 'row' | 'card' | 'table'
    /**
     * Lay `card` out as the app's card wall (auto-fill minmax(300px, 1fr), gap
     * 20) instead of a single column. The prototype's card skeleton is a column
     * because its agents page is; ours are grids, and the skeleton has to take
     * the same shape as the container it stands in for.
     */
    grid?: boolean
  }>(),
  { rows: 4, avatar: true, action: true, variant: 'row' },
)

const W1 = [96, 78, 86, 70, 92, 80]
const W2 = [180, 150, 168, 140, 172, 156]

const items = computed(() =>
  Array.from({ length: props.rows }, (_, i) => ({ w1: W1[i % 6], w2: W2[i % 6] })),
)
</script>

<template>
  <div v-if="variant === 'table'" class="kp-skel kp-skel--table" aria-hidden="true">
    <div v-for="(it, i) in items" :key="i" class="catrow kp-skel__trow">
      <span class="kp-skel__tname"><KpSkelBar :w="it.w1" :h="14" /></span>
      <KpSkelBar :w="Math.round(it.w2 * 0.6)" />
      <span class="shimmer kp-skel__dot" />
      <KpSkelBar :w="36" :h="20" />
    </div>
  </div>

  <div
    v-else-if="variant === 'card'"
    class="kp-skel kp-skel--card"
    :class="{ 'is-grid': grid }"
    aria-hidden="true"
  >
    <div v-for="(it, i) in items" :key="i" class="itemcard kp-skel__card">
      <div class="kp-skel__head">
        <span class="shimmer kp-skel__avatar" />
        <div class="kp-skel__lines">
          <div class="kp-skel__title"><KpSkelBar :w="it.w1" :h="14" /></div>
          <div class="kp-skel__sub"><KpSkelBar :w="it.w2" /></div>
        </div>
      </div>
      <div class="kp-skel__desc"><KpSkelBar w="86%" /></div>
      <div class="kp-skel__desc"><KpSkelBar w="62%" /></div>
    </div>
  </div>

  <div v-else class="kp-skel kp-skel--row" aria-hidden="true">
    <div v-for="(it, i) in items" :key="i" class="catrow kp-skel__row">
      <span v-if="avatar" class="shimmer kp-skel__avatar" />
      <div class="kp-skel__lines">
        <div class="kp-skel__title"><KpSkelBar :w="it.w1" :h="14" /></div>
        <div class="kp-skel__sub"><KpSkelBar :w="it.w2" /></div>
      </div>
      <KpSkelBar v-if="action" :w="56" :h="28" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.kp-skel {
  display: flex;
  flex-direction: column;
}

.kp-skel--row {
  gap: 8px;
}

.kp-skel--card {
  gap: 12px;

  // Matches the card walls in AgentsView / SkillMarketGrid / CredentialsView.
  &.is-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
  }
}

.kp-skel__row,
.kp-skel__trow {
  display: flex;
  align-items: center;
  gap: 12px;
}

// The rule row is fixed-height by design — see the `table` note above.
.kp-skel__trow {
  height: 56px;
  padding: 0 12px;
}

.kp-skel__tname {
  flex: 1;
  min-width: 0;
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
}

.kp-skel__card {
  padding: 20px;
}

.kp-skel__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.kp-skel__avatar {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}

.kp-skel__dot {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}

.kp-skel__lines {
  flex: 1;
  min-width: 0;
}

// The font shorthands are load-bearing, not decoration: each placeholder line
// inherits the metrics of the real line it stands in for, which is what keeps
// the skeleton's height equal to the loaded row's.
.kp-skel__title {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
}

.kp-skel__sub {
  margin-top: 4px;
  font: var(--w-regular) var(--t-12) / var(--lh-multi) var(--font-cn);
}

.kp-skel__desc {
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

// Sibling combinator, not `:first-of-type` — the head is a div too, so it is
// the first of its type and the description would never match.
.kp-skel__head + .kp-skel__desc {
  margin-top: 12px;
}
</style>
