<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { NCheckbox } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import KpIcon from '@/components/kippies/KpIcon.vue'
import { formatChatTimestamp } from '@/utils/chat-timestamp'

const props = withDefaults(defineProps<{
  session: Session
  active: boolean
  pinned: boolean
  canDelete: boolean
  streaming?: boolean
  completedUnread?: boolean
  selectable?: boolean
  selected?: boolean
  showProfile?: boolean
  to?: string
  /**
   * This row is being renamed in place. Owned by the list, not the row: only one
   * row may be editing at a time, so the identity of that row is list state.
   */
  renaming?: boolean
}>(), {
  showProfile: true,
  renaming: false,
})

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  delete: []
  'toggle-select': []
  'rename-commit': [title: string]
  'rename-cancel': []
}>()

const { t, locale } = useI18n()
const appStore = useAppStore()

// Same formatter the message list uses: today collapses to HH:MM, this year adds
// MM/DD, older adds the year — so the common case stays short enough for a
// 248px rail. `lastActiveAt` is when the task last moved, which is what the
// list is sorted by; falling back to updatedAt keeps rows from older payloads
// (no lastActiveAt) from showing a blank.
const timeLabel = computed(() => {
  const at = props.session.lastActiveAt || props.session.updatedAt
  return at ? formatChatTimestamp(at, { locale: locale.value }) : ''
})
const profileName = computed(() => props.session.profile || 'default')
const profileHasModels = computed(() => {
  const profileModels = appStore.profileModelGroups.find(profile => profile.profile === profileName.value)
  return !!profileModels?.groups?.some(group => group.models.length > 0)
})
const profileModelsMissing = computed(() =>
  appStore.profileModelGroups.length > 0 && !profileHasModels.value,
)

// Prototype StateDot: one leading 6px dot carries the whole row status.
//   - run    → keep-green, pulsing (streaming)
//   - error  → danger (needs attention, e.g. missing models)
//   - unread → keep-green, static (finished while unwatched)
//   - done   → neutral grey
const statusKind = computed<'run' | 'error' | 'unread' | 'done'>(() => {
  if (props.streaming) return 'run'
  if (profileModelsMissing.value) return 'error'
  if (props.completedUnread) return 'unread'
  return 'done'
})

// ── Rename in place ───────────────────────────────────────────────────────
// The title becomes writable where it already sits, rather than opening a
// dialog over it. A dialog has three problems here, any one of which is enough:
// it covers the row being renamed (so you cannot see what the neighbours are
// called), it is a second surface to style and keep in step, and the thing you
// are editing is right there on screen already.
const draft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.renaming,
  (on) => {
    if (!on) return
    draft.value = props.session.title || ''
    void nextTick(() => {
      const el = renameInput.value
      if (!el) return
      el.focus()
      // Done here rather than left to the `focus` handler below. The focus is
      // ours, so the follow-up work should not depend on an event we caused
      // being delivered: `focus()` on an already-focused element fires no event
      // at all, and a browser whose document is not focused does not dispatch
      // one either (which is exactly how this was caught). The handler stays for
      // the user-initiated path — tabbing or clicking into the field.
      selectAllFromStart(el)
    })
  },
  { immediate: true },
)

/**
 * Select the whole title, and put the horizontal scroll back to 0.
 *
 * When the title is wider than the field, focusing scrolls to the caret (the
 * end), so what you see is the TAIL of the name with the first words cut off
 * outside the box. Setting the selection direction to "backward" puts the focus
 * end at 0 but does NOT scroll — changing a selection does not re-run the
 * browser's scroll-into-view. Direction and scroll are two separate jobs:
 * direction decides which end the arrow keys continue from, the scroll has to be
 * reset by hand.
 */
function selectAllFromStart(el: HTMLInputElement) {
  try {
    el.setSelectionRange(0, el.value.length, 'backward')
  } catch {
    el.select()
  }
  el.scrollLeft = 0
}

function onRenameFocus(event: FocusEvent) {
  selectAllFromStart(event.target as HTMLInputElement)
}

/**
 * An empty title is treated as "no change" — the name cannot be deleted.
 *
 * Guarded on `renaming` because this also runs on blur, and Escape cancels by
 * clearing the row's editing state: removing a focused field can fire blur on
 * the way out, which would commit the draft Escape just discarded.
 */
function commitRename() {
  if (!props.renaming) return
  const value = draft.value.trim()
  if (value && value !== props.session.title) emit('rename-commit', value)
  else emit('rename-cancel')
}

