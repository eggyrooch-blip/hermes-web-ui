<script setup lang="ts">
import type { FeishuLinkPreview } from '@/api/hermes/link-previews'

defineProps<{ preview: FeishuLinkPreview; compact?: boolean }>()
</script>

<template>
  <a
    class="feishu-link-preview-card"
    :class="[`feishu-link-preview-card--${preview.status}`, { 'feishu-link-preview-card--compact': compact }]"
    :href="preview.url"
    target="_blank"
    rel="noopener noreferrer"
  >
    <div class="feishu-link-preview-card__header">
      <span class="feishu-link-preview-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="14" y2="17" />
        </svg>
      </span>
      <span class="feishu-link-preview-card__title">
        {{ preview.title || (preview.status === 'forbidden' ? '需要权限' : preview.type_label || '飞书链接') }}
      </span>
    </div>
    <div v-if="!compact" class="feishu-link-preview-card__body">
      <span>{{ preview.type_label || '飞书链接' }}</span>
      <span class="feishu-link-preview-card__status">
        {{ preview.status === 'resolved' ? '已验证资源' : preview.status === 'forbidden' ? '当前账号需要权限' : '暂无法获取预览' }}
      </span>
    </div>
    <div v-if="!compact" class="feishu-link-preview-card__footer">
      <span>{{ preview.status === 'forbidden' ? '需要权限' : '在飞书中打开' }}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </svg>
    </div>
  </a>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.feishu-link-preview-card {
  display: block;
  width: min(420px, 100%);
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: $radius-md;
  color: $text-primary;
  background: $bg-primary;
  text-decoration: none;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
}

.feishu-link-preview-card__header {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 12px 14px 8px;
}

.feishu-link-preview-card__icon {
  display: grid;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  color: #3370ff;
  background: rgba(51, 112, 255, 0.1);

  svg {
    width: 17px;
    height: 17px;
  }
}

.feishu-link-preview-card__title {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feishu-link-preview-card__body {
  display: flex;
  gap: 8px;
  min-width: 0;
  padding: 0 14px 12px 51px;
  color: $text-secondary;
  font-size: 12px;
  line-height: 18px;
}

.feishu-link-preview-card__status {
  color: $text-muted;

  &::before {
    content: '·';
    margin-right: 8px;
  }
}

.feishu-link-preview-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  border-top: 1px solid $border-color;
  color: #245bdb;
  font-size: 12px;
  font-weight: 500;

  svg {
    width: 14px;
    height: 14px;
  }
}

.feishu-link-preview-card--forbidden {
  border-color: rgba(245, 158, 11, 0.35);

  .feishu-link-preview-card__icon,
  .feishu-link-preview-card__footer {
    color: #b45309;
  }

  .feishu-link-preview-card__icon {
    background: rgba(245, 158, 11, 0.11);
  }
}

.feishu-link-preview-card--compact {
  display: inline-block;
  width: auto;
  max-width: 100%;
  color: #245bdb;
  box-shadow: none;

  .feishu-link-preview-card__header {
    padding: 7px 10px;
  }

  .feishu-link-preview-card__icon {
    flex-basis: 20px;
    width: 20px;
    height: 20px;
    background: transparent;
  }

  .feishu-link-preview-card__title {
    font-weight: 400;
  }
}
</style>
