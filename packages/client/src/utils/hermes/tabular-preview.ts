// Bounds for the spreadsheet preview table. A generated workbook can be far
// larger than anything a reviewer reads in a side panel, and every cell here
// becomes a DOM node, so the worker clamps the sheet before it crosses back
// to the main thread and the UI says so instead of silently showing less.
export const MAX_TABLE_ROWS = 1_000
export const MAX_TABLE_COLUMNS = 100
export const MAX_TABLE_CELLS = 20_000
export const MAX_CELL_CHARACTERS = 10_000

export interface TabularPreviewResult {
  rows: string[][]
  truncated: boolean
}

export function limitTabularRows(input: unknown[][]): TabularPreviewResult {
  const rows: string[][] = []
  let cellCount = 0
  let truncated = input.length > MAX_TABLE_ROWS
  for (const inputRow of input.slice(0, MAX_TABLE_ROWS)) {
    if (cellCount >= MAX_TABLE_CELLS) {
      truncated = true
      break
    }
    if (inputRow.length > MAX_TABLE_COLUMNS) truncated = true
    const row = inputRow.slice(0, Math.min(MAX_TABLE_COLUMNS, MAX_TABLE_CELLS - cellCount)).map(value => {
      const text = value instanceof Date
        ? value.toISOString()
        : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
      if (text.length > MAX_CELL_CHARACTERS) {
        truncated = true
        return `${text.slice(0, MAX_CELL_CHARACTERS)}…`
      }
      return text
    })
    cellCount += row.length
    rows.push(row)
  }
  return { rows, truncated }
}
