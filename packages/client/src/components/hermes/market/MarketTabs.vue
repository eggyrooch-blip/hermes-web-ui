<script setup lang="ts">
/**
 * The market's three sections (专家 / 技能 / 连接器).
 *
 * They used to be three sidebar entries under an "Extensions" fold. That made
 * browsing the market three separate decisions before you had seen anything;
 * the sidebar now has one 市场 row and the split lives here, where you can see
 * all three at once.
 *
 * Each section is still its own view, so switching tabs navigates. It keeps
 * whichever addressing the current page arrived on: the chat shell renders
 * these as `?surface=` panes, while the standalone routes are their own pages.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import KpTabStrip from '@/components/kippies/KpTabStrip.vue'

export type MarketTab = 'expert' | 'skills' | 'connectors'

const props = defineProps<{ active: MarketTab }>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const ROUTE_NAMES: Record<MarketTab, string> = {
  expert: 'hermes.expert',
  skills: 'hermes.skills',
  connectors: 'hermes.connectors',
}

const tabs = computed(() => [
  { key: 'expert', label: t('sidebar.expert') },
  { key: 'skills', label: t('sidebar.skills') },
  { key: 'connectors', label: t('sidebar.connectors') },
])

function pick(key: string) {
  if (key === props.active) return
  const tab = key as MarketTab
  if (route.name === 'hermes.chat') {
    void router.push({ name: 'hermes.chat', query: { ...route.query, surface: tab } })
    return
  }
  void router.push({ name: ROUTE_NAMES[tab] })
}
</script>

<template>
  <KpTabStrip :tabs="tabs" :active="props.active" :mb="16" @pick="pick" />
</template>
