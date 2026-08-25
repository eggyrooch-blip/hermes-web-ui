<script setup lang="ts">
/**
 * Create-agent sheet, rebuilt to the prototype's AgentCreateModal: a 520px
 * Keep sheet (头像 picker → 名称 → 加入项目 → 取消/创建 pills) instead of the
 * old Naive card form. Same contract as before — props allowClone /
 * credentialNotice, emits close / saved — so both entry points (agents hub,
 * profiles admin page) keep working, and their tests keep stubbing it.
 *
 * The avatar picker is real: seeds render through multiavatar (same generator
 * ProfileAvatar uses) and the chosen seed is persisted with
 * updateProfileAvatar after the profile is created. The 加入项目 field is gone
 * along with the rest of the projects feature.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import multiavatar from '@multiavatar/multiavatar'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { updateProfileAvatar } from '@/api/hermes/profiles'
import KpIcon from '@/components/kippies/KpIcon.vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  allowClone?: boolean
  /** Agents hub: state up-front that a new agent starts with no credentials. */
  credentialNotice?: boolean
}>(), {
  allowClone: true,
  credentialNotice: false,
})

const emit = defineEmits<{
  close: []
  /** Fires with the created profile's identifier (the slug, not the label). */
  saved: [name: string]
  /**
   * A clone finished, but the copy is missing things: credentials were stripped
   * and/or platforms disabled. Raised to the host because this dialog closes
   * immediately, and the list matters — it tells the user what to re-add.
   */
  'clone-gaps': [summary: string]
}>()

const { t } = useI18n()
/** Validation and creation failures, kept in the dialog. */
const paneError = ref('')
const profilesStore = useProfilesStore()

const loading = ref(false)
const name = ref('')
const clone = ref(false)

// Preset avatar seeds (prototype offers a fixed wall of choices). Any string
// works as a multiavatar seed; these give a stable, varied set.
const AVATAR_SEEDS = [
  'aurora', 'basil', 'comet', 'dahlia', 'ember', 'fjord', 'ginkgo', 'harbor',
  'indigo', 'juniper', 'kestrel', 'lumen', 'meadow', 'nimbus', 'onyx', 'poppy',
]
const selectedSeed = ref(AVATAR_SEEDS[0])
function avatarSvg(seed: string) {
  return multiavatar(seed)
}

const canCreate = computed(() => !!name.value.trim() && !loading.value)

// The prototype's field takes any name — 中文 included. That typed name is the
// DISPLAY name (multitenancy display_label, what the card renders); the
// backend profile identifier is derived from it: ASCII-safe chars pass
// through, and a pure-CJK name falls back to a stable hash slug. Same
// name/label split the Feishu group agents already live on.
function slugify(label: string): string {
  const ascii = label.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (ascii) return ascii.slice(0, 48)
  let hash = 5381
  for (let i = 0; i < label.length; i++) hash = ((hash << 5) + hash + label.charCodeAt(i)) >>> 0
  return `agent-${hash.toString(36)}`
}

function handleNameInput(e: Event) {
  name.value = (e.target as HTMLInputElement).value
}

async function handleSave() {
  const label = name.value.trim()
  if (!label) {
    paneError.value = t('agentsHub.namePlaceholder')
    return
  }
  paneError.value = ''

  loading.value = true
  try {
    const requestedClone = props.allowClone ? clone.value : false
    const res = await profilesStore.createProfile(slugify(label), requestedClone, label)
    if (res.success) {
      // Persist the picked look. Best-effort: a failed avatar write must not
      // fail the creation the user just watched succeed.
      try {
        await updateProfileAvatar(slugify(label), { type: 'generated', seed: selectedSeed.value })
      } catch { /* the generated-by-name fallback still renders */ }
      const stripped = res.strippedCredentials ?? []
      const disabled = res.disabledPlatforms ?? []
      const cfgStripped = res.strippedConfigCredentials ?? []
      if (requestedClone && (stripped.length > 0 || disabled.length > 0 || cfgStripped.length > 0)) {
        const parts: string[] = []
        if (stripped.length > 0) parts.push(t('profiles.cloneStrippedCredentials', { count: stripped.length, list: stripped.join(', ') }))
        if (disabled.length > 0) parts.push(t('profiles.cloneDisabledPlatforms', { count: disabled.length, list: disabled.join(', ') }))
        if (cfgStripped.length > 0) parts.push(t('profiles.cloneStrippedConfigCredentials', { count: cfgStripped.length, list: cfgStripped.join(', ') }))
        // Not a receipt — a list of what the clone did NOT bring over. It has
        // to outlive this dialog and be readable at leisure, so the host keeps
        // it. Plain creation says nothing: the agent appears in the list.
        emit('clone-gaps', parts.join('\n'))
      }
      emit('saved', slugify(label))
    } else {
      paneError.value = res.error || t('profiles.createFailed')
    }
  } finally {
    loading.value = false
  }
}

