<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui'
import { useFilesStore } from '@/stores/hermes/files'

// `prominent` renders the current location as the page's t-h1 title with the
// prototype LibraryScreen headroom (32px top). FilesPanel keeps the compact
// default so its narrow tool panel is unchanged.
const props = withDefaults(defineProps<{ prominent?: boolean }>(), { prominent: false })

const { t } = useI18n()
const filesStore = useFilesStore()

function handleClick(index: number) {
  if (index < 0) {
    filesStore.navigateTo('')
  } else {
    const path = filesStore.pathSegments.slice(0, index + 1).join('/')
    filesStore.navigateTo(path)
  }
}
</script>

<template>
  <div class="file-breadcrumb" :class="{ 'is-prominent': props.prominent }">
    <NBreadcrumb>
      <NBreadcrumbItem @click="handleClick(-1)">
        {{ t('files.breadcrumbRoot') }}
      </NBreadcrumbItem>
      <NBreadcrumbItem
        v-for="(segment, index) in filesStore.pathSegments"
        :key="index"
        @click="handleClick(index)"
      >
        {{ segment }}
      </NBreadcrumbItem>
    </NBreadcrumb>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// The breadcrumb IS the page title here (prototype puts the current location
// in the title slot), so it gets the headroom of one rather than sitting in a
// 40px strip under a rule.
.file-breadcrumb {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 24px 40px 12px;
  flex-shrink: 0;

  :deep(.n-breadcrumb .n-breadcrumb-item:last-child .n-breadcrumb-item__link) {
    font: var(--w-semibold) var(--t-24) / 1.4 var(--font-cn);
    color: var(--fg-title);
  }

  @media (max-width: $breakpoint-mobile) {
    padding: 12px;
  }

  :deep(.n-breadcrumb-item__link) {
    font: var(--w-regular) var(--t-13) / 1.35 var(--font-cn);
    color: var(--fg-secondary);
    border-radius: var(--r-card-s);
    padding: 2px 6px;
    transition: background var(--motion-fast) var(--ease-std);

    &:hover {
      color: var(--fg-title);
      background: var(--gray-fa);
    }
  }

  :deep(.n-breadcrumb-item:last-child .n-breadcrumb-item__link) {
    color: var(--fg-title);
    font-weight: var(--w-medium);
  }

  :deep(.n-breadcrumb-item__separator) {
    color: var(--fg-aux);
  }
}

// Prototype LibraryScreen title: t-h1 (28px) at 32px top / 20px bottom, so the
// view-tab row sits exactly 20px below it.
.file-breadcrumb.is-prominent {
  padding: 32px 40px 20px;

  :deep(.n-breadcrumb .n-breadcrumb-item:last-child .n-breadcrumb-item__link) {
    font: var(--w-semibold) var(--t-28) / var(--lh-tight) var(--font-cn);
  }

  @media (max-width: $breakpoint-mobile) {
    padding: 16px 12px 12px;
  }
}
</style>
