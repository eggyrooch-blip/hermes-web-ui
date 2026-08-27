<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HermesProfile } from '@/api/hermes/profiles'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { agentDisplayName, agentKind, isUnnamedGroup } from '@/utils/hermes/agent-identity'

const props = defineProps<{ profile: HermesProfile }>()
const emit = defineEmits<{ open: [name: string]; 'new-task': [name: string] }>()

const { t } = useI18n()

const kind = computed(() => agentKind(props.profile))
const displayName = computed(() => agentDisplayName(props.profile, t('agentsHub.unnamedGroup')))
const pendingGroupName = computed(() => isUnnamedGroup(props.profile))
const kindLabel = computed(() => t(`agentsHub.kind.${kind.value}`))
const modelLabel = computed(() => {
  const model = props.profile.model?.trim()
  return !model || model === '—' || model === '-' ? t('agentsHub.followGlobalModel') : model
})
const description = computed(() => {
  if (kind.value === 'group') return t('agentsHub.feishuGroup')
  return t('agentsHub.noDescription')
})
</script>

<template>
  <div
    class="agent-card"
    role="button"
    tabindex="0"
    :data-testid="`agent-card-${profile.name}`"
    @click="emit('open', profile.name)"
    @keydown.enter.prevent="emit('open', profile.name)"
    @keydown.space.prevent="emit('open', profile.name)"
  >
    <div class="agent-card-top">
      <!-- Group agents render the real Feishu group avatar: the server already
           resolves it (inferFeishuGroupAvatar) and ProfileAvatar handles the
           url type, falling back to a generated one when it cannot be fetched. -->
      <ProfileAvatar class="agent-card-avatar" :name="profile.name" :avatar="profile.avatar" :size="36" />
      <div class="agent-card-heading">
        <div class="agent-card-name-row">
          <span class="agent-card-name" :title="displayName">{{ displayName }}</span>
          <span v-if="pendingGroupName" class="agent-tag hollow">{{ t('agentsHub.groupNamePending') }}</span>
        </div>
        <div class="agent-card-profile" :title="profile.name">{{ profile.name }}</div>
      </div>
    </div>

    <div class="agent-card-desc">{{ description }}</div>

    <div class="agent-card-foot">
      <span class="agent-tag">{{ kindLabel }}</span>
      <span v-if="profile.shareRole" class="agent-tag">{{ profile.shareRole }}</span>
      <span class="agent-tag hollow">{{ modelLabel }}</span>
      <button
        class="agent-card-newtask"
        :data-testid="`agent-new-task-${profile.name}`"
        @click.stop="emit('new-task', profile.name)"
        @keydown.enter.stop
        @keydown.space.stop
      >
        {{ t('agentsHub.newTask') }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 11px;
  padding: 13px 14px;
  cursor: pointer;
  transition: border-color 0.12s, transform 0.12s, box-shadow 0.12s;

  &:hover,
  &:focus-visible {
    border-color: var(--accent-muted);
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.05);
    transform: translateY(-1px);
    outline: none;
  }
}

.agent-card-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.agent-card-heading {
  min-width: 0;
}

.agent-card-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.agent-card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card-profile {
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card-desc {
  margin-top: 9px;
  font-size: 12.5px;
  color: var(--text-muted);
  min-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 11px;
}

.agent-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  white-space: nowrap;

  &.hollow {
    background: transparent;
  }
}

.agent-card-newtask {
  margin-left: auto;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--accent-primary);
  background: var(--accent-primary);
  color: var(--text-on-accent);
  font-size: 12.5px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;

  &:hover {
    background: var(--accent-hover);
  }

  // Keyboard users and touch devices never produce hover, so the action must
  // not be hover-only.
  &:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent-muted);
    outline-offset: 1px;
  }
}

.agent-card:hover .agent-card-newtask,
.agent-card:focus-within .agent-card-newtask {
  opacity: 1;
}

@media (hover: none) {
  .agent-card-newtask {
    opacity: 1;
  }
}
</style>
