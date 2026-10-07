<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NDataTable, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ data: ArrayBuffer }>()
const emit = defineEmits<{ (event: 'error', error: Error): void }>()
const { t } = useI18n()
const loading = ref(false)
const rows = ref<string[][]>([])
const truncated = ref(false)
const sheetNames = ref<string[]>([])
const activeSheet = ref('')
let worker: Worker | null = null
// Every request carries a sequence number the worker echoes back. Parsing a
// worksheet is slow enough that clicking Summary then Detail can leave two
// replies in flight, and without this the slower one wins and the table shows
// a sheet the user already moved off.
let requestSeq = 0
let pendingRequestId = 0

function columnLabel(index: number): string {
  let label = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label
  }
  return label
}

const columnCount = computed(() => rows.value.reduce((max, row) => Math.max(max, row.length), 0))
const columns = computed(() => [
  { title: '#', key: '__row', width: 64, fixed: 'left' as const },
  ...Array.from({ length: columnCount.value }, (_, index) => ({
    title: columnLabel(index),
    key: `c${index}`,
    width: 160,
    ellipsis: { tooltip: true },
  })),
])
const tableRows = computed(() => rows.value.map((row, rowIndex) => {
  const record: Record<string, string | number> = { __row: rowIndex + 1, __key: rowIndex }
  row.forEach((cell, index) => { record[`c${index}`] = cell })
  return record
}))

function terminateWorker(): void {
  worker?.terminate()
  worker = null
  pendingRequestId = 0
}

// Workbook parsing runs in a worker: read-excel-file inflates the whole sheet
// XML, which on a generated report is long enough to freeze the panel if it
// happens on the main thread. The worker also owns the ZIP bounds check, so a
// zip bomb never expands inside the UI thread.
function loadWorkbook(): void {
  terminateWorker()
  loading.value = true
  rows.value = []
  sheetNames.value = []
  activeSheet.value = ''
  truncated.value = false
  const activeWorker = new Worker(new URL('./xlsx-preview.worker.ts', import.meta.url), { type: 'module' })
  worker = activeWorker
  activeWorker.onmessage = event => {
    const payload = event.data || {}
    if (worker !== activeWorker || payload.requestId !== pendingRequestId) return
    if (payload.type === 'error') {
      loading.value = false
      emit('error', new Error(String(payload.error || 'Workbook parsing failed')))
      return
    }
    if (payload.sheetNames) sheetNames.value = payload.sheetNames
    activeSheet.value = String(payload.activeSheet || '')
    rows.value = Array.isArray(payload.rows) ? payload.rows : []
    truncated.value = payload.truncated === true
    loading.value = false
  }
  activeWorker.onerror = event => {
    if (worker !== activeWorker) return
    loading.value = false
    emit('error', new Error(event.message || 'Workbook worker failed'))
  }
  // Transfer a copy so the caller keeps its buffer usable for a re-render.
  const copy = props.data.slice(0)
  pendingRequestId = ++requestSeq
  activeWorker.postMessage({ type: 'open', requestId: pendingRequestId, data: copy }, [copy])
}

function selectSheet(sheet: string): void {
  if (!worker || loading.value || sheet === activeSheet.value) return
  loading.value = true
  pendingRequestId = ++requestSeq
  worker.postMessage({ type: 'sheet', requestId: pendingRequestId, sheet })
}

watch(() => props.data, loadWorkbook)
onMounted(loadWorkbook)
onBeforeUnmount(terminateWorker)
</script>

<template>
  <div class="spreadsheet-preview">
    <div v-if="sheetNames.length" class="sheet-tabs">
      <span class="sheet-tabs-label">{{ t('files.worksheet') }}:</span>
      <NButton
        v-for="sheet in sheetNames"
        :key="sheet"
        size="small"
        :disabled="loading"
        :type="sheet === activeSheet ? 'primary' : 'default'"
        @click="selectSheet(sheet)"
      >{{ sheet }}</NButton>
    </div>
    <NAlert v-if="truncated" type="warning" :show-icon="false">{{ t('files.tableTruncated') }}</NAlert>
    <NSpin :show="loading" class="table-stage">
      <NDataTable
        :columns="columns"
        :data="tableRows"
        :row-key="(row: any) => row.__key"
        :max-height="560"
        :scroll-x="Math.max(720, columns.length * 160)"
        virtual-scroll
        size="small"
        striped
      />
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.spreadsheet-preview { display: flex; flex-direction: column; width: 100%; min-height: 0; gap: 10px; }
.sheet-tabs { display: flex; gap: 6px; align-items: center; overflow-x: auto; padding-bottom: 2px; }
.sheet-tabs-label { flex: 0 0 auto; font-size: 12px; color: var(--n-text-color-3); }
.sheet-tabs :deep(.n-button) { border-radius: 999px; }
.table-stage { min-height: 360px; }
</style>
