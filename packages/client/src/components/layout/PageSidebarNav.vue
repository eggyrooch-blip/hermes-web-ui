<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionSearch } from '@/composables/useSessionSearch'

type ActiveSection = 'chat' | 'history' | 'group' | 'global'

const props = defineProps<{
  active: ActiveSection
  primaryLabel?: string
  hideModeSwitch?: boolean
}>()

const emit = defineEmits<{
  primary: []
}>()

const { t } = useI18n()
const router = useRouter()
const { openSessionSearch } = useSessionSearch()

const primaryText = computed(() => props.primaryLabel || t('chat.newChat'))
const showModeSwitch = computed(() => !props.hideModeSwitch)
const historyButtonLabel = computed(() =>
  props.active === 'history' ? t('chat.sessions') : t('sidebar.history'),
)

function openChat() {
  if (props.active === 'chat') return
  void router.push({ name: 'hermes.chat' })
}

function openHistory() {
  if (props.active === 'history') {
    void router.push({ name: 'hermes.chat' })
    return
  }
  void router.push({ name: 'hermes.history' })
}

function openExpert() {
  void router.push({ name: 'hermes.expert' })
}

function openAutomation() {
  void router.push({ name: 'hermes.jobs' })
}

function openGroupChat() {
  if (props.active === 'group') return
  void router.push({ name: 'hermes.groupChat' })
}

</script>

<template>
  <div class="page-sidebar-nav">
    <div class="page-sidebar-tabs" role="tablist" aria-label="Chat actions">
      <button
        class="page-sidebar-tab"
        type="button"
        @click="emit('primary')"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>{{ primaryText }}</span>
      </button>
      <button class="page-sidebar-tab" type="button" @click="openSessionSearch">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>{{ t('sidebar.search') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        type="button"
        @click="openExpert"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <path d="M12 12l8-4.5" />
          <path d="M12 12v9" />
          <path d="M12 12L4 7.5" />
        </svg>
        <span>{{ t('sidebar.expert') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        type="button"
        @click="openAutomation"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 4h16v5H4z" />
          <path d="M4 15h7v5H4z" />
          <path d="M16 15h4v5h-4z" />
          <path d="M8 9v6" />
          <path d="M18 9v6" />
        </svg>
        <span>{{ t('sidebar.jobs') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'history' }"
        type="button"
        @click="openHistory"
      >
        <svg
          v-if="active === 'history'"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <svg
          v-else
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>{{ historyButtonLabel }}</span>
      </button>
    </div>
    <div v-if="showModeSwitch" class="conversation-switch" role="tablist" aria-label="Conversation type">
      <button
        class="conversation-switch-tab"
        :class="{ active: active === 'chat' || active === 'history' }"
        type="button"
        role="tab"
        :aria-selected="active === 'chat' || active === 'history'"
        @click="openChat"
      >
        {{ t('sidebar.singleChat') }}
      </button>
      <button
        class="conversation-switch-tab"
        :class="{ active: active === 'group' }"
        type="button"
        role="tab"
        :aria-selected="active === 'group'"
        @click="openGroupChat"
      >
        {{ t('sidebar.groupChat') }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover,
  &.active {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.conversation-switch-tab {
  min-width: 0;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}
</style>
