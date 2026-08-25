<script setup lang="ts">
/**
 * 用量 tab — prototype SettingsScreen usage anatomy: a flat surface-2
 * summary card (headline number + two ground-colored sub-cards), then a
 * 用量明细 section with range pills and a framed table.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin } from 'naive-ui'
import { useUsageStore } from '@/stores/hermes/usage'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'

const { t } = useI18n()
const usage = useUsageStore()

const days = ref(7)
const ranges = computed(() => [
  { days: 1, label: t('settings.usagePane.rangeToday') },
  { days: 7, label: t('settings.usagePane.range7d') },
  { days: 30, label: t('settings.usagePane.range30d') },
])

function setRange(value: number) {
  if (days.value === value) return
  days.value = value
  void usage.loadSessions(value)
}

onMounted(() => {
  void usage.loadSessions(days.value)
})

// Most recent day first, like the prototype's detail table.
const rows = computed(() => usage.dailyUsage.slice().reverse())

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`
}
</script>

<template>
  <section class="usage-settings">
    <KpSectionTitle>{{ t('settings.tabs.usage') }}</KpSectionTitle>

    <div class="usage-card">
      <div class="usage-card__label t-meta">{{ t('settings.usagePane.totalCost') }}</div>
      <div class="usage-card__value">
        <span class="usage-card__star" aria-hidden="true">✦</span>
        <span class="usage-card__number">{{ formatCost(usage.estimatedCost) }}</span>
      </div>
      <div class="usage-card__grid">
        <div class="usage-subcard">
          <div class="usage-subcard__head">
            <span class="t-meta">{{ t('settings.usagePane.inputTokens') }}</span>
            <span class="t-meta usage-subcard__note">{{ t('settings.usagePane.sessions', { count: usage.totalSessions }) }}</span>
          </div>
          <div class="usage-subcard__value">{{ formatTokens(usage.totalInputTokens) }}</div>
        </div>
        <div class="usage-subcard">
          <div class="usage-subcard__head">
            <span class="t-meta">{{ t('settings.usagePane.outputTokens') }}</span>
          </div>
          <div class="usage-subcard__value">{{ formatTokens(usage.totalOutputTokens) }}</div>
        </div>
      </div>
    </div>

    <KpSectionTitle>{{ t('settings.usagePane.detailTitle') }}</KpSectionTitle>
    <div class="usage-toolbar">
      <div class="usage-ranges">
        <span
          v-for="r in ranges"
          :key="r.days"
          class="usage-range"
          :class="{ 'is-active': days === r.days }"
          @click="setRange(r.days)"
        >{{ r.label }}</span>
      </div>
    </div>

    <NSpin :show="usage.isLoading">
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ t('settings.usagePane.colDate') }}</th>
              <th>{{ t('settings.usagePane.colSessions') }}</th>
              <th>{{ t('settings.usagePane.colTokens') }}</th>
              <th class="is-right">{{ t('settings.usagePane.colCost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in rows" :key="d.date">
              <td class="usage-td-date">{{ d.date }}</td>
              <td class="usage-td-sessions">{{ d.sessions }}</td>
              <td><span class="usage-token-pill">{{ formatTokens(d.input_tokens + d.output_tokens) }}</span></td>
              <td class="is-right usage-td-cost">{{ formatCost(d.cost) }}</td>
            </tr>
            <tr v-if="rows.length === 0">
              <td colspan="4" class="usage-td-empty">{{ t('settings.usagePane.empty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
// Prototype usage card: surface-2, r-card, 20 pad, 20 under.
.usage-card {
  background: var(--gray-f7);
  border-radius: var(--r-card);
  padding: 20px;
  margin-bottom: 36px;
}

.usage-card__label {
  color: var(--fg-secondary);
  margin-bottom: 8px;
}

.usage-card__value {
  display: flex;
  align-items: center;
  gap: 6px;
}

.usage-card__star {
  color: #f5a623;
  font-size: 18px;
  line-height: 1;
}

.usage-card__number {
  font: var(--w-semibold) 28px / var(--lh-28) var(--font-latin, var(--font-data));
  color: var(--fg-title);
}

.usage-card__grid {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

// Prototype sub-card: ground color on the surface, r8, 12 pad.
.usage-subcard {
  flex: 1;
  background: var(--bg);
  border-radius: 8px;
  padding: 12px;
}

.usage-subcard__head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.usage-subcard__note {
  color: var(--fg-disabled);
}

.usage-subcard__value {
  font: var(--w-semibold) 18px / var(--lh-18) var(--font-cn);
  color: var(--fg-title);
}

.usage-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}

// Prototype range pills: surface-2 track pad 2, selected = white pill + soft shadow.
.usage-ranges {
  display: flex;
  gap: 4px;
  background: var(--gray-f7);
  border-radius: var(--r-pill);
  padding: 2px;
}

.usage-range {
  padding: 6px 12px;
  border-radius: var(--r-pill);
  cursor: pointer;
  font: var(--w-medium) 13px / var(--lh-1) var(--font-cn);
  color: var(--fg-aux);

  &.is-active {
    background: var(--bg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    color: var(--fg-title);
  }
}

// Prototype detail table: r-card frame on a divider hairline.
.usage-table-wrap {
  border: 0.5px solid var(--divider);
  border-radius: var(--r-card);
  overflow: hidden;
}

.usage-table {
  width: 100%;
  border-collapse: collapse;

  th {
    text-align: left;
    padding: 10px 12px;
    background: var(--gray-f7);
    font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
    color: var(--fg-aux);
  }

  td {
    padding: 12px;
    border-top: 0.5px solid var(--divider);
  }

  .is-right {
    text-align: right;
  }
}

.usage-td-date {
  font: var(--w-regular) 13px / var(--lh-1) var(--font-data);
  color: var(--fg-secondary);
}

.usage-td-sessions {
  font: var(--w-regular) 13px / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
}

.usage-token-pill {
  display: inline-block;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--gray-f2);
  font: var(--w-regular) var(--t-12) / 20px var(--font-data);
  color: var(--fg-secondary);
}

.usage-td-cost {
  font: var(--w-medium) 13px / var(--lh-1) var(--font-data);
  color: var(--fg-primary);
}

.usage-td-empty {
  text-align: center;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
  padding: 24px 12px;
}
</style>
