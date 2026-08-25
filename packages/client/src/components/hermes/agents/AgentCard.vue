<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HermesProfile } from '@/api/hermes/profiles'
import { updateDefaultModelForProfile } from '@/api/hermes/system'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpCornerBtn from '@/components/kippies/KpCornerBtn.vue'
import { useAppStore } from '@/stores/hermes/app'
import { agentDisplayName, agentKind, isUnnamedGroup } from '@/utils/hermes/agent-identity'

const props = defineProps<{ profile: HermesProfile }>()
const emit = defineEmits<{ open: [name: string]; 'new-task': [name: string] }>()

const { t } = useI18n()
/** Save failure for this card. */
const paneError = ref('')
const appStore = useAppStore()

const kind = computed(() => agentKind(props.profile))
const displayName = computed(() => agentDisplayName(props.profile, t('agentsHub.unnamedGroup')))
const pendingGroupName = computed(() => isUnnamedGroup(props.profile))
const kindLabel = computed(() => t(`agentsHub.kind.${kind.value}`))
// Local echo of a just-picked model: the profiles list refresh is async and
// the pick must read back immediately (prototype: card and detail share one
// state, "卡上写 GLM、点进去还是 Auto" is the bug it warns about).
const pickedModel = ref('')
watch(() => props.profile.model, () => { pickedModel.value = '' })
const currentModel = computed(() => pickedModel.value || props.profile.model?.trim() || '')
const modelLabel = computed(() => {
  const model = currentModel.value
  if (!model || model === '—' || model === '-') return t('agentsHub.followGlobalModel')
  return appStore.displayModelName(model)
})
const description = computed(() => {
  if (kind.value === 'group') return t('agentsHub.feishuGroup')
  return t('agentsHub.noDescription')
})

// ---- Model InlinePick (prototype: the footer "✦ 档位 ›" is clickable and
// opens an in-place option list; picking writes THAT agent's model) ----
const pickOpen = ref(false)
const pickBusy = ref(false)
const pickWrap = ref<HTMLElement | null>(null)

interface ModelOption { model: string; provider: string; label: string; providerLabel: string }
const modelOptions = computed<ModelOption[]>(() => {
  // Each agent picks from the catalog ITS profile can actually reach; the
  // aggregate group list only backstops profiles the response did not break
  // out (e.g. before the per-profile scan finishes).
  const profileEntry = appStore.profileModelGroups.find(
    entry => entry.profile === props.profile.name,
  )
  const groups = profileEntry?.groups?.length ? profileEntry.groups : appStore.modelGroups
  const seen = new Set<string>()
  const options: ModelOption[] = []
  for (const group of groups) {
    for (const model of group.models) {
      if (!appStore.isModelVisible(group.provider, model)) continue
      const key = `${group.provider}::${model}`
      if (seen.has(key)) continue
      seen.add(key)
      options.push({
        model,
        provider: group.provider,
        label: appStore.displayModelName(model, group.provider),
        providerLabel: group.label || group.provider,
      })
    }
  }
  return options
})

function closeOnOutside(e: MouseEvent) {
  if (pickWrap.value && !pickWrap.value.contains(e.target as Node)) pickOpen.value = false
}
function closeOnEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') pickOpen.value = false
}
watch(pickOpen, (open) => {
  if (open) {
    document.addEventListener('mousedown', closeOnOutside, true)
    document.addEventListener('keydown', closeOnEsc)
    // The wall of options comes from the shared available-models load; fetch
    // it lazily if this page was opened before App bootstrapped it.
    if (appStore.modelGroups.length === 0) void appStore.loadModels()
  } else {
    document.removeEventListener('mousedown', closeOnOutside, true)
    document.removeEventListener('keydown', closeOnEsc)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeOnOutside, true)
  document.removeEventListener('keydown', closeOnEsc)
})

