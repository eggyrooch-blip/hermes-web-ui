<script setup lang="ts">
/**
 * Work / Design mode segmented control.
 *
 * Labels stay English: these are *modes*, not features, and the short
 * latin words sit more compactly in the segment.
 *
 * Icons: Work is `line_knowledge` (an open book), Design is `line_framer`.
 * The 495-glyph set has nothing named "palette" — always render a glyph
 * and look at it before committing (`line_all` is a grid, not "work").
 *
 * The label font is --font-latin (Keep Sans), not --font-cn. Work/Design
 * are pure latin words, and the CJK stack renders them with PingFang's
 * latin glyphs — narrower and lighter, which is where "not quite refined"
 * comes from. Keep Sans is the DS's own brand latin face.
 *
 * Size: 14px / weight 400 in BOTH states. Selection is already carried by
 * the white card, its shadow, and the text color; a weight step would be
 * the same statement a third time and only makes the text look fat. This
 * is the token-layer rule too — de-emphasis goes through color, never
 * weight. 16px was tried and overpowers a 223px-wide control.
 *
 * Control height is 32, not 28: plus the 2px outer padding that is 36,
 * matching the nav row height so the whole column lines up.
 *
 * Collapsed it becomes icons rather than two stacked words — "Design" only
 * fits a 64px rail at a size that reads like body copy, not a switch. The
 * selected tint is --selected-bg rather than a white card: in a 40px-wide
 * column a ringed white card looks like it is floating off the rail.
 */
import KpIcon from './KpIcon.vue'

export type AppMode = 'work' | 'design'

// `disabledModes` renders a segment as a "coming soon" affordance: still
// visible so the plane is discoverable, but greyed, `disabled`, and inert —
// clicking it emits nothing. Design ships this way until its plane is ready.
const props = withDefaults(
  defineProps<{ mode: AppMode; collapsed?: boolean; disabledModes?: AppMode[] }>(),
  { disabledModes: () => [] },
)
const emit = defineEmits<{ 'update:mode': [AppMode] }>()

function isDisabled(key: AppMode): boolean {
  return props.disabledModes.includes(key)
}

function select(key: AppMode) {
  if (isDisabled(key)) return
  emit('update:mode', key)
}

const ITEMS: { key: AppMode; label: string; icon: string }[] = [
  { key: 'work', label: 'Work', icon: 'line_knowledge' },
  { key: 'design', label: 'Design', icon: 'line_framer' },
]
</script>

<template>
  <div v-if="collapsed" class="kp-mode kp-mode--rail">
    <button
      v-for="item in ITEMS"
      :key="item.key"
      class="ab kp-mode__railbtn"
      :class="{ 'is-on': mode === item.key, 'is-disabled': isDisabled(item.key) }"
      :title="item.label"
      :disabled="isDisabled(item.key)"
      @click="select(item.key)"
    >
      <KpIcon :name="item.icon" :size="17" />
    </button>
  </div>

  <div v-else class="kp-mode">
    <!-- The expanded state carries the icon too: if the two states used
         different symbols, collapsing would swap the whole thing out and
         the mapping would have to be relearned. -->
    <button
      v-for="item in ITEMS"
      :key="item.key"
      class="ab kp-mode__seg"
      :class="{ 'is-on': mode === item.key, 'is-disabled': isDisabled(item.key) }"
      :title="isDisabled(item.key) ? item.label : undefined"
      :disabled="isDisabled(item.key)"
      @click="select(item.key)"
    >
      <KpIcon :name="item.icon" :size="15" />{{ item.label }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.kp-mode {
  display: flex;
  gap: 2px;
  padding: 2px;
  margin-bottom: 12px;
  background: var(--surface-3);
  border-radius: var(--r-ctl);
}

.kp-mode--rail {
  flex-direction: column;
  gap: 4px;
  padding: 0;
  background: transparent;
}

.kp-mode__seg {
  flex: 1;
  height: 32px;
  border: 0;
  border-radius: var(--r-card-l);
  cursor: pointer;
  background: transparent;
  color: var(--fg-aux);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-latin);
  transition: background var(--motion-base) var(--ease-std),
    color var(--motion-base) var(--ease-std);

  // The selected card is a 0.5px hairline ring, not a drop shadow. §7.1 keeps
  // these surfaces flat — a blurred shadow lifts the segment off the rail,
  // which is the one thing the ring is there to avoid.
  &.is-on {
    background: var(--bg);
    box-shadow: 0 0 0 0.5px var(--divider);
    color: var(--fg-title);
  }

  // Coming-soon: greyed and inert. No hover/press treatment — it must not
  // read as pressable.
  &.is-disabled {
    color: var(--fg-disabled);
    cursor: not-allowed;
    background: transparent;
    box-shadow: none;
  }
}

.kp-mode__railbtn {
  width: 32px;
  height: 32px;
  margin: 0 auto;
  border: 0;
  border-radius: var(--r-ctl);
  cursor: pointer;
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  padding: 0;

  &.is-on {
    background: var(--selected-bg);
    color: var(--fg-title);
  }

  &.is-disabled {
    color: var(--fg-disabled);
    cursor: not-allowed;
    background: transparent;
  }
}
</style>
