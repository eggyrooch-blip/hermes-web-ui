<script setup lang="ts">
import { computed } from 'vue'
import multiavatar from '@multiavatar/multiavatar'
import type { ProfileAvatar } from '@/api/hermes/profiles'

const props = withDefaults(defineProps<{
  name: string
  avatar?: ProfileAvatar | null
  size?: number
}>(), {
  size: 24,
})

const fallbackSeed = computed(() => props.name || 'default')
const generatedSvg = computed(() => multiavatar(props.avatar?.seed || fallbackSeed.value))
const imageSrc = computed(() => {
  if (props.avatar?.type === 'image' && props.avatar.dataUrl) return props.avatar.dataUrl
  if (props.avatar?.type === 'url' && props.avatar.url) return props.avatar.url
  return ''
})
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  flexBasis: `${props.size}px`,
}))
</script>

<template>
  <span class="profile-avatar-view" :style="style">
    <img
      v-if="imageSrc"
      class="profile-avatar-image"
      :src="imageSrc"
      alt=""
      draggable="false"
    >
    <span v-else class="profile-avatar-svg" v-html="generatedSvg" />
  </span>
</template>

<style scoped>
.profile-avatar-view {
  display: inline-flex;
  flex: 0 0 auto;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-secondary);
}

.profile-avatar-image,
.profile-avatar-svg,
.profile-avatar-svg :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.profile-avatar-image {
  object-fit: cover;
}
</style>