async function pickModel(option: ModelOption) {
  if (pickBusy.value || option.model === currentModel.value) {
    pickOpen.value = false
    return
  }
  pickBusy.value = true
  try {
    await updateDefaultModelForProfile(props.profile.name, {
      default: option.model,
      provider: option.provider,
    })
    pickedModel.value = option.model
    pickOpen.value = false
  } catch {
    paneError.value = t('common.saveFailed')
  } finally {
    pickBusy.value = false
  }
}
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
    <p v-if="paneError" class="pane-notice" data-testid="agent-card-error">{{ paneError }}</p>
    <div class="agent-card__head">
      <!-- Group agents render the real Feishu group avatar: the server already
           resolves it (inferFeishuGroupAvatar) and ProfileAvatar handles the
           url type, falling back to a generated one when it cannot be fetched. -->
      <ProfileAvatar class="agent-card__avatar" :name="profile.name" :avatar="profile.avatar" :size="40" />
      <!-- Prototype card head: the name alone (no id subtitle — the raw
           profile name stays in the title tooltip and the detail page). -->
      <div class="agent-card__heading">
        <div class="agent-card__name-row">
          <span class="agent-card__name" :title="profile.name">{{ displayName }}</span>
          <span v-if="pendingGroupName" class="agent-badge agent-badge--hollow">{{ t('agentsHub.groupNamePending') }}</span>
        </div>
      </div>
      <!-- Corner action = "chat with it" (prototype ItemCard). Reveal on hover,
           but keep it reachable for keyboard (focus-within) and touch. -->
      <KpCornerBtn
        class="agent-card__corner cardact"
        icon="line_comment"
        :title="t('agentsHub.newTask')"
        :data-testid="`agent-new-task-${profile.name}`"
        @click="emit('new-task', profile.name)"
        @keydown.enter.stop
        @keydown.space.stop
      />
    </div>

    <div class="agent-card__desc">{{ description }}</div>

    <!-- Prototype card floor: the tinted kind pill, a hairline, then the model
         as a plain sparkle row — not a third grey badge competing with it. -->
    <div class="agent-card__foot">
      <span class="agent-badge agent-badge--kind">{{ kindLabel }}</span>
      <span v-if="profile.shareRole" class="agent-badge">{{ profile.shareRole }}</span>
      <span class="agent-card__sep" aria-hidden="true" />
      <!-- InlinePick (prototype): the model band is a live control — click
           opens the option list in place, picking writes THIS agent's model.
           stopPropagation everywhere: the card behind it opens the detail. -->
      <span ref="pickWrap" class="agent-card__pick" @click.stop @keydown.enter.stop @keydown.space.stop>
        <button
          type="button"
          class="agent-card__model"
          :title="t('agentsHub.changeModel')"
          :data-testid="`agent-model-${profile.name}`"
          @click="pickOpen = !pickOpen"
        >
          <KpIcon name="full_star_ai" :size="14" class="agent-card__model-star" />
          {{ modelLabel }}
          <KpIcon
            name="line_arrow_right"
            :size="11"
            class="agent-card__model-caret"
            :class="{ 'is-open': pickOpen }"
          />
        </button>
        <div v-if="pickOpen" class="agent-card__pick-pop">
          <div
            v-for="option in modelOptions"
            :key="`${option.provider}::${option.model}`"
            class="agent-card__pick-option"
            :class="{ 'is-busy': pickBusy }"
            @click="pickModel(option)"
          >
            <div class="agent-card__pick-main">
              <div class="agent-card__pick-name">{{ option.label }}</div>
              <div class="agent-card__pick-desc">{{ option.providerLabel }}</div>
            </div>
            <KpIcon
              v-if="option.model === currentModel"
              name="line_check"
              :size="13"
              class="agent-card__pick-check"
            />
          </div>
          <p v-if="modelOptions.length === 0" class="agent-card__pick-empty">
            {{ t('agentsHub.noModels') }}
          </p>
        </div>
      </span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.pane-notice {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

// ItemCard geometry (prototype): flat card, hairline inset ring, no drop
// shadow. Hover = surface shift + heavier inset ring (design §7.1).
.agent-card {
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--bg);
  // Prototype ItemCard: a 1px ring at rest that does not change on hover
  // (only the background tints).
  box-shadow: inset 0 0 0 0.5px var(--divider);
  cursor: pointer;
  transition: background var(--motion-base) var(--ease-std);

  &:hover,
  &:focus-visible {
    background: var(--gray-fa);
    outline: none;
  }
}

