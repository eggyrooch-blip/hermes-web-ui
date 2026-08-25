<script setup lang="ts">
/**
 * The round action in a card's top-right corner: 30px, hairline ring, 14px
 * glyph, no shadow like everything else on the card.
 *
 * It carries exactly one meaning — "use this thing, now" — while clicking the
 * card body means "show me what this is". Collapsing the two would force one
 * of the two intents through an extra click.
 *
 * The click stops propagating: the button sits inside a clickable card, and
 * without this, using the thing would also open it.
 */
import KpIcon from './KpIcon.vue'

defineProps<{ icon: string; title?: string }>()

const emit = defineEmits<{ click: [MouseEvent] }>()

function onClick(e: MouseEvent) {
  e.stopPropagation()
  emit('click', e)
}
</script>

<template>
  <button class="ab kp-corner-btn" :title="title" :aria-label="title" @click="onClick">
    <KpIcon :name="icon" :size="14" />
  </button>
</template>

<style scoped lang="scss">
.kp-corner-btn {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--divider);
  color: var(--fg-secondary);
  cursor: pointer;
  display: grid;
  place-items: center;
}
</style>
