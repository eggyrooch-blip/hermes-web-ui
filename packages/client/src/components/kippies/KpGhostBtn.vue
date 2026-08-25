<script setup lang="ts">
/**
 * Outlined small button — the "install" / "uninstall" shape, deliberately not
 * a solid fill.
 *
 * §9.1 S step (28 / 12px Medium / 13 side padding) and §8.2's pill. It used to
 * be 30 tall on `--r-ctl`, which broke both: the ladder only has XL 50 / L 48 /
 * M 36 / S 28 / XS 24, and this family of small controls — segment filters,
 * outlined buttons, inline pickers, canvas toolbars — had each invented its own
 * height, so one role appeared at five sizes across the app.
 *
 * The outline is §9.1's secondary-action line (`#000 @ 20%`, flipping to white
 * in dark via --btn-line), at the 0.5pt every hairline in this system uses.
 */
defineProps<{ disabled?: boolean }>()
defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button class="ab kp-ghost-btn" :disabled="disabled" @click="$emit('click', $event)">
    <slot />
  </button>
</template>

<style scoped lang="scss">
.kp-ghost-btn {
  height: 28px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--btn-line);
  color: var(--fg-primary);
  cursor: pointer;
  white-space: nowrap;
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}
</style>
