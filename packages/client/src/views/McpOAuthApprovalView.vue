<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NButton, NCard, NResult } from 'naive-ui'
import { approveMcpOAuth, getMcpOAuthRequest, navigateToOAuthClient, type McpOAuthRequest } from '@/api/mcpOAuth'

const route = useRoute()
const { t } = useI18n()
const loading = ref(false)
const error = ref('')
const metadata = ref<McpOAuthRequest | null>(null)
const requestId = computed(() => typeof route.query.request_id === 'string' ? route.query.request_id.trim() : '')

onMounted(async () => {
  if (!requestId.value) return
  try {
    metadata.value = await getMcpOAuthRequest(requestId.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('mcpOAuthApproval.failed')
  }
})

async function approve() {
  if (!requestId.value || !metadata.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await approveMcpOAuth(requestId.value)
    navigateToOAuthClient(result.redirect_url)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('mcpOAuthApproval.failed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="approval-page">
    <NCard class="approval-card">
      <NResult
        status="info"
        :title="t('mcpOAuthApproval.title')"
        :description="requestId ? t('mcpOAuthApproval.description') : t('mcpOAuthApproval.invalid')"
      >
        <template #footer>
          <dl v-if="metadata" class="approval-details">
            <dt>{{ t('mcpOAuthApproval.client') }}</dt><dd>{{ metadata.client_name }}</dd>
            <dt>{{ t('mcpOAuthApproval.callback') }}</dt><dd>{{ metadata.redirect_origin }}</dd>
            <dt>{{ t('mcpOAuthApproval.scopes') }}</dt><dd>{{ metadata.scopes.join(', ') }}</dd>
          </dl>
          <p v-if="error" class="approval-error" role="alert">{{ error }}</p>
          <NButton
            data-testid="mcp-oauth-approve"
            type="primary"
            :loading="loading"
            :disabled="!requestId || !metadata || loading"
            @click="approve"
          >
            {{ t('mcpOAuthApproval.approve') }}
          </NButton>
        </template>
      </NResult>
    </NCard>
  </main>
</template>

<style scoped lang="scss">
.approval-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-color);
}

.approval-card { max-width: 520px; }
.approval-details { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; text-align: left; }
.approval-details dt { font-weight: 600; }
.approval-details dd { margin: 0; overflow-wrap: anywhere; }
.approval-error { color: var(--error-color); margin: 0 0 16px; }
</style>
