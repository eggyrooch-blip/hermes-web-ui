<script setup lang="ts">
/** 38×22 switch. Knob travel is the only animated property. */
defineProps<{ on?: boolean; disabled?: boolean }>()
defineEmits<{ 'update:on': [boolean] }>()
</script>

<template>
  <button
    class="ab kp-toggle"
    :class="{ 'is-on': on }"
    role="switch"
    :aria-checked="!!on"
    :disabled="disabled"
    @click="$emit('update:on', !on)"
  >
    <span class="kp-toggle__knob" />
  </button>
</template>

<style scoped lang="scss">
.kp-toggle {
  width: 38px;
  height: 22px;
  flex: 0 0 38px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--gray-cc);
  position: relative;
  cursor: pointer;

  // The "on" ground is --hue-purple, NOT --action (green). Green is the status
  // color in this system (running / succeeded / done); a switch expresses "I
  // picked this" — a selected state, not a success. A dozen green switches on
  // one page dilute "green = something is happening", and the green dot on the
  // task that is actually running stops standing out. Purple is the accent, so
  // it is the right register for "selected / mine".
  &.is-on {
    background: var(--hue-purple);
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

.kp-toggle__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: var(--r-pill);
  background: var(--white);
  transition: left var(--motion-base) var(--ease-std);

  .is-on & {
    left: 18px;
  }
}
</style>
