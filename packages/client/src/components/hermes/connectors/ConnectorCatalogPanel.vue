<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import yaml from 'js-yaml'
import { NAlert, NButton, NInput, NModal, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  connectCatalogConnector,
  deleteCustomConnector,
  fetchCatalogConnectorStatus,
  fetchConnectorCatalog,
  fetchCustomConnectors,
  importCustomConnectors,
  type ConnectorCatalogEntry,
  type ConnectorCatalogView,
  type ConnectorVerdict,
  type CustomConnectorEntry,
} from '@/api/connectorCatalog'
import { pollFeishuUatSession, startSkillCredentialAuth } from '@/api/skillCredentials'

const props = defineProps<{ profile?: string }>()
const { t } = useI18n()
const message = useMessage()
const view = ref<ConnectorCatalogView>('source')
const query = ref('')
const verdict = ref<ConnectorVerdict | ''>('')
const rows = ref<ConnectorCatalogEntry[]>([])
const custom = ref<CustomConnectorEntry[]>([])
const loading = ref(false)
const error = ref('')
const modal = ref(false)
const detailModal = ref(false)
const selected = ref<ConnectorCatalogEntry | null>(null)
const actionLoading = ref(false)
const actionError = ref('')
const credentialValues = ref<Record<string, string>>({})
const raw = ref('')
const importError = ref('')
const importing = ref(false)
const deleting = ref('')
const failedIcons = ref(new Set<string>())
const ownerProfile = ref('')
const ownerSubject = ref('')
let loadSeq = 0

const verdictOptions = computed(() => [
  { label: t('mcp.toolsModeAll'), value: '' },
  ...(['pass', 'needs_auth', 'needs_sandbox', 'incompatible', 'rejected'] as ConnectorVerdict[])
    .map(value => ({ label: value, value })),
])

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === '::1') return true
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host))) return true
  const octets = host.split('.').map(Number)
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && (
    octets[0] === 10 || octets[0] === 127 ||
    octets[0] === 169 && octets[1] === 254 ||
    octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
  )
}

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    const text = [row.name, row.product, row.catalog_id, row.canonical_key, ...(row.products || [])]
      .filter(Boolean).join(' ').toLowerCase()
    const stateMatch = !verdict.value || row.final_verdict === verdict.value || Boolean(row.verdicts?.[verdict.value])
    return (!needle || text.includes(needle)) && stateMatch
  })
})

const preview = computed(() => {
  if (!raw.value.trim()) return []
  try {
    if (raw.value.length > 64 * 1024) throw new Error(t('mcp.invalidConfig'))
    const loaded = yaml.load(raw.value, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error(t('mcp.invalidConfig'))
    const servers = (loaded.mcpServers || loaded.mcp_servers || loaded) as Record<string, unknown>
    if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !Object.keys(servers).length) {
      throw new Error(t('mcp.invalidConfig'))
    }
    return Object.entries(servers).map(([name, value]) => {
      const spec = value as Record<string, unknown>
      if (!spec || typeof spec !== 'object') return { name, ok: false, reason: t('mcp.invalidServerConfig') }
      if ('command' in spec || 'args' in spec) return { name, ok: false, reason: `command/args — ${t('mcp.invalidServerConfig')}` }
      const url = String(spec.url || '')
      let endpoint: URL
      try { endpoint = new URL(url) } catch { return { name, ok: false, reason: `HTTPS — ${t('mcp.invalidServerConfig')}` } }
      if (endpoint.protocol !== 'https:' || isPrivateHostname(endpoint.hostname)) {
        return { name, ok: false, reason: `HTTPS public host — ${t('mcp.invalidServerConfig')}` }
      }
      const type = String(spec.type || 'streamableHttp')
      const normalized = type.toLowerCase().replace(/[-_ ]/g, '')
      if (!['http', 'streamablehttp', 'sse'].includes(normalized)) {
        return { name, ok: false, reason: `HTTP/SSE — ${t('mcp.invalidServerConfig')}` }
      }
      return { name, ok: true, reason: type }
    })
  } catch (err: any) {
    return [{ name: '', ok: false, reason: err?.message || t('mcp.invalidConfig') }]
  }
})

function stateLabel(row: ConnectorCatalogEntry) {
  if (installation(row)) return row.action?.status === 'ready' ? t('mcp.connected') : t('mcp.disconnected')
  if (row.action?.auth_flow === 'feishu_device_flow' && row.action.status === 'ready') return t('mcp.connected')
  if (row.final_verdict) return row.final_verdict
  return Object.entries(row.verdicts || {}).map(([key, count]) => `${key} ${count}`).join(' · ')
}

