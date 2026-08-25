<script setup lang="ts">
/**
 * Standard management-page frame: centered column, title block, slot.
 *
 * `scrollbar-gutter: stable` is required, not an optimization. The column
 * is centered with `margin: 0 auto`; the moment the scrollbar takes layout
 * width (macOS "always show scrollbars", which is also our case since the
 * bar is custom-width), the content box narrows and the centered column
 * shifts sideways — so switching tabs within one page makes the whole
 * layout jump. Reserving the gutter permanently removes that.
 *
 * Headless Chromium uses overlay scrollbars by default and cannot
 * reproduce this, so it will not show up in automated checks.
 */
withDefaults(
  defineProps<{
    title?: string
    sub?: string
    wide?: boolean
  }>(),
  {},
)
</script>

<template>
  <div class="kp-page">
    <div class="kp-page__inner" :class="{ 'is-wide': wide }">
      <div v-if="title" class="kp-page__head">
        <div class="kp-page__headmain">
          <h1 class="t-h1">{{ title }}</h1>
          <p v-if="sub" class="t-sub-multi kp-page__sub">{{ sub }}</p>
        </div>
        <!--
          The right cell has to be flex in BOTH breakpoints. Left as a plain
          block, its inline-flex children lay out on the text baseline: no gap
          between them at all (JSX/templates emit no whitespace node), and
          buttons of identical height sit 2px apart vertically, because
          baseline alignment is not center alignment.
        -->
        <div v-if="$slots.right" class="kp-page__headright">
          <slot name="right" />
        </div>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kp-page {
  flex: 1;
  overflow: auto;
  scrollbar-gutter: stable;
}

.kp-page__inner {
  max-width: 780px;
  margin: 0 auto;
  padding: 48px 40px 64px;

  &.is-wide {
    max-width: 1040px;
  }
}

.kp-page__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}

// Narrow screens must wrap. The right slot usually holds a search field plus a
// button, and the field alone is min(240px, 100vw - 32px) — together they are
// wider than the container on a phone, which squeezes the `flex: 1` title
// column to zero width. The symptom reads as "the title vanished".
@media (max-width: $breakpoint-mobile) {
  .kp-page__head {
    flex-wrap: wrap;
    gap: 12px;
  }

  // Narrow: the actions take a full row of their own, title above them.
  .kp-page__headright {
    flex: 0 0 100%;
  }
}

// `min-width: 0` is what lets the title column actually shrink. Without it a
// flex item floors at its content width, so a long unbreakable title pushes
// the right-hand actions out of the container instead of ellipsising.
.kp-page__headmain {
  flex: 1;
  min-width: 0;
}

.kp-page__headright {
  display: flex;
  align-items: center;
  // flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  flex: 0 0 auto;
}

.kp-page__sub {
  margin-top: 12px;
  max-width: 560px;
}
</style>
