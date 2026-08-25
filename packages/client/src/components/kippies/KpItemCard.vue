<script setup lang="ts">
/**
 * The card every "pick something" page uses.
 *
 *   head    40 tile/avatar + name (16/500)  ……  a 30px round button, top right
 *   desc    13/1.6, clamped to two lines (`clamp` is adjustable)
 *   foot    badge │ ✦ sub-info ›  …………………  secondary text action at the right
 *
 * Splitting the two intents is the point of this card: clicking the body means
 * "show me what this is", clicking the corner button means "use it, now". With
 * only one of them, one of those two people always pays an extra click. The
 * foot's right end takes secondary actions (uninstall and the like), which is
 * what keeps the corner button's meaning down to exactly one thing.
 *
 * The container is the app's one card step — `--bg`, a hairline inset ring,
 * `--r-card`, padding 20. No second border, no shadow. Card height is driven by
 * the description's `flex: 1`, so cards in a row come out the same height and
 * their feet line up — where the button is has to be predictable across a row.
 */
import { computed, useSlots } from 'vue'
import KpAppIcon from './KpAppIcon.vue'
import KpIcon from './KpIcon.vue'

const props = withDefaults(
  defineProps<{
    name: string
    sub?: string
    desc?: string
    icon?: string
    mark?: string
    color?: string
    /** Rendered as the read-only "✦ text ›" strip. Pass the `meta` slot instead for a live control. */
    meta?: string
    arrow?: boolean
    tags?: string[]
    clamp?: number
    clickable?: boolean
  }>(),
  { clamp: 2, tags: () => [] },
)

defineEmits<{ click: [MouseEvent] }>()

const slots = useSlots()

const hasFoot = computed(
  () => !!(slots.badge || props.meta || slots.meta || props.arrow || slots.action || props.tags.length),
)
</script>

<template>
  <!--
    `itemcard`, not `catrow`: a card's hover is not a row's. A row floats a pale
    ground; a card firms its ring and lightens its ground (§7.2's two levers,
    since §7.1 withholds the shadow). No hover class when it is not clickable —
    offering one on something inert is a lie.
  -->
  <div
    class="kp-item-card"
    :class="{ itemcard: clickable }"
    @click="clickable && $emit('click', $event)"
  >
    <div class="kp-item-card__head">
      <slot name="avatar">
        <KpAppIcon :icon="icon" :mark="mark || name.slice(0, 1)" :color="color" :size="40" />
      </slot>
      <!-- Name over subtitle, stacked — not the subtitle tucked beside the
           name. The right side is spoken for by the action, and the two lines
           are one subject, so stacking reads the hierarchy at a glance. -->
      <span class="kp-item-card__titles">
        <span class="kp-item-card__name">{{ name }}</span>
        <span v-if="sub" class="kp-item-card__sub">{{ sub }}</span>
      </span>
      <slot name="corner" />
    </div>

    <!-- The preview is the real thing, rendered. A spec page that only writes
         "XL 50 / L 48 / M 36" makes the reader draw it in their head. -->
    <div v-if="$slots.preview" class="kp-item-card__preview"><slot name="preview" /></div>

    <p class="kp-item-card__desc" :style="{ '-webkit-line-clamp': clamp }">{{ desc }}</p>

    <div v-if="hasFoot" class="kp-item-card__foot">
      <!-- Keyword tags on `--r-ctl`, not the 2px of a static marker: these are
           the same family as the segment chips (words you could filter by).
           Three at most — a fourth stops describing what the thing is good at
           and starts being keyword stuffing. -->
      <span v-for="tag in tags.slice(0, 3)" :key="tag" class="kp-item-card__tag">{{ tag }}</span>
      <slot name="badge" />
      <span v-if="$slots.badge && (meta || $slots.meta)" class="kp-item-card__sep" />
      <slot name="meta" />
      <template v-if="meta">
        <KpIcon name="full_star_ai" :size="14" class="kp-item-card__star" />
        <span class="kp-item-card__metatext">{{ meta }}</span>
        <KpIcon v-if="arrow" name="line_arrow_right" :size="11" class="kp-item-card__arrow" />
      </template>
      <template v-if="$slots.action">
        <div class="kp-item-card__spacer" />
        <slot name="action" />
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.kp-item-card {
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  margin: 0;

  &.itemcard {
    cursor: pointer;
  }
}

.kp-item-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.kp-item-card__titles {
  flex: 1;
  min-width: 0;
}

.kp-item-card__name {
  display: block;
  font: var(--w-medium) var(--t-16) / var(--lh-multi) var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kp-item-card__sub {
  display: block;
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  color: var(--fg-aux);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kp-item-card__preview {
  background: var(--surface-1);
  border-radius: var(--r-ctl);
  padding: 16px;
  margin-bottom: 16px;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.kp-item-card__desc {
  flex: 1;
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
  color: var(--fg-secondary);
  margin: 0 0 16px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kp-item-card__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  row-gap: 8px;
}

.kp-item-card__tag {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
  white-space: nowrap;
}

.kp-item-card__sep {
  width: 1px;
  height: 14px;
  background: var(--divider);
}

.kp-item-card__star {
  color: var(--hue-blue);
}

.kp-item-card__metatext {
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kp-item-card__arrow {
  color: var(--fg-disabled);
}

.kp-item-card__spacer {
  flex: 1;
}
</style>
