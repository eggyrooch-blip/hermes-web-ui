<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

type SidebarUser = {
  name?: string
  username?: string
  profile?: string
  avatarUrl?: string | null
}

const props = withDefaults(defineProps<{
  user?: SidebarUser | null
  connected?: boolean
  profileFallback?: string | null
  usernameFallback?: string | null
  action?: 'logout' | 'settings'
}>(), {
  user: null,
  connected: false,
  profileFallback: '',
  usernameFallback: '',
  action: 'logout',
})

const emit = defineEmits<{
  action: []
}>()

const { t } = useI18n()

const displayName = computed(() =>
  props.user?.name ||
  props.user?.username ||
  props.usernameFallback ||
  props.profileFallback ||
  'Hermes'
)
const displayProfile = computed(() =>
  props.user?.profile ||
  props.profileFallback ||
  ''
)
const showProfile = computed(() => {
  const profile = displayProfile.value.trim()
  return profile.length > 0 && profile !== displayName.value.trim()
})
const displayInitial = computed(() => {
  const source = displayName.value.trim() || 'H'
  return source.slice(0, 1).toLocaleUpperCase()
})
const actionLabel = computed(() =>
  props.action === 'settings' ? t('sidebar.settings') : t('sidebar.logout')
)
const actionClass = computed(() =>
  props.action === 'settings' ? 'card-settings-button' : 'card-logout-button'
)
</script>

<template>
  <div class="sidebar-user">
    <div class="user-avatar-wrap">
      <img
        v-if="user?.avatarUrl"
        class="user-avatar"
        :src="user.avatarUrl"
        :alt="displayName"
      />
      <div v-else class="user-avatar user-avatar-fallback">{{ displayInitial }}</div>
      <span class="user-status-dot" :class="{ connected }"></span>
    </div>
    <div class="user-meta">
      <span class="user-name" :title="displayName">{{ displayName }}</span>
      <span v-if="showProfile" class="user-profile" :title="displayProfile">{{ displayProfile }}</span>
      <span class="user-connection" :class="{ connected }">
        {{ connected ? t("sidebar.connected") : t("sidebar.disconnected") }}
      </span>
    </div>
    <button
      class="sidebar-user-action"
      :class="actionClass"
      type="button"
      :title="actionLabel"
      :aria-label="actionLabel"
      @click.stop="emit('action')"
    >
      <svg
        v-if="action === 'settings'"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <svg
        v-else
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.06);
}

.user-avatar-wrap {
  position: relative;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: $accent-primary;
  font-size: 14px;
  font-weight: 600;
}

.user-status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border: 2px solid $bg-sidebar;
  border-radius: 50%;
  background: $error;

  &.connected {
    background: $success;
  }
}

.user-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-name,
.user-profile {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-name {
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.user-profile,
.user-connection {
  color: $text-muted;
  font-size: 11px;
}

.user-connection.connected {
  color: $success;
}

.sidebar-user-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: $radius-sm;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  flex: 0 0 28px;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.card-logout-button:hover {
  color: $error;
  background: rgba(var(--error-rgb), 0.08);
}
</style>