function installation(row: ConnectorCatalogEntry | null) {
  const id = row?.action?.connector_id
  return id ? custom.value.find(item => item.connector_id === id) : undefined
}

function openDetails(row: ConnectorCatalogEntry) {
  selected.value = row
  actionError.value = ''
  credentialValues.value = Object.fromEntries((row.action?.fields || []).map(field => [field, '']))
  detailModal.value = true
}

function primaryLabel(row: ConnectorCatalogEntry) {
  if (installation(row) || row.action?.kind === 'revoke') return t('mcp.remove')
  return row.action?.kind === 'connect' ? t('mcp.add') : t('common.confirm')
}

async function runPrimaryAction() {
  const row = selected.value
  if (!row || actionLoading.value) return
  if (row.action?.kind === 'choose_source') {
    query.value = row.canonical_key
    view.value = 'source'
    detailModal.value = false
    return
  }
  const current = installation(row)
  const requestedProfile = props.profile
  const expectedProfile = ownerProfile.value
  const expectedSubject = ownerSubject.value
  let credentialSubmitted = false
  actionLoading.value = true
  actionError.value = ''
  try {
    if (row.action?.auth_flow === 'feishu_device_flow' && row.action.kind === 'revoke' && row.row_key) {
      await connectCatalogConnector(row.row_key)
    } else if (row.action?.auth_flow === 'feishu_device_flow') {
      const result = await startSkillCredentialAuth('lark-cli', props.profile)
      const verification = new URL(String(result.verification_uri || ''))
      if (verification.protocol !== 'https:' || !result.session_id || !window.open(
        verification.toString(), '_blank', 'noopener,noreferrer',
      )) throw new Error(t('mcp.addFailed'))
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 2500))
        if (props.profile !== requestedProfile) return
        const status = await pollFeishuUatSession(result.session_id, props.profile)
        if (status.status === 'success') break
        if (status.status !== 'pending' || attempt === 119) {
          throw new Error(status.error || t('mcp.addFailed'))
        }
      }
      credentialSubmitted = true
    } else if (current) {
      await deleteCustomConnector(current.connector_id)
      custom.value = custom.value.filter(item => item.connector_id !== current.connector_id)
    } else if (row.row_key && ['connect', 'authorize', 'authorize_cli', 'install_sandbox'].includes(row.action?.kind || '') && row.action?.available) {
      const fields = row.action.fields?.length ? credentialValues.value : undefined
      if (fields && Object.values(fields).some(value => !value.trim())) {
        actionError.value = t('mcp.invalidConfig')
        return
      }
      const result = fields
        ? await connectCatalogConnector(row.row_key, fields)
        : await connectCatalogConnector(row.row_key)
      if ('authorization_url' in result) {
        if (result.profile_name !== expectedProfile || result.subject_id !== expectedSubject) {
          throw new Error(t('mcp.loadFailed'))
        }
        const authorization = new URL(result.authorization_url)
        if (authorization.protocol !== 'https:' || !window.open(
          authorization.toString(), '_blank', 'noopener,noreferrer',
        )) throw new Error(t('mcp.addFailed'))
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 2500))
          if (props.profile !== requestedProfile) return
          if (result.status === 'authorizing') {
            const status = await fetchCatalogConnectorStatus(row.row_key)
            if (status.profile_name !== expectedProfile || status.subject_id !== expectedSubject) {
              throw new Error(t('mcp.loadFailed'))
            }
            if (status.ready) break
          } else {
            const installations = await fetchCustomConnectors()
            if (installations.profile_name !== expectedProfile || installations.subject_id !== expectedSubject) {
              throw new Error(t('mcp.loadFailed'))
            }
            if (installations.connectors.some(item => item.name === row.action?.installation_name && item.state === 'ready')) break
          }
          if (attempt === 119) throw new Error(t('mcp.addFailed'))
        }
      }
      credentialSubmitted = Boolean(fields)
      credentialValues.value = {}
    } else {
      return
    }
    if (props.profile !== requestedProfile) return
    const [catalog, installations] = await Promise.all([
      fetchConnectorCatalog(view.value), fetchCustomConnectors(),
    ])
    if (catalog.profile_name !== expectedProfile || catalog.subject_id !== expectedSubject
      || installations.profile_name !== expectedProfile || installations.subject_id !== expectedSubject) {
      throw new Error(t('mcp.loadFailed'))
    }
    rows.value = catalog.connectors
    custom.value = installations.connectors
    selected.value = rows.value.find(item => iconKey(item) === iconKey(row)) || null
    if (credentialSubmitted) {
      detailModal.value = false
      selected.value = null
    }
    message.success(t('common.saved'))
  } catch (err: any) {
    actionError.value = err?.message || t('mcp.addFailed')
  } finally {
    actionLoading.value = false
  }
}