.agent-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.agent-card__heading {
  min-width: 0;
  flex: 1;
}

.agent-card__name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.agent-card__name {
  font: var(--w-medium) var(--t-16) / 1.6 var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Geometry comes from KpCornerBtn; only the states this card adds live here.
// It stays visible rather than hover-revealing — the ring-only circle is quiet
// enough already, and hiding it made the primary way to start a chat invisible
// until you went looking for it.
.agent-card__corner {
  transition: background var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--gray-f7);
  }

  &:focus-visible {
    outline: 2px solid var(--action);
    outline-offset: 1px;
  }
}

// Prototype ItemCard description is 13/1.6, not the 16 of body copy: it is the
// card's supporting line, and at 16 it competes with the 16px name above it.
// This used to ride on `t-body-multi`, which is the 16 step.
.agent-card__desc {
  flex: 1;
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  color: var(--fg-secondary);
  margin-bottom: 16px;
  overflow: hidden;
  /* Prototype ItemCard desc is a 2-line clamp, not a single truncated line. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.agent-card__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  row-gap: 8px;
}

// AgentBadge (prototype): a 20-high square tag — radius 2, 10/500, padding
// 0 4. The kind badge is the one tinted element (purple); every other badge
// stays on the neutral surface.
.agent-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 4px;
  border-radius: var(--r-card-s);
  background: var(--gray-f2);
  color: var(--fg-secondary);
  font: var(--w-medium) var(--t-10) / 1.35 var(--font-cn);
  white-space: nowrap;

  &--hollow {
    background: transparent;
    box-shadow: inset 0 0 0 0.5px var(--divider);
  }

  &--kind {
    background: var(--hue-purple-bg);
    color: var(--hue-purple);
  }
}

.agent-card__sep {
  width: 1px;
  height: 14px;
  background: var(--divider);
  flex: none;
}

// InlinePick trigger (prototype): a 24-high inline row, negative margin so the
// text optically aligns with the badge while keeping a hover target.
.agent-card__pick {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
}

.agent-card__model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  margin: 0 -8px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  min-width: 0;
  font: var(--w-medium) var(--t-13) / 1.35 var(--font-cn);
  color: var(--fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--gray-f7);
  }

  &:focus-visible {
    outline: 2px solid var(--action);
    outline-offset: 1px;
  }
}

// ✦ means "this knob is the model's" (prototype: full_star_ai is hue-blue).
.agent-card__model-star {
  color: var(--hue-blue);
  flex: none;
}

.agent-card__model-caret {
  color: var(--fg-disabled);
  flex: none;
  transition: transform var(--motion-fast) var(--ease-std);

  &.is-open {
    transform: rotate(90deg);
  }
}

// Option sheet opens upward off the trigger (prototype InlinePick): hairline
// ring, no drop shadow.
.agent-card__pick-pop {
  position: absolute;
  left: -8px;
  bottom: 100%;
  margin-bottom: 4px;
  z-index: 40;
  width: min(240px, calc(100vw - 32px));
  max-height: 280px;
  overflow: auto;
  padding: 4px;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider), 0 0 0 0.5px var(--divider);
}

.agent-card__pick-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: var(--r-ctl);
  cursor: pointer;

  &:hover {
    background: var(--gray-f7);
  }

  &.is-busy {
    cursor: default;
    opacity: 0.6;
  }
}

.agent-card__pick-main {
  flex: 1;
  min-width: 0;
}

.agent-card__pick-name {
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  color: var(--fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card__pick-desc {
  font: var(--w-regular) var(--t-12) / 1.6 var(--font-cn);
  color: var(--fg-disabled);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card__pick-check {
  color: var(--keep-green);
  flex: 0 0 13px;
}

.agent-card__pick-empty {
  margin: 0;
  padding: 8px;
  font: var(--w-regular) var(--t-12) / 1.6 var(--font-cn);
  color: var(--fg-disabled);
}
</style>
