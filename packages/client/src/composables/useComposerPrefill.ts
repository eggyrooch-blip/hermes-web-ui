import { ref } from 'vue'

/**
 * One-shot handoff from the home starter cards to the composer.
 *
 * The two live in different subtrees (the starter board renders inside the
 * message list's empty slot, the composer is a sibling of the list), so there
 * is no prop path between them and neither owns the other. A module-level ref
 * is the smallest thing that works without threading state through ChatPanel.
 *
 * It is a counter-stamped value rather than a plain string so that picking the
 * same card twice still fires: watching a string alone would see no change.
 */
const pending = ref<{ text: string; stamp: number } | null>(null)
let stamp = 0

export function prefillComposer(text: string) {
  pending.value = { text, stamp: ++stamp }
}

export function useComposerPrefill() {
  return pending
}
