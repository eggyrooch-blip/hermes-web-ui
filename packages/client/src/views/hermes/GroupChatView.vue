<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { isUserMode } from '@/api/client'

const store = useGroupChatStore()
const { t } = useI18n()
const userMode = computed(() => isUserMode())

onMounted(() => {
    if (userMode.value) return
    store.connect()
    store.loadRooms()
})

onUnmounted(() => {
    if (userMode.value) return
    store.disconnect()
})
</script>

<template>
    <div class="group-chat-view">
        <div v-if="userMode" class="group-chat-user-mode">
            <div class="state-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
            </div>
            <h2>{{ t('groupChat.userModeTitle') }}</h2>
            <p>{{ t('groupChat.userModeDescription') }}</p>
        </div>
        <GroupChatPanel v-else />
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.group-chat-view {
    height: calc(100 * var(--vh));
    display: flex;
    flex-direction: column;
}

.group-chat-user-mode {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 32px;
    color: $text-secondary;
    text-align: center;

    .state-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 46px;
        height: 46px;
        border-radius: $radius-md;
        color: $accent-primary;
        background: rgba(var(--accent-primary-rgb), 0.1);
        border: 1px solid rgba(var(--accent-primary-rgb), 0.16);
    }

    h2 {
        margin: 4px 0 0;
        color: $text-primary;
        font-size: 18px;
        font-weight: 650;
    }

    p {
        max-width: 440px;
        margin: 0;
        font-size: 13px;
        line-height: 1.7;
    }
}
</style>
