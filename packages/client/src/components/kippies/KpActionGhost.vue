<script setup lang="ts">
/**
 * The outlined small action button — "install" / "uninstall" / "sync", with the
 * four states.
 *
 * ⚠️ Deliberately NOT a stateful KpGhostBtn. KpGhostBtn's geometry (28 tall,
 * 13 side padding, 12px Medium, 0.5px inset ring) is already exactly KpBtn's
 * `s` step; the only difference is that the ring is drawn in `--btn-line`
 * rather than `--divider`. So this is a KpBtn with that one line swapped, not a
 * second button drawn from scratch — one control must not have two
 * implementations, which is the drift this whole pass is undoing.
 *
 * ⚠️ Override the ring ONLY, never the background. The kind's own colours are
 * applied by class and this override comes in as an inline style, so writing
 * `background: transparent` here wins — and it would wipe out the `fail`
 * state's `--danger-bg`, leaving failure as red text on an unchanged ground,
 * which does not catch the eye on a full screen. Idle takes the `line` kind's
 * `--bg`, which on the grounds this button sits on is indistinguishable from
 * the transparent it used to have.
 */
import KpActionBtn from './KpActionBtn.vue'

defineProps<{
  run: () => Promise<unknown>
  okLabel?: string
  failLabel?: string
  optimistic?: () => void
  rollback?: () => void
  done?: () => void
  flip?: () => void
  noOk?: boolean
  icon?: string
  iconEnd?: string
  disabled?: boolean
}>()
</script>

<template>
  <KpActionBtn
    kind="line"
    size="s"
    class="kp-action-ghost"
    :run="run"
    :ok-label="okLabel"
    :fail-label="failLabel"
    :optimistic="optimistic"
    :rollback="rollback"
    :done="done"
    :flip="flip"
    :no-ok="noOk"
    :icon="icon"
    :icon-end="iconEnd"
    :disabled="disabled"
  >
    <slot />
  </KpActionBtn>
</template>

<style scoped lang="scss">
// The secondary-action line (§9.1), at the 0.5pt every hairline here uses.
// Nothing else about the kind is touched — see the warning above.
.kp-action-ghost {
  box-shadow: inset 0 0 0 0.5px var(--btn-line);
}

// `fail` flips the kind to danger, which is a filled tint and carries no ring.
// Leaving the ring on would draw a neutral outline around a red button.
.kp-action-ghost.kp-btn--danger {
  box-shadow: none;
}
</style>