function downloadLabel(row: ConnectorCatalogEntry) {
  return typeof row.download_count === 'number'
    ? `↓ ${row.download_count.toLocaleString()}`
    : `↓ ${t('mcp.downloadUnknown')}`
}

async function load() {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const [catalog, installations] = await Promise.all([
      fetchConnectorCatalog(view.value),
      fetchCustomConnectors(),
    ])
    if (seq !== loadSeq) return
    rows.value = catalog.connectors
    custom.value = installations.connectors
    ownerProfile.value = catalog.profile_name
    ownerSubject.value = catalog.subject_id
  } catch (err: any) {
    if (seq === loadSeq) error.value = err?.message || t('mcp.loadFailed')
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function confirmImport() {
  if (importing.value || !preview.value.length || preview.value.some(item => !item.ok)) return
  importing.value = true
  importError.value = ''
  try {
    const result = await importCustomConnectors(raw.value)
    custom.value = result.connectors
    raw.value = ''
    modal.value = false
    message.success(t('common.saved'))
  } catch (err: any) {
    importError.value = err?.message || t('mcp.addFailed')
  } finally {
    importing.value = false
  }
}

function iconKey(row: ConnectorCatalogEntry) {
  return row.row_key || row.canonical_key
}

function markIconFailed(row: ConnectorCatalogEntry) {
  failedIcons.value = new Set([...failedIcons.value, iconKey(row)])
}

async function remove(item: CustomConnectorEntry) {
  deleting.value = item.connector_id
  try {
    await deleteCustomConnector(item.connector_id)
    custom.value = custom.value.filter(row => row.connector_id !== item.connector_id)
  } catch (err: any) {
    message.error(err?.message || t('common.deleteFailed'))
  } finally {
    deleting.value = ''
  }
}

defineExpose({ refresh: load })

watch(() => [props.profile, view.value], () => void load(), { immediate: true })
</script>

<template>
  <section class="catalog-panel" data-testid="connector-catalog">
    <div class="catalog-heading">
      <div>
        <h3>{{ t('sidebar.connectors') }}</h3>
      </div>
      <NButton size="small" type="primary" data-testid="custom-connector-open" @click="modal = true">
        {{ t('mcp.addServer') }}
      </NButton>
    </div>
    <div class="catalog-controls">
      <NInput v-model:value="query" clearable :placeholder="t('mcp.searchPlaceholder')" />
      <NSelect v-model:value="verdict" :options="verdictOptions" />
      <div class="view-switch" role="group" aria-label="Catalog view">
        <NButton size="small" :type="view === 'source' ? 'primary' : 'default'" @click="view = 'source'">642</NButton>
        <NButton size="small" :type="view === 'canonical' ? 'primary' : 'default'" @click="view = 'canonical'">330</NButton>
      </div>
      <span class="result-count">{{ filtered.length }}</span>
    </div>

    <NAlert v-if="error" type="warning" :show-icon="false">{{ error }}</NAlert>
    <NSpin :show="loading">
      <div v-if="custom.length" class="custom-list">
        <article v-for="item in custom" :key="item.connector_id" class="custom-row">
          <div><strong>{{ item.name }}</strong><span>{{ item.transport }} · {{ item.state }}</span></div>
          <NButton size="tiny" secondary :loading="deleting === item.connector_id" @click="remove(item)">
            {{ t('mcp.remove') }}
          </NButton>
        </article>
      </div>
      <div class="catalog-grid">
        <article v-for="row in filtered" :key="row.row_key || row.canonical_key" class="catalog-card"
          role="button" tabindex="0" @click="openDetails(row)"
          @keydown.enter.prevent="openDetails(row)" @keydown.space.prevent="openDetails(row)">
          <img v-if="row.icon?.url && !failedIcons.has(iconKey(row))" :src="row.icon.url" alt="" loading="lazy" @error="markIconFailed(row)" />
          <div v-else class="catalog-fallback" aria-hidden="true">{{ (row.name || row.canonical_key).slice(0, 1).toUpperCase() }}</div>
          <div class="catalog-copy">
            <div class="catalog-title"><strong>{{ row.name || row.canonical_key }}</strong><span>{{ stateLabel(row) }}</span></div>
            <p>{{ row.product || (row.products || []).join(' · ') }}</p>
            <p>{{ row.transport || `${row.source_row_count || 0} sources` }} · {{ downloadLabel(row) }}</p>
            <p class="catalog-description">{{ row.description }}</p>
          </div>
        </article>
      </div>
    </NSpin>

    <NModal v-model:show="detailModal" preset="card" style="max-width: 560px" :title="selected?.name || selected?.canonical_key">
      <div v-if="selected" class="connector-detail">
        <p><strong>{{ stateLabel(selected) }}</strong></p>
        <p>{{ selected.description }}</p>
        <p v-if="selected.next_action">{{ selected.next_action }}</p>
        <label v-for="field in selected.action?.fields || []" :key="field"
          class="credential-field" :data-testid="`catalog-credential-${field}`">
          <span>{{ field }}</span>
          <NInput v-model:value="credentialValues[field]" type="password" show-password-on="click" :placeholder="field" />
        </label>
        <NAlert v-if="actionError" type="warning" :show-icon="false">{{ actionError }}</NAlert>
      </div>
      <template #footer>
        <div class="modal-actions">
          <NButton @click="detailModal = false">{{ t('mcp.cancel') }}</NButton>
          <NButton v-if="selected && (installation(selected) || selected.action?.available)"
            type="primary" data-testid="catalog-primary-action" :loading="actionLoading" @click="runPrimaryAction">
            {{ primaryLabel(selected) }}
          </NButton>
        </div>
      </template>
    </NModal>

    <NModal v-model:show="modal" preset="card" style="max-width: 680px" :title="t('mcp.addTitle')">
      <p class="import-hint">JSON / YAML · HTTPS Streamable HTTP / SSE</p>
      <NInput v-model:value="raw" type="textarea" :rows="12" placeholder='{"mcpServers":{"demo":{"type":"streamableHttp","url":"https://example.com/mcp"}}}' />
      <div v-if="preview.length" class="import-preview">
        <div v-for="item in preview" :key="item.name || item.reason" :class="item.ok ? 'ok' : 'denied'">
          <strong>{{ item.name || t('mcp.invalidConfig') }}</strong><span>{{ item.reason }}</span>
        </div>
      </div>
      <NAlert v-if="importError" type="warning" :show-icon="false">{{ importError }}</NAlert>
      <template #footer>
        <div class="modal-actions">
          <NButton @click="modal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="importing" :disabled="importing || !preview.length || preview.some(item => !item.ok)" @click="confirmImport">
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;
.catalog-panel { padding: 0 20px 24px; }
.catalog-heading, .catalog-controls, .catalog-title, .custom-row, .modal-actions { display: flex; align-items: center; }
.catalog-heading { justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.catalog-heading h3 { margin: 0; color: $text-primary; }
.catalog-heading p, .catalog-copy p { margin: 4px 0 0; color: $text-secondary; font-size: 12px; }
.catalog-controls { gap: 10px; margin-bottom: 14px; }
.catalog-controls > :first-child { flex: 1; }
.catalog-controls :deep(.n-select) { width: 180px; }
.view-switch { display: flex; gap: 4px; }
.result-count { min-width: 34px; text-align: right; color: $text-secondary; }
.catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 12px; }
.catalog-card { min-height: 136px; display: flex; gap: 12px; padding: 14px; border: 1px solid $border-color; border-radius: $radius-md; background: $bg-secondary; cursor: pointer; }
.catalog-card:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
.catalog-card img, .catalog-fallback { width: 38px; height: 38px; flex: 0 0 auto; border-radius: $radius-sm; object-fit: contain; background: $bg-primary; }
.catalog-fallback { display: grid; place-items: center; color: $accent-primary; font-weight: 700; }
.catalog-copy { min-width: 0; }
.catalog-title { gap: 8px; flex-wrap: wrap; }
.catalog-title span { padding: 1px 6px; border-radius: 999px; background: $bg-primary; color: $text-secondary; font-size: 11px; }
.catalog-description { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.custom-list { display: grid; gap: 8px; margin-bottom: 14px; }
.custom-row { justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid $border-color; border-radius: $radius-md; }
.custom-row span { display: block; margin-top: 3px; color: $text-secondary; font-size: 12px; }
.import-hint { color: $text-secondary; }
.connector-detail p { color: $text-secondary; }
.credential-field { display: grid; gap: 4px; margin-top: 10px; color: $text-secondary; font-size: 12px; }
.import-preview { display: grid; gap: 6px; margin-top: 12px; }
.import-preview > div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: $radius-sm; background: $bg-primary; }
.import-preview .ok { color: #0f7a3a; }
.import-preview .denied { color: #b42318; }
.modal-actions { justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) { .catalog-controls { align-items: stretch; flex-direction: column; } .catalog-controls :deep(.n-select) { width: 100%; } }
</style>
