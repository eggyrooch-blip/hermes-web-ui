<script setup lang="ts">
/**
 * The composer box — one definition, used by both composers.
 *
 * There are two composer implementations (ChatInput and group chat's
 * GroupChatInput) because they are wired to different stores and carry
 * different controls. What they must NOT differ in is the box: the aurora
 * frame, the section order, and the insets. Those lived twice, so group chat
 * drifted onto the pre-Keep look and had to be dragged back by hand.
 *
 * Anatomy (prototype TaskInputBox): the box itself is 1px of gradient edge and
 * nothing else — every content inset belongs to a section.
 *
 *   .attachment-previews   optional strip, 12/20/0
 *   .input-wrapper         the field: 20 above the caret, 24 each side
 *   .input-top-bar         the tool row: the floor of the box, 16 all round
 *   .input-pillbar         optional scope row under a hairline, 8
 *
 * Sections keep their class names and stay in the host's template — that is
 * where their refs, handlers and host-specific styling live. This component
 * owns their geometry through `:deep()`, which reaches slotted content because
 * the compiled selector is scoped to THIS root and slot content are its DOM
 * descendants.
 *
 * Every section is lifted to `z-index: 5`: `.beamfill` is an absolutely
 * positioned, opaque z0 layer, so any static content inside `.beam` is painted
 * over. That is not theoretical — it is how selected slash pills once vanished.
 */
withDefaults(
  defineProps<{
    /**
     * Follow-up form: once a conversation exists the main composer is demoted —
     * narrower, centred, seated in a pill-shaped halo, with a shorter field.
     * Surfaces with no home state (group chat) leave this off and keep the
     * plain box.
     */
    run?: boolean
  }>(),
  { run: false },
)
</script>

<template>
  <div class="chat-input-area beam" :class="{ 'is-run': run }">
    <!-- Bottom to top: white fill, the neutral hairline that IS the rest state,
         and the gradient stroke that lights on hover/focus. The ring must stay
         below the content layer — it forms its own stacking context, and above
         the content a menu opening upward gets sliced by the gradient line.
         See keep-motion.scss. -->
    <span class="beamfill" aria-hidden="true" />
    <span class="beamedge" aria-hidden="true" />
    <span class="beamring" aria-hidden="true"><i /></span>

    <slot />
  </div>
</template>

<style scoped lang="scss">
.chat-input-area {
  position: relative;
  display: flex;
  flex-direction: column;
  // Prototype TaskInputBox: the beam is padding 1 — just the gradient edge.
  padding: 1px;
  border-top: 0;
  border-radius: var(--r-sheet);
  // Intentional soft drop shadow: the prototype the composer is measured
  // against carries this shadow on the box (an exception to the otherwise
  // flat, no-shadow rule). Referenced by token — the handoff forbids writing
  // shadow values by hand, and --shadow-toast IS 0 4px 16px rgba(0,0,0,.08).
  box-shadow: var(--shadow-toast);
  flex-shrink: 0;
  margin: 0 12px 12px;
}

// Source order in the hosts puts the tool row first (it used to be a strip
// above the field); `order` moves it under the field without relocating the
// markup and the handlers wired into it.
:deep(.attachment-previews) {
  order: 0;
  // The box is only 1px of beam edge, so the strip carries its own inset.
  padding: 12px 20px 0;
  position: relative;
  z-index: 5;
}

:deep(.input-wrapper) {
  order: 1;
  box-sizing: border-box;
  // No ground or border of its own: the fill and the hairline ARE the beam
  // layers on this box, and focus is the ring lighting up. Painting a
  // background here would cover them — that is exactly how an earlier aurora
  // attempt became a dead layer.
  background-color: transparent;
  border: 0;
  padding: 20px 24px 0;
  position: relative;
  z-index: 5;
}

// The tool row sits 16 below the field, not 8. Note this is "add to the top",
// not "take from the bottom": the 16 underneath is the row's distance to the
// hairline over the scope row. Moving 8px down by going 16/8 lands the icons on
// that rule and reads as crowding it rather than as a row with a position — so
// both insets are 16 and the box grows 8 taller (200 → 208 on the home form).
:deep(.input-top-bar) {
  order: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  position: relative;
  z-index: 5;
}

// A thin rule over the scope row, not a gap, so "which agent / which
// workspace" reads as one statement broken into parts.
:deep(.input-pillbar) {
  order: 3;
  padding: 8px;
  border-top: 0.5px solid var(--divider);
  position: relative;
  z-index: 5;
}

// Home/full composer: the field is textarea+40 — 20px above the caret AND 20px
// of breathing room below it before the tool row. The follow-up form drops that
// floor and compresses to its own min-height instead.
.chat-input-area:not(.is-run) :deep(.input-wrapper) {
  padding-bottom: 20px;
}

// Follow-up form: the prototype seats the box inside a pill-shaped surface-1
// halo — 6px of tinted margin all round — which demotes it from "the thing you
// came here to do" to "a way to steer what is already running". Drawn as a
// pseudo-element rather than a wrapper node so nothing lands between this root
// and the beam layers.
.chat-input-area.is-run {
  margin: 12px auto 20px;
  width: calc(100% - 48px);
  max-width: 960px;

  :deep(.input-wrapper) {
    min-height: 80px;
  }

  &::before {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: 9999px;
    background: var(--gray-fa);
    z-index: -1;
    pointer-events: none;
  }
}

// Drag-over: tint only. A border here would shift the field by a pixel
// mid-drag, and the box already has its own edge.
:deep(.input-wrapper.drag-over) {
  background-color: rgba(var(--accent-info-rgb), 0.06);
  border-radius: var(--r-card);
}
</style>