function handleClose() {
  if (loading.value) return
  emit('close')
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') handleClose()
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
      <p v-if="paneError" class="pane-notice" data-testid="profile-create-error">{{ paneError }}</p>
    <div class="agent-create__scrim" @click="handleClose" />
    <div class="agent-create fadein" role="dialog" aria-modal="true">
      <div class="agent-create__head">
        <span class="agent-create__title">
          {{ credentialNotice ? t('agentsHub.createTitle') : t('profiles.create') }}
        </span>
        <button type="button" class="agent-create__close" :title="t('common.cancel')" @click="handleClose">
          <KpIcon name="line_close" :size="16" />
        </button>
      </div>

      <div class="agent-create__label">{{ t('agentsHub.avatarLabel') }}</div>
      <div class="agent-create__avatars">
        <button
          v-for="seed in AVATAR_SEEDS"
          :key="seed"
          type="button"
          class="agent-create__avatar"
          :class="{ 'is-on': selectedSeed === seed }"
          @click="selectedSeed = seed"
        >
          <span class="agent-create__avatar-svg" v-html="avatarSvg(seed)" />
        </button>
      </div>

      <div class="agent-create__label">{{ t('agentsHub.nameLabel') }}</div>
      <input
        class="agent-create__input"
        type="text"
        :value="name"
        :placeholder="t('agentsHub.namePlaceholder')"
        @input="handleNameInput"
        @keydown.enter="canCreate && handleSave()"
      />
      <p v-if="credentialNotice" class="t-meta agent-create__note">{{ t('agentsHub.addAgentCredentialNotice') }}</p>

      <!-- Profiles admin flow only: clone the current profile's config. -->
      <label v-if="allowClone" class="agent-create__clone">
        <input v-model="clone" type="checkbox" />
        <span>{{ t('profiles.cloneFromCurrent') }}</span>
      </label>
      <p v-if="allowClone && clone" class="t-meta agent-create__note">{{ t('profiles.cloneCleanupNotice') }}</p>

      <div class="agent-create__foot">
        <button type="button" class="agent-create__btn agent-create__btn--line" @click="handleClose">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="agent-create__btn agent-create__btn--dark"
          :disabled="!canCreate"
          @click="handleSave"
        >
          {{ loading ? '…' : t('common.create') }}
        </button>
      </div>
    </div>
  </Teleport>
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

.agent-create__scrim {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(0, 0, 0, 0.4);
}

// Prototype sheet: min(520, vw-32) wide, r-sheet, 24px padding, notification
// shadow, centered.
.agent-create {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--bg);
  border-radius: var(--r-sheet);
  padding: 24px;
  z-index: 91;
  box-shadow: var(--shadow-notification);
  box-sizing: border-box;
}

.agent-create__head {
  display: flex;
  align-items: center;
  margin-bottom: 24px;
}

.agent-create__title {
  flex: 1;
  font: var(--w-semibold) var(--t-18) / 1.6 var(--font-cn);
  color: var(--fg-title);
}

.agent-create__close {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    color: var(--fg-secondary);
    background: var(--gray-fa);
  }
}

.agent-create__label {
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
  margin-bottom: 12px;

  &--tight {
    margin-bottom: 4px;
  }
}

.agent-create__avatars {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 24px;
}

// 44px circle in a 2px halo; the selection ring is the accent blue.
.agent-create__avatar {
  display: inline-flex;
  border: 0;
  padding: 2px;
  border-radius: 9999px;
  background: transparent;
  cursor: pointer;

  &.is-on {
    box-shadow: 0 0 0 2px var(--hue-blue);
  }
}

.agent-create__avatar-svg {
  width: 44px;
  height: 44px;
  border-radius: 9999px;
  overflow: hidden;
  display: block;

  :deep(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
}

.agent-create__input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  margin-bottom: 24px;
  border-radius: var(--r-ctl);
  border: 0;
  outline: none;
  background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--divider);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  box-sizing: border-box;

  &:focus {
    box-shadow: inset 0 0 0 1px var(--fg-disabled);
  }

  &::placeholder {
    color: var(--fg-disabled);
  }
}

.agent-create__note {
  color: var(--fg-aux);
  margin: -12px 0 20px;
  line-height: 1.6;
}

.agent-create__clone {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  cursor: pointer;
}

.agent-create__foot {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

// Prototype footer pills: 36px, 取消 = white + hairline ring, 创建 = ink,
// disabled fades to 0.4.
.agent-create__btn {
  height: 36px;
  border-radius: 9999px;
  padding: 0 16px;
  border: 0;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  white-space: nowrap;

  &--line {
    background: var(--bg);
    color: var(--fg-primary);
    box-shadow: inset 0 0 0 1px var(--divider);

    &:hover {
      background: var(--gray-fa);
    }
  }

  &--dark {
    background: var(--gray-33);
    color: var(--white);

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }
}
</style>
