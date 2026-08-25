<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AgentSectionList from '@/components/hermes/agents/AgentSectionList.vue'
import AgentDetailView from '@/views/hermes/AgentDetailView.vue'
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'
import KpPage from '@/components/kippies/KpPage.vue'
import KpBtn from '@/components/kippies/KpBtn.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useChatStore } from '@/stores/hermes/chat'
import { groupAgents } from '@/utils/hermes/agent-identity'

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

function handleCreated(name: string) {
  showCreateModal.value = false
  void profilesStore.fetchProfiles()
  // Prototype: creating lands you on the new agent's detail page ("去「人设」
  // 里给它一份 IDENTITY.md"), not back on the wall of cards.
  openAgent(name)
}
</script>

<template>
  <AgentDetailView
    v-if="props.embedded && openedAgent"
    :agent-name="openedAgent"
    embedded
    @back="openedAgent = null"
  />

  <!-- One frame for both entry points. The prototype shows the same full page
       whether you reach it from the nav rail or open it standalone, so the
       embedded surface must not shrink to a compact header. -->
  <KpPage
    v-else
    wide
    :class="{ 'is-embedded': props.embedded }"
    :title="t('agentsHub.title')"
    :sub="t('agentsHub.subtitle')"
  >
    <template #right>
      <KpBtn kind="dark" icon="line_add" data-testid="agents-add" @click="showCreateModal = true">
        {{ t('agentsHub.addAgent') }}
      </KpBtn>
    </template>

    <AgentSectionList
      :sections="sections"
      :loading="profilesStore.loading"
      :total-count="totalCount"
      @open="openAgent"
      @new-task="startNewTask"
    />
  </KpPage>

  <ProfileCreateModal
    v-if="showCreateModal"
    :allow-clone="false"
    credential-notice
    @close="showCreateModal = false"
    @saved="handleCreated"
  />
</template>

<style scoped lang="scss">
.kp-page.is-embedded {
  height: 100%;
  min-height: 0;
}
</style>
