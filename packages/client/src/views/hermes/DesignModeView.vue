<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import KwLogo from '@/components/kippies/KwLogo.vue'
import KpModeSwitch, { type AppMode } from '@/components/kippies/KpModeSwitch.vue'
import KpNavRow from '@/components/kippies/KpNavRow.vue'
import KpEmptyState from '@/components/kippies/KpEmptyState.vue'

const { t } = useI18n()
const router = useRouter()

const APP_MODE_KEY = 'hermes.appMode'
type DesignTab = 'system' | 'templates'
const tab = ref<DesignTab>('system')

function persistAppMode(mode: AppMode) {
  try {
    localStorage.setItem(APP_MODE_KEY, mode)
  } catch {
    /* storage unavailable */
  }
}

function selectAppMode(mode: AppMode) {
  if (mode === 'design') return
  persistAppMode('work')
  void router.push({ name: 'hermes.chat' })
}

function openBrandChat() {
  persistAppMode('work')
  void router.push({ name: 'hermes.chat' })
}
</script>

<template>
  <div class="design-view">
    <aside class="design-sidebar">
      <div class="page-sidebar-head">
        <a class="page-sidebar-logo" href="/#/hermes/chat" @click.prevent="openBrandChat">
          <KwLogo />
        </a>
      </div>

      <KpModeSwitch mode="design" @update:mode="selectAppMode" />

      <nav class="design-nav" aria-label="Design navigation">
        <KpNavRow
          icon="line_framer"
          :label="t('designMode.designSystem')"
          :active="tab === 'system'"
          @click="tab = 'system'"
        />
        <KpNavRow
          icon="line_library"
          :label="t('designMode.templateLibrary')"
          :active="tab === 'templates'"
          @click="tab = 'templates'"
        />
      </nav>
    </aside>

    <main class="design-main">
      <KpEmptyState :title="t('designMode.title')" :body="t('designMode.body')" />
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.design-view {
  display: flex;
  height: calc(100 * var(--vh));
  background: var(--bg);
}

.design-sidebar {
  flex: 0 0 280px;
  width: 280px;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 16px;
  border-right: 0.5px solid var(--divider);
  overflow-y: auto;
}

.page-sidebar-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 4px 0 0;
  margin-bottom: 8px;
}

.page-sidebar-logo {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  text-decoration: none;
}

.design-nav {
  display: flex;
  flex-direction: column;
}

.design-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .design-sidebar {
    flex-basis: 220px;
    width: 220px;
  }
}
</style>
