<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
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
// Prototype AgentPill panel leads with a filter field (autofocused on open).
const query = ref('')

const activeName = computed(() => profilesStore.activeProfileName || '')
const activeProfile = computed(() =>
  profilesStore.profiles.find(p => p.name === activeName.value)
  ?? { name: activeName.value, active: true, model: '', alias: '' } as any,
)
const activeLabel = computed(() => agentDisplayName(activeProfile.value, t('agentsHub.unnamedGroup')))
const sections = computed(() => {
  const q = query.value.trim().toLowerCase()
  return groupAgents(profilesStore.profiles)
    .map(section => ({
      ...section,
      items: q
        ? section.items.filter(p =>
          agentDisplayName(p, t('agentsHub.unnamedGroup')).toLowerCase().includes(q)
          || p.name.toLowerCase().includes(q))
        : section.items,
    }))
    .filter(section => section.items.length > 0)
})

function labelFor(profile: any) {
  return agentDisplayName(profile, t('agentsHub.unnamedGroup'))
}

function toggle() {
  open.value = !open.value
  query.value = ''
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
      <ProfileAvatar :name="activeProfile.name" :avatar="activeProfile.avatar" :size="20" />
      <span class="agent-pill-label">{{ activeLabel }}</span>
      <KpIcon name="line_arrow_right" :size="12" class="agent-pill-caret" :class="{ open }" />
    </button>

    <div v-if="open" class="agent-dropdown" data-testid="agent-picker-dropdown" @click.stop>
      <!-- Prototype panel header: a filter field + a "new agent" icon button. -->
      <div class="agent-dropdown-search">
        <input
          v-model="query"
          class="agent-dropdown-search__input"
          type="text"
          :placeholder="t('agentsHub.title')"
        />
        <button
          type="button"
          class="agent-dropdown-search__add"
          data-testid="agent-picker-add"
          :title="t('agentsHub.addAgent')"
          @click="goAddAgent"
        >
          <KpIcon name="line_add" :size="16" />
        </button>
      </div>

      <template v-for="section in sections" :key="section.key">
        <div class="agent-dropdown-head">
          <span>{{ t(`agentsHub.sections.${section.key}`) }}</span>
        </div>
        <button
          v-for="profile in section.items"
          :key="profile.name"
          type="button"
          class="agent-dropdown-item"
          :data-testid="`agent-picker-option-${profile.name}`"
          @click="select(profile.name)"
        >
          <ProfileAvatar :name="profile.name" :avatar="profile.avatar" :size="26" />
          <span class="agent-dropdown-name">{{ labelFor(profile) }}</span>
          <KpIcon v-if="profile.name === activeName" name="line_check" :size="14" class="agent-dropdown-check" />
        </button>
      </template>
      <div v-if="sections.length === 0" class="agent-dropdown-empty">{{ t('agentsHub.noMatch') }}</div>
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
  height: 28px;
  padding: 0 12px 0 4px;
  border: none;
  border-radius: var(--r-pill);
  background: transparent;
  box-shadow: none;
  color: var(--fg-primary);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  max-width: 220px;
  transition: background var(--motion-fast) var(--ease-std);

  &.on {
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--divider);
  }
}

.agent-pill-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Points up while closed, down once open — the dropdown itself opens
// upward from this pill, so the caret mirrors which way it will unfold.
.agent-pill-caret {
  flex: none;
  color: var(--fg-disabled);
  transform: rotate(-90deg);
  transition: transform var(--motion-fast) var(--ease-std);

  &.open {
    transform: rotate(90deg);
  }
}

// Prototype AgentPill panel: 300 card, 8px padding, led by a search field + a
// "new agent" icon button. Chrome is the hairline ring every prototype popover
// carries — it was a drop shadow here, which made the new-task composer and the
// automation dialog's identical menus look like two different controls.
.agent-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  // Anchored to the LEFT edge like the prototype (the pill sits at the scope
  // row's left), clamped so it can never run off a narrow viewport.
  left: 0;
  z-index: 30;
  width: min(300px, calc(100vw - 32px));
  max-height: 320px;
  overflow-y: auto;
  padding: 8px;
  border: 0;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);
  color: var(--fg-primary);
  text-align: left;
}

.agent-dropdown-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.agent-dropdown-search__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 0;
  outline: none;
  border-radius: var(--r-ctl);
  background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--divider);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);

  &::placeholder {
    color: var(--fg-aux);
  }
}

.agent-dropdown-search__add {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    background: var(--gray-f2);
    color: var(--fg-primary);
  }
}

.agent-dropdown-head {
  display: flex;
  align-items: center;
  padding: 8px 8px 4px;
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-disabled);
}

.agent-dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--r-ctl);
  background: none;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--surface-3);
  }
}

.agent-dropdown-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-dropdown-check {
  flex: none;
  margin-left: auto;
  color: var(--fg-title);
}

.agent-dropdown-empty {
  padding: 10px 8px;
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-disabled);
}
</style>
