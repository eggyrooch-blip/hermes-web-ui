<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { agentDisplayName, groupAgents } from '@/utils/hermes/agent-identity'

/**
 * Session-level agent selector: pick which agent this task goes to without
 * going back to the sidebar profile switcher.
 *
 * Only rendered on a fresh/empty session — switching agents mid-conversation is
 * deliberately not offered (that is what "new task" is for), so a run can never
 * change owner halfway through.
 */
const { t } = useI18n()
const router = useRouter()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()

const open = ref(false)
const switching = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const activeName = computed(() => profilesStore.activeProfileName || '')
const activeProfile = computed(() =>
  profilesStore.profiles.find(p => p.name === activeName.value)
  ?? { name: activeName.value, active: true, model: '', alias: '' } as any,
)
const activeLabel = computed(() => agentDisplayName(activeProfile.value, t('agentsHub.unnamedGroup')))
const sections = computed(() => groupAgents(profilesStore.profiles).filter(section => section.items.length > 0))

function labelFor(profile: any) {
  return agentDisplayName(profile, t('agentsHub.unnamedGroup'))
}

function toggle() {
  open.value = !open.value
  if (open.value && profilesStore.profiles.length === 0) {
    void profilesStore.fetchProfiles()
  }
}

async function select(name: string) {
  open.value = false
  if (name === activeName.value || switching.value) return
  switching.value = true
  // Locks the composer for the whole swap. Without it, Enter pressed while the
  // profile is already switched but the session is not yet rebound would submit
  // through the OLD session under the NEW profile.
  chatStore.agentSwitching = true
  try {
    if (!await profilesStore.switchProfile(name)) return
    // Rebind the session FIRST, before the slower session-list reload, so the
    // window where profile and session disagree is as short as possible.
    chatStore.newChat({ profile: name })
    // Then keep the chat sidebar's session filter in step; otherwise its list
    // and dropdown keep showing the previous agent.
    if (chatStore.sessionProfileFilter !== null && chatStore.sessionProfileFilter !== name) {
      chatStore.sessionProfileFilter = name
      await chatStore.loadSessions(name)
    }
  } finally {
    chatStore.agentSwitching = false
    switching.value = false
  }
}

function goAddAgent() {
  open.value = false
  void router.push({ name: 'hermes.agents' })
}

function onDocumentClick(event: MouseEvent) {
  if (!open.value) return
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  if (profilesStore.profiles.length === 0) void profilesStore.fetchProfiles()
})
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <div ref="rootRef" class="agent-picker">
    <button
      type="button"
      class="agent-pill"
      :class="{ on: open }"
      data-testid="agent-picker-trigger"
      @click.stop="toggle"
    >
      <ProfileAvatar :name="activeProfile.name" :avatar="activeProfile.avatar" :size="18" />
      <span class="agent-pill-label">{{ activeLabel }}</span>
      <span class="agent-pill-caret">▾</span>
    </button>

    <div v-if="open" class="agent-dropdown" data-testid="agent-picker-dropdown" @click.stop>
      <template v-for="section in sections" :key="section.key">
        <div class="agent-dropdown-head">
          <span>{{ t(`agentsHub.sections.${section.key}`) }}</span>
          <span>{{ section.items.length }}</span>
        </div>
        <button
          v-for="profile in section.items"
          :key="profile.name"
          type="button"
          class="agent-dropdown-item"
          :data-testid="`agent-picker-option-${profile.name}`"
          @click="select(profile.name)"
        >
          <ProfileAvatar :name="profile.name" :avatar="profile.avatar" :size="22" />
          <span class="agent-dropdown-name">{{ labelFor(profile) }}</span>
          <span v-if="profile.name === activeName" class="agent-dropdown-check">✓</span>
        </button>
      </template>

      <div class="agent-dropdown-sep" />
      <button type="button" class="agent-dropdown-item" data-testid="agent-picker-add" @click="goAddAgent">
        <span class="agent-dropdown-add-icon">+</span>
        <span class="agent-dropdown-name">{{ t('agentsHub.addAgent') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.agent-picker {
  position: relative;
  display: inline-flex;
}

.agent-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: none;
  border-radius: 20px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
  max-width: 220px;

  &:hover {
    color: var(--text-primary);
  }

  &.on {
    background: var(--accent-primary);
    color: var(--text-on-accent);
  }
}

.agent-pill-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-pill-caret {
  font-size: 9px;
  opacity: 0.65;
}

.agent-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  // Anchored to the RIGHT edge: the composer places this pill near the send
  // button, so a left-anchored panel ran off the viewport.
  right: 0;
  z-index: 30;
  width: min(288px, calc(100vw - 32px));
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-card);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.14);
  // Declared explicitly: the trigger pill turns white-on-dark when open, and an
  // inherited colour made this whole panel invisible during prototyping.
  color: var(--text-primary);
  text-align: left;
}

.agent-dropdown-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 9px 5px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.agent-dropdown-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--bg-card-hover);
  }
}

.agent-dropdown-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-dropdown-check {
  margin-left: auto;
  font-size: 12px;
}

.agent-dropdown-add-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
}

.agent-dropdown-sep {
  height: 1px;
  margin: 5px 4px;
  background: var(--border-light);
}
</style>