function onRenameKeydown(event: KeyboardEvent) {
  // The row's own key handling must not see these — Enter would activate it.
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    commitRename()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    // Cancel before the field loses focus, or the blur handler commits the
    // draft we were just told to throw away.
    emit('rename-cancel')
  }
}

let longPressTimer: ReturnType<typeof setTimeout> | null = null
const longPressTriggered = ref(false)

function onTouchStart(e: TouchEvent) {
  longPressTriggered.value = false
  longPressTimer = setTimeout(() => {
    longPressTriggered.value = true
    const touch = e.touches[0]
    const syntheticEvent = new MouseEvent('contextmenu', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
    })
    emit('contextmenu', syntheticEvent)
  }, 500)
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onTouchMove() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function isModifiedNavigation(event?: MouseEvent) {
  return !!event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
}

function onClick(event?: MouseEvent) {
  // While renaming, the row is a text field, not a link to the session.
  if (props.renaming) return
  if (longPressTriggered.value) {
    longPressTriggered.value = false
    event?.preventDefault()
    return
  }
  if (isModifiedNavigation(event)) return
  if (props.to && !props.selectable) event?.preventDefault()
  emit('select')
}

onUnmounted(() => {
  if (longPressTimer) clearTimeout(longPressTimer)
})
</script>

<template>
  <!-- Task row: ONE line — state dot, title (right-edge fade), last-active
       time, pin flag, hover-revealed "⋯". No avatars, no warning badge: the dot
       alone carries status (danger dot = needs attention, tip in title).
       The prototype row had no time; it is here by request. The time yields to
       the "⋯" on hover instead of both crowding the same 248px rail. -->
  <component
    :is="renaming ? 'div' : selectable || !to ? 'button' : 'a'"
    class="session-item"
    :class="{ active, 'batch-mode': selectable, renaming }"
    :aria-current="active ? 'page' : undefined"
    :href="!renaming && !selectable ? to : undefined"
    :type="!renaming && (selectable || !to) ? 'button' : undefined"
    :title="profileModelsMissing ? t('chat.profileMissingModelsTip', { profile: profileName }) : undefined"
    @click="onClick"
    @contextmenu="emit('contextmenu', $event)"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
  >
    <div v-if="selectable" class="session-item-checkbox">
      <NCheckbox :checked="selected" @click.stop="emit('toggle-select')" />
    </div>
    <!-- Renaming clears the rest of the row: the state dot, the pin flag and the
         "⋯". This is not cosmetic. The field stretches to the row's edges with
         negative margins, so anything still holding its place sits ON TOP of the
         pill's rounded ends and punches a hole through them. The fix is not to
         shorten the field to make room: for the seconds you are typing, the row
         IS the field — the dot is reference information and the "⋯" is a way out
         to somewhere else, and neither should be occupying space, let alone
         overlapping the text. (General rule: entering a focused state hides the
         controls in that container which are not part of it, rather than
         shrinking the one control that is.) -->
    <template v-if="renaming">
      <input
        ref="renameInput"
        v-model="draft"
        class="session-item-rename"
        :aria-label="t('chat.renameSession')"
        :placeholder="t('chat.enterNewTitle')"
        @click.stop
        @focus="onRenameFocus"
        @blur="commitRename"
        @keydown="onRenameKeydown"
      />
    </template>
    <template v-else>
      <span
        class="session-item-state session-item-state-dot"
        :class="{
          'is-run': statusKind === 'run',
          pulse: statusKind === 'run',
          'is-error': statusKind === 'error',
          'is-unread': statusKind === 'unread',
        }"
        aria-hidden="true"
      />
      <span class="session-item-title">{{ session.title }}</span>
      <span v-if="timeLabel" class="session-item-time">{{ timeLabel }}</span>
      <KpIcon
        v-if="pinned"
        name="full_flag"
        :size="12"
        class="session-item-state session-item-state-flag"
      />
      <button
        v-if="!selectable"
        class="session-item-menu"
        type="button"
        :title="t('chat.moreOptions')"
        @click.stop.prevent="emit('contextmenu', $event)"
      >
        <KpIcon name="line_more" :size="14" />
      </button>
    </template>
  </component>
</template>

<style scoped>
/* Prototype task row geometry: flex gap 8, 8/12 padding, --r-ctl radius.
   States: selected = --selected-bg, hover = --surface-3 (declared after
   .active so hovering a selected row shows the hover tint, matching the
   prototype's !important hover rule). */
