<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AgentCard from '@/components/hermes/agents/AgentCard.vue'
import AgentDetailView from '@/views/hermes/AgentDetailView.vue'
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { groupAgents, type AgentGroupKey } from '@/utils/hermes/agent-identity'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const { t } = useI18n()
const router = useRouter()
const profilesStore = useProfilesStore()
const chatStore = useChatStore()

const showCreateModal = ref(false)
const starting = ref(false)
// Embedded in the chat sidebar surface there is nowhere to navigate to, so the
// detail renders in place and the card list is swapped out.
const openedAgent = ref<string | null>(null)

// Sections come straight off the store list — which is whatever
// /api/hermes/profiles returned for THIS user (already filtered by
// allowedProfileNamesForUser server-side). We never enumerate profiles
// ourselves, so a non-super-admin can only ever see their own.
const sections = computed(() => groupAgents(profilesStore.profiles))
const totalCount = computed(() => profilesStore.profiles.length)

const SECTION_HINTS: Record<AgentGroupKey, string> = {
  mine: 'agentsHub.sections.mineHint',
  group: 'agentsHub.sections.groupHint',
  shared: 'agentsHub.sections.sharedHint',
}

onMounted(() => {
  void profilesStore.fetchProfiles()
})

function openAgent(name: string) {
  if (props.embedded) {
    openedAgent.value = name
    return
  }
  router.push({ name: 'hermes.agentDetail', params: { name } })
}

/**
 * "New task" = bind this agent, then open a fresh session. Switching the active
 * profile is what actually routes the run: every request carries the active
 * profile in X-Hermes-Profile, and newChat stamps it onto the session.
 *
 * newChat (not createSession) on purpose — it also switches to the new session
 * and clears any sticky expert, which a fresh-start gesture must do.
 */
async function startNewTask(name: string) {
  if (starting.value) return
  starting.value = true
  chatStore.agentSwitching = true
  try {
    if (profilesStore.activeProfileName !== name) {
      if (!await profilesStore.switchProfile(name)) return
    }
    // Hand the agent to ChatView via the route and let IT open the new chat.
    // Creating the session here instead would lose it: ChatView's onMounted
    // runs loadSessions(), which replaces sessions[] with the server list and
    // drops any session that was only ever local.
    await router.push({ name: 'hermes.chat', query: { profile: name, new: '1' } })
  } finally {
    chatStore.agentSwitching = false
    starting.value = false
  }
}

function handleCreated() {
  showCreateModal.value = false
  void profilesStore.fetchProfiles()
}
</script>

<template>
  <AgentDetailView
    v-if="props.embedded && openedAgent"
    :agent-name="openedAgent"
    embedded
    @back="openedAgent = null"
  />
  <div v-else class="agents-view" :class="{ 'is-embedded': props.embedded }">
    <header class="page-header">
      <div class="header-heading">
        <h2 class="header-title">{{ t('agentsHub.title') }}</h2>
        <span class="header-subtitle">{{ t('agentsHub.subtitle') }}</span>
      </div>
      <div class="header-actions">
        <button class="agents-primary-btn" data-testid="agents-add" @click="showCreateModal = true">
          + {{ t('agentsHub.addAgent') }}
        </button>
      </div>
    </header>

    <div class="agents-content">
      <NSpin :show="profilesStore.loading && totalCount === 0">
        <div v-if="totalCount === 0 && !profilesStore.loading" class="agents-empty">
          {{ t('agentsHub.empty.all') }}
        </div>

        <section v-for="section in sections" :key="section.key" class="agents-section">
          <div class="agents-section-head">
            <h3 class="agents-section-title">{{ t(`agentsHub.sections.${section.key}`) }}</h3>
            <span class="agents-section-count" :data-testid="`agents-section-count-${section.key}`">
              {{ section.items.length }}
            </span>
            <span class="agents-section-line" />
            <span class="agents-section-hint">{{ t(SECTION_HINTS[section.key]) }}</span>
          </div>

          <div v-if="section.items.length > 0" class="agents-grid">
            <AgentCard
              v-for="profile in section.items"
              :key="profile.name"
              :profile="profile"
              @open="openAgent"
              @new-task="startNewTask"
            />
          </div>
          <!-- An empty "shared with me" is the normal state, and the broker call
               behind it degrades to [] on failure — say so, never error out. -->
          <div v-else-if="section.key === 'shared'" class="agents-section-empty">
            {{ t('agentsHub.empty.shared') }}
          </div>
        </section>
      </NSpin>
    </div>

    <ProfileCreateModal
      v-if="showCreateModal"
      :allow-clone="false"
      credential-notice
      @close="showCreateModal = false"
      @saved="handleCreated"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agents-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

// Hosted inside the chat sidebar surface, which owns the viewport height.
.agents-view.is-embedded {
  height: 100%;
  min-height: 0;
}

.header-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.header-subtitle {
  font-size: 12.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agents-primary-btn {
  padding: 7px 13px;
  border-radius: 8px;
  border: 1px solid var(--accent-primary);
  background: var(--accent-primary);
  color: var(--text-on-accent);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--accent-hover);
  }
}

.agents-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.agents-section + .agents-section {
  margin-top: 22px;
}

.agents-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
}

.agents-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.agents-section-count,
.agents-section-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.agents-section-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agents-section-line {
  flex: 1;
  height: 1px;
  background: var(--border-light);
}

.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 258px), 1fr));
  gap: 11px;
}

.agents-section-empty,
.agents-empty {
  border: 1px dashed var(--border-color);
  border-radius: 11px;
  padding: 22px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
