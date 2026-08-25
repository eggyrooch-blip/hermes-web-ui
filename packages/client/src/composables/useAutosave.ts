import { ref } from 'vue'

/**
 * Autosaving settings controls: apply locally, persist, and put it back if the
 * save is refused.
 *
 * The pattern this replaces was `updateLocal(v); save(v).catch(() => toast())`,
 * which has a correctness problem underneath the cosmetic one: on failure the
 * switch stays in its new position while the server still holds the old value,
 * so the pane quietly disagrees with what was saved. The toast said so and then
 * disappeared, leaving no trace of the divergence.
 *
 * Reverting is both the fix and the report. A switch that flips back is a
 * clearer statement than a line of text at the edge of the screen, and it leaves
 * the pane honest about what is actually stored. The message is kept as well,
 * because a revert alone does not say *why* — but it is resident, so it does not
 * vanish before it has been read.
 *
 *   const { error, run } = useAutosave()
 *   run({
 *     apply: () => store.updateLocal('x', { a: next }),
 *     revert: () => store.updateLocal('x', { a: previous }),
 *     save: () => store.saveSection('x', { a: next }),
 *     failMessage: t('settings.saveFailed'),
 *   })
 */
export interface AutosaveConfig {
  /** Update the UI immediately, before the request settles. */
  apply?: () => void
  /** Put the UI back. Called when `save` rejects — the half nobody writes. */
  revert?: () => void
  /** Persist it. Rejecting is what triggers the revert. */
  save: () => Promise<unknown>
  /** Why it did not save. Shown until the next attempt. */
  failMessage: string
}

export function useAutosave() {
  /** Non-empty when the last attempt was refused. Never self-clears. */
  const error = ref('')

  async function run(config: AutosaveConfig): Promise<boolean> {
    error.value = ''
    config.apply?.()
    try {
      await config.save()
      // Success needs nothing said: the control is already showing the new value.
      return true
    } catch {
      config.revert?.()
      error.value = config.failMessage
      return false
    }
  }

  return { error, run }
}