.session-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  flex: 0 0 auto;
  padding: 8px 12px;
  /* The row's height must not depend on which controls it happens to be showing.
     It is normally set by the tallest child — the "⋯" button, at 14px of glyph
     plus 4 above and below = 22 — so hiding that button while renaming would
     drop the row to 36 and shunt every row below it up by 2px.

     This is the TOTAL height, 38, not the content height, 22: the box is
     border-box, so min-height covers the padding (8 + 22 + 8). Writing 22 here
     does nothing at all, because 22 is less than the natural 36. */
  min-height: 38px;
  border: none;
  background: none;
  border-radius: var(--r-ctl);
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  color: var(--fg-secondary);
  transition: background var(--motion-fast) var(--ease-std);
  margin-bottom: 2px;
}

/* The editing skin, which the prototype keeps as one definition for every
   in-place edit. It used to be a 1.5px bright-green outline, which was both ugly
   (a saturated 1.5px ring in a column of 14px grey text is louder than the text
   it contains) and wrong about meaning — green is the STATUS colour here, so
   framing a field in it says "this row succeeded". This is the border language
   the rest of the interface already uses: a 0.5px --divider hairline on --bg,
   the same line as the popovers, cards and chips.

   The hairline is an inset box-shadow rather than a border because a border
   occupies 1px of layout and shifts the text inside it by half a character. An
   inset shadow takes no space, so the text lands exactly where the read-only
   title had it — which is the whole point of editing in place.

   (If a second in-place editing surface ever appears, lift this to a shared
   class; today the session row is the only one, and the file browser's rename
   is a dialog.) */
.session-item-rename {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  border: 0;
  outline: none;
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  /* Size follows the scale of the control around it: this is a row in a list, so
     it takes the XS control rung — 28 tall, pill radius, 12 each side. (The
     radius ladder pairs pill with controls of 28 and up and r2 with inline text,
     so this is a rung, not a second style.) */
  height: 28px;
  border-radius: 9999px;
  padding: 0 12px;
  /* Negative margins are the counterweight that keeps everything else still.
     Vertically, -4 absorbs the 6px by which 28 exceeds the row's 22 of content,
     which together with the min-height above leaves the row at 38 — entering
     rename must not push the rows below it down.
     Horizontally, the right -12 cancels the row's own padding so the pill grows
     out to the row edge instead of pushing the text rightwards. On the left the
     hidden state dot has to be paid back: its 6px plus the 8px flex gap, less
     this field's own 12px of padding, so the caret sits exactly where the
     read-only title started. */
  margin: -4px -12px -4px calc(6px + 8px - 12px);
}

.session-item.active {
  background: var(--selected-bg);
}

/* Not a link while it is a text field. */
.session-item.renaming {
  cursor: default;
}

.session-item:hover {
  background: var(--surface-3);
}

.session-item:hover .session-item-menu {
  opacity: 1;
  pointer-events: auto;
}

.session-item:focus-within .session-item-menu {
  opacity: 1;
  pointer-events: auto;
}

.session-item-title {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
  white-space: nowrap;
  overflow: hidden;
  /* Fade the tail rather than cutting with an ellipsis (prototype rows). */
  mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
}

/* Last-active time: --font-data tabular so the column does not jitter as the
   digits change, --fg-disabled so it reads as reference next to the title.
   Hidden on hover — the "⋯" takes that spot, and on a 248px rail the two
   together squeeze the title. */
.session-item-time {
  flex: 0 0 auto;
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-data);
  color: var(--fg-disabled);
  font-variant-numeric: tabular-nums;
}

.session-item:hover .session-item-time,
.session-item.batch-mode .session-item-time {
  display: none;
}

.session-item-state {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.session-item-state-flag {
  color: var(--keep-green);
}

.session-item-state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  /* Neutral resting colour (idle / done); run + error override below. */
  background: var(--gray-cc);
}

.session-item-state-dot.is-run,
.session-item-state-dot.is-unread {
  background: var(--keep-green);
}

/* Prototype `.pulse`: a running task breathes through opacity, nothing glows. */
.session-item-state-dot.pulse {
  animation: kw-dot-pulse 1.4s var(--ease-std) infinite;
}

@keyframes kw-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.session-item-state-dot.is-error {
  background: var(--danger);
}

/* Prototype TaskMenu trigger: 4px-padded "⋯", revealed on row hover; no hover
   tint of its own — the row already tints. */
.session-item-menu {
  flex-shrink: 0;
  opacity: 0;
  pointer-events: none;
  display: inline-flex;
  padding: 4px;
  border: none;
  background: none;
  color: var(--fg-aux);
  cursor: pointer;
  border-radius: var(--r-ctl);
}

@media (hover: none) {
  .session-item-menu {
    opacity: 0.6;
    pointer-events: auto;
  }
}
</style>
