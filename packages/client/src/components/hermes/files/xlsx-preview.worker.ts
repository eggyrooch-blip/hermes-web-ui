/// <reference lib="webworker" />
import readXlsxFile, { readSheetNames } from 'read-excel-file/web-worker'
import { limitTabularRows } from '@/utils/hermes/tabular-preview'
import { assertBoundedOoxmlArchive } from '@/utils/hermes/ooxml-archive'

type WorkerRequest = {
  type: 'open' | 'sheet'
  // Echoed back on every reply. Parsing a sheet takes long enough that a user
  // switching tabs twice can have two requests in flight; without this the
  // slower reply would land last and show a sheet nobody asked for.
  requestId: number
  data?: ArrayBuffer
  sheet?: string
}

let workbookBlob: Blob | null = null
let workbookSheetNames: string[] = []

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId } = event.data
  try {
    if (event.data.type === 'open') {
      if (!event.data.data) throw new Error('Workbook data is missing')
      assertBoundedOoxmlArchive(event.data.data)
      workbookBlob = new Blob([event.data.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      workbookSheetNames = await readSheetNames(workbookBlob)
      const visibleSheetNames = workbookSheetNames.slice(0, 50)
      if (!visibleSheetNames.length) throw new Error('Workbook does not contain worksheets')
      const rows = await readXlsxFile(workbookBlob, { sheet: visibleSheetNames[0] })
      self.postMessage({
        type: 'loaded',
        requestId,
        sheetNames: visibleSheetNames,
        activeSheet: visibleSheetNames[0],
        ...limitTabularRows(rows),
      })
      return
    }
    if (!workbookBlob || !event.data.sheet || !workbookSheetNames.includes(event.data.sheet)) {
      throw new Error('Workbook is not loaded')
    }
    const rows = await readXlsxFile(workbookBlob, { sheet: event.data.sheet })
    self.postMessage({ type: 'sheet', requestId, activeSheet: event.data.sheet, ...limitTabularRows(rows) })
  } catch (error) {
    self.postMessage({ type: 'error', requestId, error: error instanceof Error ? error.message : String(error) })
  }
}

export {}
