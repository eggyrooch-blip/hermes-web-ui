<script setup lang="ts">
import { NButton } from 'naive-ui'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'
import StatCards from '@/components/hermes/usage/StatCards.vue'
import ModelBreakdown from '@/components/hermes/usage/ModelBreakdown.vue'
import DailyTrend from '@/components/hermes/usage/DailyTrend.vue'

const { t } = useI18n()
const usageStore = useUsageStore()

onMounted(() => {
  usageStore.loadSessions()
})
</script>

<template>
  <div class="usage-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('usage.title') }}</h2>
      <NButton size="small" quaternary :loading="usageStore.isLoading" @click="usageStore.loadSessions()">
        {{ t('usage.refresh') }}
      </NButton>
    </header>

    <div class="usage-content">
      <div v-if="usageStore.isLoading && !usageStore.hasData" class="usage-loading">
        {{ t('common.loading') }}
      </div>

      <template v-else-if="usageStore.hasData">
        <StatCards />
        <ModelBreakdown />
        <DailyTrend />
      </template>

      <div v-else class="usage-empty">
        <div class="usage-empty-card">
          <div class="usage-empty-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M4 19V5" />
              <path d="M4 19h16" />
              <path d="M8 16v-5" />
              <path d="M12 16V8" />
              <path d="M16 16v-3" />
            </svg>
          </div>
          <h3>{{ t('usage.noDataTitle') }}</h3>
          <p>{{ t('usage.noDataHint') }}</p>
          <NButton size="small" :loading="usageStore.isLoading" @click="usageStore.loadSessions()">
            {{ t('usage.refresh') }}
          </NButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usage-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.usage-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.usage-loading,
.usage-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 360px;
  padding: 48px 0;
  color: $text-muted;
  font-size: 14px;
}

.usage-empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(100%, 440px);
  padding: 32px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: rgba(var(--accent-primary-rgb), 0.035);
  text-align: center;

  h3 {
    margin: 14px 0 8px;
    color: $text-primary;
    font-size: 17px;
    font-weight: 650;
    letter-spacing: 0;
  }

  p {
    margin: 0 0 18px;
    color: $text-secondary;
    line-height: 1.6;
  }
}

.usage-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 8px;
  color: $accent-primary;
  background: rgba(var(--accent-primary-rgb), 0.1);
}
</style>
